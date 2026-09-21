import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import type {
  AuthorizationResponse,
  BlackoutResponse,
  CreateAuthorizationRequest,
  CreateBlackoutRequest,
  CreateReservationRequest,
  ReservationResponse,
  UpdateReservationRequest,
} from '@flightsquare/shared';

import { ownMembership } from '../../db/membership.js';
import { ConflictError, NotFoundError, PermissionError } from '../errors.js';
import type { Tx } from '../../db/context.js';

/**
 * Scheduling (§3.3), and what the handlers here deliberately do not do.
 *
 * They do not check for conflicts — an exclusion constraint does, because
 * two members hitting Book at the same moment is the normal case for a club
 * with one popular aircraft on a Saturday and a SELECT-then-INSERT loses that
 * race. They do not check whether the aircraft is grounded, or whether the
 * member is signed off in it: triggers do, so the rules hold for any path
 * that ever reaches those tables. And they do not check whose booking it is,
 * because the policies scope the writing (§4.4).
 *
 * What is left is turning each of those refusals into a sentence.
 *
 * **Not behind a feature flag.** §1: scheduling is *unused* in the solo case,
 * never *unavailable* — one pilot means an empty table, not a switch. A free
 * tenant has exactly one member and so nobody to coordinate with, which is
 * the same outcome without a code path that has to be maintained.
 */

const PG_EXCLUSION_VIOLATION = '23P01';
const PG_RULE_REFUSED = 'FS409';

const timestamp = { type: 'string', format: 'date-time' } as const;

const createSchema = {
  body: {
    type: 'object',
    required: ['aircraft_id', 'starts_at', 'ends_at'],
    additionalProperties: false,
    properties: {
      aircraft_id: { type: 'string', format: 'uuid' },
      starts_at: timestamp,
      ends_at: timestamp,
      purpose: { type: 'string', maxLength: 200 },
      notes: { type: 'string', maxLength: 2000 },
      booked_by: { type: 'string', format: 'uuid' },
    },
  },
} as const;

const updateSchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    minProperties: 1,
    properties: {
      starts_at: timestamp,
      ends_at: timestamp,
      purpose: { type: ['string', 'null'], maxLength: 200 },
      notes: { type: ['string', 'null'], maxLength: 2000 },
      needs_review: { type: 'boolean' },
    },
  },
} as const;

const blackoutSchema = {
  body: {
    type: 'object',
    required: ['aircraft_id', 'reason', 'starts_at', 'ends_at'],
    additionalProperties: false,
    properties: {
      aircraft_id: { type: 'string', format: 'uuid' },
      reason: { type: 'string', minLength: 1, maxLength: 200 },
      starts_at: timestamp,
      ends_at: timestamp,
    },
  },
} as const;

const authorizationSchema = {
  body: {
    type: 'object',
    required: ['membership_id'],
    additionalProperties: false,
    properties: {
      membership_id: { type: 'string', format: 'uuid' },
      note: { type: 'string', maxLength: 500 },
    },
  },
} as const;

/**
 * The calendar, flattened.
 *
 * One line per booking today, so the join reads like an aircraft column —
 * but it is a join, and that is what keeps a two-line lesson booking a
 * change of shape here rather than a change of schema.
 */
function selectReservations(trx: Tx) {
  return trx
    .selectFrom('reservations as r')
    .innerJoin('reservation_resources as rr', (join) =>
      join.onRef('rr.reservation_id', '=', 'r.id').on('rr.resource_type', '=', 'aircraft'),
    )
    .innerJoin('aircraft as a', 'a.id', 'rr.resource_id')
    .innerJoin('memberships as m', 'm.id', 'r.booked_by')
    .innerJoin('users as u', 'u.id', 'm.user_id')
    .select([
      'r.id',
      'rr.resource_id as aircraft_id',
      'a.registration as aircraft_registration',
      'r.booked_by',
      'u.name as booked_by_name',
      'u.email as booked_by_email',
      'r.starts_at',
      'r.ends_at',
      'r.purpose',
      'r.notes',
      'r.status',
      'r.needs_review',
      'r.review_reason',
    ]);
}

