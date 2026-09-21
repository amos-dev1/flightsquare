import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';

import { findUserByEmail, resolveInviteToken } from '../../db/auth.js';
import { withSession, withTenant, type Tx } from '../../db/context.js';
import { assertQuota } from '../../db/entitlements.js';
import { limitForDatabase } from '../../entitlements/values.js';
import { inviteEmail } from '../../email.js';
import { hashPassword } from '../../password.js';
import { generateToken, hashToken } from '../../tokens.js';
import { ConflictError, InvalidRequestError, isUniqueViolation, NotFoundError } from '../errors.js';

/**
 * The club's roster: who is in it, what they may do, and how somebody new
 * gets here.
 *
 * §4.4's rule — a tenant always keeps one member who can manage members — is
 * enforced by a trigger, not by these handlers. They check too, so the answer
 * is a sentence rather than a constraint violation, but the trigger is what
 * makes it true: it has to survive a code path nobody has written yet, the
 * same argument §7.4 makes for legal_hold.
 */

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const inviteSchema = {
  body: {
    type: 'object',
    required: ['email'],
    additionalProperties: false,
    properties: {
      email: { type: 'string', minLength: 3, maxLength: 320, pattern: '^[^@\\s]+@[^@\\s]+$' },
      name: { type: 'string', maxLength: 200 },
      /** Which role they arrive with. Defaults to Pilot — the safe one. */
      role: { type: 'string', enum: ['admin', 'pilot'] },
    },
  },
} as const;

const memberSchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    minProperties: 1,
    properties: {
      role: { type: 'string', enum: ['admin', 'pilot'] },
      // §10: an application-facing "delete" is a status, and the flights,
      // charges and squawks stay attached to the membership either way.
      status: { type: 'string', enum: ['active', 'suspended', 'removed'] },
    },
  },
} as const;

const acceptSchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    properties: {
      /** Only for somebody who has never used FlightSquare. */
      password: { type: 'string', minLength: 12, maxLength: 1024 },
      name: { type: 'string', maxLength: 200 },
    },
  },
} as const;

/** The roster, as a club would read it. */
function selectMembers(trx: Tx) {
  return trx
    .selectFrom('memberships as m')
    .innerJoin('users as u', 'u.id', 'm.user_id')
    .innerJoin('role_bundles as b', 'b.id', 'm.role_bundle_id')
    .select([
      'm.id',
      'm.status',
      'm.joined_at',
      'm.invited_at',
      'u.id as user_id',
      'u.email',
      'u.name',
      'b.code as role',
      'b.name as role_name',
    ]);
}

async function bundleIdFor(trx: Tx, code: string): Promise<string> {
  const row = await trx
    .selectFrom('role_bundles')
    .select('id')
    .where('code', '=', code)
    .executeTakeFirst();
  if (!row) throw new NotFoundError();
  return row.id;
}

