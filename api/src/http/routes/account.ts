import type { FastifyInstance } from 'fastify';

import { consumeAuthToken, requestEmailToken } from '../../db/auth.js';
import { withUser } from '../../db/context.js';
import { hashPassword } from '../../password.js';
import { generateToken, hashToken } from '../../tokens.js';
import { passwordResetEmail, verificationEmail } from '../../email.js';
import { NotFoundError } from '../errors.js';
import type { RateLimitRule } from '../server.js';

/**
 * The account a person owns, rather than the club they fly with.
 *
 * Everything here is global (§3.1): one human, one login, many memberships.
 * None of it takes a tenant, and two of the four take no session at all —
 * somebody who cannot get in is exactly who a password reset is for.
 *
 * **Both unauthenticated endpoints answer identically whatever the address.**
 * `auth.request_email_token` decides inside the database whether a token and
 * a message exist and hands nothing back, so there is no branch here to read
 * and no way to use this as a test for whether an account exists.
 */

const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;

const emailSchema = {
  body: {
    type: 'object',
    required: ['email'],
    additionalProperties: false,
    properties: {
      email: { type: 'string', minLength: 3, maxLength: 320, pattern: '^[^@\\s]+@[^@\\s]+$' },
    },
  },
} as const;

const consumeSchema = {
  body: {
    type: 'object',
    required: ['token'],
    additionalProperties: false,
    properties: { token: { type: 'string', minLength: 16, maxLength: 200 } },
  },
} as const;

const resetSchema = {
  body: {
    type: 'object',
    required: ['token', 'password'],
    additionalProperties: false,
    properties: {
      token: { type: 'string', minLength: 16, maxLength: 200 },
      password: { type: 'string', minLength: 12, maxLength: 1024 },
    },
  },
} as const;

const profileSchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    minProperties: 1,
    properties: {
      name: { type: ['string', 'null'], maxLength: 200 },
      phone: { type: ['string', 'null'], maxLength: 40 },
    },
  },
} as const;

export interface AccountRouteOptions {
  limits?: Partial<Record<'signup' | 'login' | 'refresh', RateLimitRule>>;
}

/** Issue a verification link. Called from signup too, so it lives here. */
export async function sendVerificationEmail(email: string): Promise<void> {
  const token = generateToken();
  await requestEmailToken({
    email,
    kind: 'email_verification',
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + VERIFICATION_TTL_MS),
    ...verificationEmail(token),
  });
}

export async function accountRoutes(
  app: FastifyInstance,
  options: AccountRouteOptions = {},
): Promise<void> {
  // Same shape of limit as login: unauthenticated, cheap to call, and it
  // sends mail to an address the caller chose. 429 is requests per unit
  // time and is never a plan quota (§1.6).
  const limit = options.limits?.login ?? { max: 10, timeWindow: '5 minutes' };

  app.post<{ Body: { email: string } }>(
    '/verify-email/request',
    { schema: emailSchema, config: { rateLimit: limit } },
    async (request, reply) => {
      await sendVerificationEmail(request.body.email);
      // 202: we have accepted the request. Whether anything was sent is
      // deliberately not in the answer.
      return reply.status(202).send({ status: 'accepted' });
    },
  );

  app.post<{ Body: { token: string } }>(
    '/verify-email',
    { schema: consumeSchema },
    async (request, reply) => {
      const userId = await consumeAuthToken('email_verification', hashToken(request.body.token));
      if (!userId) throw new NotFoundError();

      // The token is the authentication: it was emailed to that address and
      // spent once. That is enough to act as the user it belonged to, which
      // is the same reasoning login uses after checking a password.
      await withUser(userId, async (trx) => {
        await trx
          .updateTable('users')
          .set({ email_verified_at: new Date() })
          .where('id', '=', userId)
          .execute();
      });

      return reply.status(200).send({ status: 'verified' });
    },
  );

  app.post<{ Body: { email: string } }>(
    '/password-reset/request',
    { schema: emailSchema, config: { rateLimit: limit } },
    async (request, reply) => {
      const token = generateToken();
      await requestEmailToken({
        email: request.body.email,
        kind: 'password_reset',
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + RESET_TTL_MS),
        ...passwordResetEmail(token),
      });
      return reply.status(202).send({ status: 'accepted' });
    },
  );

  app.post<{ Body: { token: string; password: string } }>(
    '/password-reset',
    { schema: resetSchema, config: { rateLimit: limit } },
    async (request, reply) => {
      const userId = await consumeAuthToken('password_reset', hashToken(request.body.token));
      // Unknown, spent, expired or the wrong kind — all the same answer, and
      // none of them say which.
      if (!userId) throw new NotFoundError();

      const passwordHash = await hashPassword(request.body.password);
      await withUser(userId, async (trx) => {
        await trx
          .updateTable('users')
          .set({ password_hash: passwordHash })
          .where('id', '=', userId)
          .execute();

        // Every session this account had is now somebody else's problem:
        // whoever knew the old password, including whoever prompted the
        // reset. Revoking them is the point of resetting.
        await trx
          .updateTable('sessions')
          .set({ revoked_at: new Date() })
          .where('user_id', '=', userId)
          .where('revoked_at', 'is', null)
          .execute();
      });

      return reply.status(200).send({ status: 'reset' });
    },
  );

  app.patch<{ Body: { name?: string | null; phone?: string | null } }>(
    '/me',
    { schema: profileSchema, config: { requiresSession: true } },
    async (request) => {
      const userId = request.ctx!.userId;
      return withUser(userId, async (trx) => {
        await trx
          .updateTable('users')
          .set(request.body)
          .where('id', '=', userId)
          .execute();

        const row = await trx
          .selectFrom('users')
          .select(['id', 'email', 'name', 'phone', 'mfa_enabled', 'email_verified_at'])
          .where('id', '=', userId)
          .executeTakeFirstOrThrow();

        return {
          id: row.id,
          email: row.email,
          name: row.name,
          phone: row.phone,
          mfa_enabled: row.mfa_enabled,
          email_verified: row.email_verified_at !== null,
        };
      });
    },
  );
}