type ReservationRow = Awaited<ReturnType<ReturnType<typeof selectReservations>['execute']>>[number];

function toReservation(row: ReservationRow, viewer: Viewer): ReservationResponse {
  return {
    ...row,
    starts_at: row.starts_at.toISOString(),
    ends_at: row.ends_at.toISOString(),
    // The same question the policy asks, answered for the client so it can
    // hide what it would only be refused (§8.1).
    can_edit: viewer.administers || row.booked_by === viewer.membershipId,
  };
}

interface Viewer {
  membershipId: string;
  /** Holds `aircraft: write` — the signal the booking trigger uses too. */
  administers: boolean;
}

/**
 * Turn the database's refusals into sentences.
 *
 * Three of them, and none is a bug: the slot was taken, the aeroplane is
 * grounded, or the member is not signed off in it. All three are things a
 * person did, and all three have something they can do next.
 */
function rethrowSchedulingError(error: unknown): never {
  const code = (error as { code?: unknown }).code;

  if (code === PG_EXCLUSION_VIOLATION) {
    throw new ConflictError(
      'that aircraft is already booked for part of that time — pick another slot',
    );
  }

  if (code === PG_RULE_REFUSED) {
    // The trigger wrote the sentence; it knows which rule and why.
    const message = (error as { message?: unknown }).message;
    throw new ConflictError(typeof message === 'string' ? message : 'that booking is not allowed');
  }

  throw error;
}