export async function memberRoutes(app: FastifyInstance): Promise<void> {
  // -------------------------------------------------------------------------
  // The roster
  // -------------------------------------------------------------------------

  app.get(
    '/members',
    { config: { requiresTenant: true, permission: ['members', 'read'] } },
    async (request) => {
      const rows = await request.withTenant((trx) =>
        selectMembers(trx).orderBy('u.email').execute(),
      );
      return rows.map((row) => ({
        id: row.id,
        user_id: row.user_id,
        email: row.email,
        name: row.name,
        role: row.role,
        role_name: row.role_name,
        status: row.status,
        joined_at: row.joined_at?.toISOString() ?? null,
        invited_at: row.invited_at?.toISOString() ?? null,
      }));
    },
  );

  app.patch<{ Params: { id: string }; Body: { role?: string; status?: string } }>(
    '/members/:id',
    {
      schema: memberSchema,
      config: { requiresTenant: true, permission: ['members', 'write'] },
    },
    async (request) => {
      const { role, status } = request.body;

      try {
        return await request.withTenant(async (trx) => {
          const result = await trx
            .updateTable('memberships')
            .set({
              ...(status !== undefined ? { status: status as 'active' } : {}),
              ...(role !== undefined ? { role_bundle_id: await bundleIdFor(trx, role) } : {}),
            })
            .where('id', '=', request.params.id)
            .executeTakeFirst();
          if (result.numUpdatedRows === 0n) throw new NotFoundError();

          const row = await selectMembers(trx)
            .where('m.id', '=', request.params.id)
            .executeTakeFirstOrThrow();
          return {
            id: row.id,
            user_id: row.user_id,
            email: row.email,
            name: row.name,
            role: row.role,
            role_name: row.role_name,
            status: row.status,
            joined_at: row.joined_at?.toISOString() ?? null,
            invited_at: row.invited_at?.toISOString() ?? null,
          };
        });
      } catch (error) {
        // §4.4, raised by the trigger that actually enforces it.
        if ((error as { code?: unknown }).code === 'FS409') {
          throw new ConflictError(
            'a club has to keep one member who can manage members — promote somebody else first',
          );
        }
        throw error;
      }
    },
  );

  // -------------------------------------------------------------------------
  // Invitations
  // -------------------------------------------------------------------------

  app.get(
    '/invites',
    { config: { requiresTenant: true, permission: ['members', 'read'] } },
    async (request) => {
      const rows = await request.withTenant((trx) =>
        trx
          .selectFrom('invites as i')
          .leftJoin('role_bundles as b', 'b.id', 'i.role_bundle_id')
          .select(['i.id', 'i.email', 'i.name', 'i.expires_at', 'i.created_at', 'b.code as role'])
          .where('i.accepted_at', 'is', null)
          .where('i.revoked_at', 'is', null)
          .orderBy('i.created_at', 'desc')
          .execute(),
      );
      return rows.map((row) => ({
        id: row.id,
        email: row.email,
        name: row.name,
        role: row.role,
        expires_at: row.expires_at.toISOString(),
        created_at: row.created_at.toISOString(),
        expired: row.expires_at.getTime() < Date.now(),
      }));
    },
  );

  app.post<{ Body: { email: string; name?: string; role?: string } }>(
    '/invites',
    {
      schema: inviteSchema,
      config: { requiresTenant: true, permission: ['members', 'write'] },
    },
    async (request, reply) => {
      const { entitlements } = await request.loadGates();
      const body = request.body;
      const token = generateToken();

      const created = await request.withTenant(async (trx) => {
        /**
         * §4.5's gate, counting what is promised as well as what exists.
         *
         * `members.active` counts memberships, and an invite is not one yet —
         * so five invites on a limit of five would all pass and the sixth
         * member would arrive through a door that had already been checked.
         * Subtracting the outstanding invites from the limit asks the
         * question that matters: how many more people can this club end up
         * with. The lock and the count stay in the database either way.
         */
        const pending = await trx
          .selectFrom('invites')
          .select(({ fn }) => fn.countAll<string>().as('count'))
          .where('accepted_at', 'is', null)
          .where('revoked_at', 'is', null)
          .where('expires_at', '>', new Date())
          .executeTakeFirstOrThrow();

        const limit = limitForDatabase(entitlements.quota('members.active'));
        if (limit !== null) {
          const room = limit - Number(pending.count);
          await assertQuota(trx, 'members.active', { kind: 'limit', value: Math.max(room, 0) });
        }

        const existing = await trx
          .selectFrom('invites')
          .select('id')
          .where(sql<boolean>`lower(email) = lower(${body.email})`)
          .where('accepted_at', 'is', null)
          .where('revoked_at', 'is', null)
          .where('expires_at', '>', new Date())
          .executeTakeFirst();
        if (existing) throw new ConflictError('that address already has an invitation pending');

        const already = await selectMembers(trx)
          .where(sql<boolean>`lower(u.email) = lower(${body.email})`)
          .executeTakeFirst();
        if (already) throw new ConflictError('that address is already a member of this club');

        return trx
          .insertInto('invites')
          .values({
            tenant_id: request.ctx!.tenantId!,
            email: body.email,
            name: body.name ?? null,
            token_hash: hashToken(token),
            role_bundle_id: await bundleIdFor(trx, body.role ?? 'pilot'),
            invited_by: request.ctx!.userId,
            expires_at: new Date(Date.now() + INVITE_TTL_MS),
          })
          .returning(['id', 'email', 'expires_at'])
          .executeTakeFirstOrThrow();
      });

      // The invite email is enqueued by the application rather than by a
      // definer function: unlike a reset, there is nothing to hide here. The
      // admin typed the address and is about to see it on the roster.
      const [tenant, inviter] = await request.withTenant(async (trx) =>
        Promise.all([
          trx.selectFrom('tenants').select('name').executeTakeFirstOrThrow(),
          trx
            .selectFrom('users')
            .select(['name', 'email'])
            .where('id', '=', request.ctx!.userId)
            .executeTakeFirst(),
        ]),
      );

      await withTenant({ tenantId: request.ctx!.tenantId!, userId: request.ctx!.userId }, (trx) =>
        trx
          .insertInto('outbox')
          .values({
            to_email: created.email,
            kind: 'invite',
            ...inviteEmail({
              token,
              tenantName: tenant.name,
              invitedBy: inviter?.name ?? inviter?.email ?? null,
            }),
          })
          .execute(),
      );

      return reply.status(201).send({
        id: created.id,
        email: created.email,
        expires_at: created.expires_at.toISOString(),
      });
    },
  );

  app.post<{ Params: { id: string } }>(
    '/invites/:id/revoke',
    { config: { requiresTenant: true, permission: ['members', 'write'] } },
    async (request) => {
      const result = await request.withTenant((trx) =>
        trx
          .updateTable('invites')
          .set({ revoked_at: new Date() })
          .where('id', '=', request.params.id)
          .where('accepted_at', 'is', null)
          .executeTakeFirst(),
      );
      if (result.numUpdatedRows === 0n) throw new NotFoundError();
      return { status: 'revoked' };
    },
  );

  // -------------------------------------------------------------------------
  // Accepting — the one path that starts outside every tenant
  // -------------------------------------------------------------------------

  /**
   * What the accept page shows before anybody commits to anything: which
   * club, and whether the address already has an account.
   *
   * Public by necessity — the person holding the link may have no account at
   * all. The token is the only thing that resolves it, and it resolves to
   * nothing once used, revoked or expired.
   */
  app.get<{ Params: { token: string } }>('/invites/token/:token', async (request) => {
    const invite = await resolveInviteToken(hashToken(request.params.token));
    if (!invite) throw new NotFoundError();

    // Whether an account exists for the invited address — the invite itself
    // is proof the inviter knew that address, so this tells the holder
    // nothing they did not bring with them, and it decides whether the page
    // asks for a password or for a sign-in.
    //
    // Through the §2.1 door, because there is no context in which an ordinary
    // read could see it: the address is not a member of anything yet, and the
    // `users` policy shows you yourself or the people you fly with.
    const existing = await findUserByEmail(invite.email);

    return {
      email: invite.email,
      tenant_name: invite.tenant_name,
      expires_at: invite.expires_at.toISOString(),
      has_account: Boolean(existing),
    };
  });

  /**
   * Spending it.
   *
   * Two shapes, and the difference is whether the person already exists:
   * somebody with an account signs in first and arrives here with a session;
   * somebody new sends a password and is created on the spot.
   *
   * Neither needs a new §2.1 door. `auth.resolve_invite_token` hands back the
   * tenant and its own comment says consuming the invite happens under that
   * context — and the `invited_signup` policy is what allows the user row,
   * decided by the database against a live invitation rather than promised
   * here.
   */
  app.post<{ Params: { token: string }; Body: { password?: string; name?: string } }>(
    '/invites/token/:token/accept',
    { schema: acceptSchema },
    async (request, reply) => {
      const invite = await resolveInviteToken(hashToken(request.params.token));
      if (!invite) throw new NotFoundError();

      const sessionUserId = request.ctx?.userId;
      const body = request.body ?? {};

      // Same reason as above: not a member yet, so not visible to any
      // ordinary read. The door is the only way to know.
      const existing = await findUserByEmail(invite.email);

      const membershipId = await withSession({ tenantId: invite.tenant_id }, async (trx) => {
        let userId: string;
        if (existing) {
          // The account is somebody's. Only they may join with it, and only
          // while signed in as themselves — otherwise a forwarded link is a
          // way into a club as a stranger.
          if (!sessionUserId || sessionUserId !== existing.user_id) {
            throw new ConflictError(
              `sign in as ${invite.email} first, then open the invitation again`,
            );
          }
          userId = existing.user_id;
        } else {
          if (!body.password) {
            throw new InvalidRequestError('choose a password to finish joining');
          }

          /**
           * The id is generated here rather than returned.
           *
           * `invited_signup` permits the INSERT, but RETURNING also needs the
           * row to pass a SELECT policy — and it cannot: this person is not
           * a member until the next statement, and `users` shows you either
           * yourself or the people you fly with. Naming the row before
           * writing it is what §6 chose UUIDv7 for, and §8.2 already has the
           * phone doing the same thing.
           */
          const minted = await sql<{ id: string }>`SELECT uuidv7() AS id`.execute(trx);
          userId = minted.rows[0]!.id;

          await trx
            .insertInto('users')
            .values({
              id: userId,
              email: invite.email,
              name: body.name ?? null,
              password_hash: await hashPassword(body.password),
            })
            .execute();
        }

        const inviteRow = await trx
          .selectFrom('invites')
          .select('role_bundle_id')
          .where('id', '=', invite.invite_id)
          .executeTakeFirstOrThrow();

        const membership = await trx
          .insertInto('memberships')
          .values({
            tenant_id: invite.tenant_id,
            user_id: userId,
            status: 'active',
            joined_at: new Date(),
            role_bundle_id: inviteRow.role_bundle_id ?? (await bundleIdFor(trx, 'pilot')),
          })
          .returning('id')
          .executeTakeFirstOrThrow();

        // Marked accepted in the same transaction as the membership it
        // created, so a link cannot be spent twice by two tabs.
        await trx
          .updateTable('invites')
          .set({ accepted_at: new Date(), accepted_by: userId })
          .where('id', '=', invite.invite_id)
          .where('accepted_at', 'is', null)
          .execute();

        return membership.id;
      }).catch((error: unknown) => {
        if (isUniqueViolation(error)) {
          throw new ConflictError('that invitation has already been accepted');
        }
        throw error;
      });

      return reply.status(201).send({
        membership_id: membershipId,
        tenant_id: invite.tenant_id,
        tenant_name: invite.tenant_name,
        email: invite.email,
      });
    },
  );
}