export async function schedulingRoutes(app: FastifyInstance): Promise<void> {
  /** Who is asking, and how far their writes reach. */
  async function viewerFor(request: {
    withTenant: <T>(fn: (trx: Tx) => Promise<T>) => Promise<T>;
    loadGates: () => Promise<{ permissions: { has: (r: 'aircraft', l: 'write') => boolean } }>;
    ctx: { userId: string } | null;
  }): Promise<Viewer> {
    const gates = await request.loadGates();
    const membershipId = await request.withTenant((trx) => ownMembership(trx, request.ctx!.userId));
    return { membershipId, administers: gates.permissions.has('aircraft', 'write') };
  }

  // -------------------------------------------------------------------------
  // The calendar
  // -------------------------------------------------------------------------

  app.get<{ Querystring: { from?: string; to?: string; aircraft_id?: string; mine?: string } }>(
    '/reservations',
    { config: { requiresTenant: true, permission: ['reservations', 'read'] } },
    async (request) => {
      const viewer = await viewerFor(request);
      const { from, to, aircraft_id: aircraftId, mine } = request.query;

      const rows = await request.withTenant(async (trx) => {
        let query = selectReservations(trx).where('r.status', '!=', 'cancelled');

        // A window, because a calendar is always a window. Without one this
        // would happily return every booking a club has ever made.
        if (from) query = query.where('r.ends_at', '>', new Date(from));
        if (to) query = query.where('r.starts_at', '<', new Date(to));
        if (aircraftId) query = query.where('rr.resource_id', '=', aircraftId);
        if (mine === 'true') query = query.where('r.booked_by', '=', viewer.membershipId);

        return query.orderBy('r.starts_at').limit(500).execute();
      });

      return rows.map((row) => toReservation(row, viewer));
    },
  );

  app.post<{ Body: CreateReservationRequest }>(
    '/reservations',
    {
      schema: createSchema,
      config: { requiresTenant: true, permission: ['reservations', 'write'] },
    },
    async (request, reply) => {
      const body = request.body;
      const viewer = await viewerFor(request);

      if (new Date(body.ends_at) <= new Date(body.starts_at)) {
        throw new ConflictError('a booking has to end after it starts');
      }

      const created = await request
        .withTenant(async (trx) => {
          const aircraft = await trx
            .selectFrom('aircraft')
            .select('id')
            .where('id', '=', body.aircraft_id)
            .executeTakeFirst();
          if (!aircraft) throw new NotFoundError();

          const reservation = await trx
            .insertInto('reservations')
            .values({
              tenant_id: request.ctx!.tenantId!,
              // Their own by default. Naming somebody else is an admin
              // action, and the policy is what decides whether it lands.
              booked_by: body.booked_by ?? viewer.membershipId,
              starts_at: new Date(body.starts_at),
              ends_at: new Date(body.ends_at),
              purpose: body.purpose ?? null,
              notes: body.notes ?? null,
            })
            .returning('id')
            .executeTakeFirstOrThrow();

          /**
           * The line, and the only statement in this file that can fail for
           * an interesting reason. Inserting it is what asks the exclusion
           * constraint whether the aeroplane is free, and what fires the
           * triggers that ask whether it is airworthy and whether this
           * member may fly it.
           */
          await trx
            .insertInto('reservation_resources')
            .values({
              tenant_id: request.ctx!.tenantId!,
              reservation_id: reservation.id,
              resource_type: 'aircraft',
              resource_id: body.aircraft_id,
              during: sql<string>`tstzrange(${body.starts_at}::timestamptz, ${body.ends_at}::timestamptz, '[)')`,
            })
            .execute();

          return selectReservations(trx).where('r.id', '=', reservation.id).executeTakeFirstOrThrow();
        })
        .catch(rethrowSchedulingError);

      return reply.status(201).send(toReservation(created, viewer));
    },
  );

  app.patch<{ Params: { id: string }; Body: UpdateReservationRequest }>(
    '/reservations/:id',
    {
      schema: updateSchema,
      config: { requiresTenant: true, permission: ['reservations', 'write'] },
    },
    async (request) => {
      const body = request.body;
      const viewer = await viewerFor(request);

      const updated = await request
        .withTenant(async (trx) => {
          const existing = await trx
            .selectFrom('reservations')
            .select(['id', 'booked_by', 'status'])
            .where('id', '=', request.params.id)
            .executeTakeFirst();
          if (!existing) throw new NotFoundError();
          if (existing.status === 'cancelled') {
            throw new ConflictError('that booking was cancelled — make a new one');
          }

          const result = await trx
            .updateTable('reservations')
            .set({
              ...(body.starts_at !== undefined ? { starts_at: new Date(body.starts_at) } : {}),
              ...(body.ends_at !== undefined ? { ends_at: new Date(body.ends_at) } : {}),
              ...(body.purpose !== undefined ? { purpose: body.purpose } : {}),
              ...(body.notes !== undefined ? { notes: body.notes } : {}),
              // Clearing the flag is an admin saying they have made the call
              // and spoken to whoever needed speaking to.
              ...(body.needs_review !== undefined
                ? { needs_review: body.needs_review, review_reason: null }
                : {}),
            })
            .where('id', '=', request.params.id)
            .executeTakeFirst();

          /**
           * The row was readable and did not update, which the policy did:
           * it is somebody else's booking. Saying so is better than a 404
           * about a booking they are looking straight at — §6's silence is
           * about *other tenants*, and this person is in the right one.
           */
          if (result.numUpdatedRows === 0n) {
            throw new PermissionError('reservations', 'write');
          }

          return selectReservations(trx).where('r.id', '=', request.params.id).executeTakeFirstOrThrow();
        })
        .catch(rethrowSchedulingError);

      return toReservation(updated, viewer);
    },
  );

  /**
   * Cancelling, which is a status and not a delete (§10).
   *
   * The line stops blocking in the same transaction — a trigger does it —
   * so the slot is free the moment this returns, while the booking itself
   * stays on the record for the club that is arguing about a Saturday.
   */
  app.post<{ Params: { id: string } }>(
    '/reservations/:id/cancel',
    { config: { requiresTenant: true, permission: ['reservations', 'write'] } },
    async (request) => {
      const viewer = await viewerFor(request);

      return request.withTenant(async (trx) => {
        const existing = await trx
          .selectFrom('reservations')
          .select(['id', 'status'])
          .where('id', '=', request.params.id)
          .executeTakeFirst();
        if (!existing) throw new NotFoundError();
        if (existing.status === 'cancelled') {
          return selectReservations(trx)
            .where('r.id', '=', request.params.id)
            .executeTakeFirstOrThrow()
            .then((row) => toReservation(row, viewer));
        }

        const result = await trx
          .updateTable('reservations')
          .set({
            status: 'cancelled',
            cancelled_at: new Date(),
            cancelled_by: viewer.membershipId,
          })
          .where('id', '=', request.params.id)
          .executeTakeFirst();

        if (result.numUpdatedRows === 0n) throw new PermissionError('reservations', 'write');

        return selectReservations(trx)
          .where('r.id', '=', request.params.id)
          .executeTakeFirstOrThrow()
          .then((row) => toReservation(row, viewer));
      });
    },
  );

  // -------------------------------------------------------------------------
  // Blackouts — the same hours, held by nobody
  // -------------------------------------------------------------------------

  app.get<{ Querystring: { from?: string; to?: string; aircraft_id?: string } }>(
    '/blackouts',
    { config: { requiresTenant: true, permission: ['reservations', 'read'] } },
    async (request) => {
      const rows = await request.withTenant(async (trx) => {
        let query = trx
          .selectFrom('blackouts as b')
          .innerJoin('aircraft as a', 'a.id', 'b.aircraft_id')
          .select([
            'b.id',
            'b.aircraft_id',
            'a.registration as aircraft_registration',
            'b.reason',
            'b.starts_at',
            'b.ends_at',
          ]);
        if (request.query.from) query = query.where('b.ends_at', '>', new Date(request.query.from));
        if (request.query.to) query = query.where('b.starts_at', '<', new Date(request.query.to));
        if (request.query.aircraft_id) {
          query = query.where('b.aircraft_id', '=', request.query.aircraft_id);
        }
        return query.orderBy('b.starts_at').execute();
      });

      return rows.map(
        (row): BlackoutResponse => ({
          ...row,
          starts_at: row.starts_at.toISOString(),
          ends_at: row.ends_at.toISOString(),
        }),
      );
    },
  );

  /** Taking the aeroplane away is an admin's call, so it takes the fleet. */
  app.post<{ Body: CreateBlackoutRequest }>(
    '/blackouts',
    {
      schema: blackoutSchema,
      config: { requiresTenant: true, permission: ['aircraft', 'write'] },
    },
    async (request, reply) => {
      const body = request.body;
      if (new Date(body.ends_at) <= new Date(body.starts_at)) {
        throw new ConflictError('a blackout has to end after it starts');
      }

      const created = await request
        .withTenant(async (trx) => {
          const blackout = await trx
            .insertInto('blackouts')
            .values({
              tenant_id: request.ctx!.tenantId!,
              aircraft_id: body.aircraft_id,
              reason: body.reason,
              starts_at: new Date(body.starts_at),
              ends_at: new Date(body.ends_at),
              created_by: await ownMembership(trx, request.ctx!.userId),
            })
            .returning('id')
            .executeTakeFirstOrThrow();

          // Same space as a booking's lines, so the same constraint decides
          // it: an annual cannot be scheduled over somebody's Saturday any
          // more than the reverse.
          await trx
            .insertInto('reservation_resources')
            .values({
              tenant_id: request.ctx!.tenantId!,
              blackout_id: blackout.id,
              resource_type: 'aircraft',
              resource_id: body.aircraft_id,
              during: sql<string>`tstzrange(${body.starts_at}::timestamptz, ${body.ends_at}::timestamptz, '[)')`,
            })
            .execute();

          return trx
            .selectFrom('blackouts as b')
            .innerJoin('aircraft as a', 'a.id', 'b.aircraft_id')
            .select([
              'b.id',
              'b.aircraft_id',
              'a.registration as aircraft_registration',
              'b.reason',
              'b.starts_at',
              'b.ends_at',
            ])
            .where('b.id', '=', blackout.id)
            .executeTakeFirstOrThrow();
        })
        .catch((error: unknown) => {
          if ((error as { code?: unknown }).code === PG_EXCLUSION_VIOLATION) {
            throw new ConflictError(
              'somebody has the aircraft booked in that window — cancel the booking first, ' +
                'and tell them why',
            );
          }
          throw error;
        });

      return reply.status(201).send({
        ...created,
        starts_at: created.starts_at.toISOString(),
        ends_at: created.ends_at.toISOString(),
      } satisfies BlackoutResponse);
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/blackouts/:id',
    { config: { requiresTenant: true, permission: ['aircraft', 'write'] } },
    async (request) => {
      // A blackout is the one schedule row that really is deleted rather
      // than cancelled: nobody was flying, nobody was told, and there is no
      // history in "the annual was pencilled in and then moved".
      const result = await request.withTenant((trx) =>
        trx.deleteFrom('blackouts').where('id', '=', request.params.id).executeTakeFirst(),
      );
      if (result.numDeletedRows === 0n) throw new NotFoundError();
      return { status: 'removed' };
    },
  );

  // -------------------------------------------------------------------------
  // §3.5: who is signed off in what
  // -------------------------------------------------------------------------

  app.get<{ Params: { id: string } }>(
    '/aircraft/:id/authorizations',
    { config: { requiresTenant: true, permission: ['qualifications', 'read'] } },
    async (request) => {
      const rows = await request.withTenant((trx) =>
        trx
          .selectFrom('member_aircraft_authorizations as z')
          .innerJoin('memberships as m', 'm.id', 'z.membership_id')
          .innerJoin('users as u', 'u.id', 'm.user_id')
          .leftJoin('memberships as bm', 'bm.id', 'z.authorized_by')
          .leftJoin('users as bu', 'bu.id', 'bm.user_id')
          .select([
            'z.membership_id',
            'z.aircraft_id',
            'u.email',
            'u.name',
            'z.authorized_on',
            'bu.email as authorized_by_email',
            'z.note',
          ])
          .where('z.aircraft_id', '=', request.params.id)
          .orderBy('u.email')
          .execute(),
      );
      return rows satisfies AuthorizationResponse[];
    },
  );

  app.post<{ Params: { id: string }; Body: CreateAuthorizationRequest }>(
    '/aircraft/:id/authorizations',
    {
      schema: authorizationSchema,
      config: { requiresTenant: true, permission: ['qualifications', 'write'] },
    },
    async (request, reply) => {
      await request.withTenant(async (trx) => {
        const aircraft = await trx
          .selectFrom('aircraft')
          .select('id')
          .where('id', '=', request.params.id)
          .executeTakeFirst();
        if (!aircraft) throw new NotFoundError();

        await trx
          .insertInto('member_aircraft_authorizations')
          .values({
            tenant_id: request.ctx!.tenantId!,
            membership_id: request.body.membership_id,
            aircraft_id: request.params.id,
            authorized_by: await ownMembership(trx, request.ctx!.userId),
            note: request.body.note ?? null,
          })
          // Signing somebody off twice is not an error; it is a click.
          .onConflict((oc) => oc.doNothing())
          .execute();
      });

      return reply.status(201).send({ status: 'authorized' });
    },
  );

  app.delete<{ Params: { id: string; membershipId: string } }>(
    '/aircraft/:id/authorizations/:membershipId',
    { config: { requiresTenant: true, permission: ['qualifications', 'write'] } },
    async (request) => {
      const result = await request.withTenant((trx) =>
        trx
          .deleteFrom('member_aircraft_authorizations')
          .where('aircraft_id', '=', request.params.id)
          .where('membership_id', '=', request.params.membershipId)
          .executeTakeFirst(),
      );
      if (result.numDeletedRows === 0n) throw new NotFoundError();
      // Existing bookings stand. Withdrawing a checkout is a decision about
      // the future, and cancelling somebody's Saturday silently is exactly
      // what §3.3 refuses to do anywhere else.
      return { status: 'withdrawn' };
    },
  );
}
