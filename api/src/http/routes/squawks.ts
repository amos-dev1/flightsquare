import type { FastifyInstance } from 'fastify';
import type {
  CreateSquawkDeferralRequest,
  CreateSquawkRequest,
  SquawkDeferralResponse,
  SquawkResponse,
  UpdateSquawkRequest,
} from '@flightsquare/shared';

import { withIdempotency } from '../../db/idempotency.js';
import { ownMembership } from '../../db/membership.js';
import { NotFoundError } from '../errors.js';
import type { Tx } from '../../db/context.js';

/**
 * Squawks — a reported defect (§3.6), and the permission line that §1.5 says
 * is easy to lose and expensive to recover.
 *
 * `squawks` is a separate resource from `maintenance` because **a pilot
 * reports a defect but does not sign off work, close an item, or record
 * compliance**. The default Pilot bundle is `squawks: write` with
 * `maintenance: read`, and that combination has to mean something: filing is
 * one permission, and resolving or deferring is another, checked inside the
 * handler rather than at the route. Collapsing the two would make the
 * central permission line in the product inexpressible.
 *
 * Not behind `maintenance_module`. Reporting a defect on an aircraft you are
 * about to fly is not a paid feature, and a tenant whose module was switched
 * off would still need the next pilot to know about the soft brake.
 */

const idSchema = { type: 'string', format: 'uuid' } as const;
const severity = {
  type: 'string',
  enum: ['advisory', 'minor', 'major', 'grounding'],
} as const;

const createSchema = {
  body: {
    type: 'object',
    required: ['aircraft_id', 'summary'],
    additionalProperties: false,
    properties: {
      aircraft_id: idSchema,
      summary: { type: 'string', minLength: 1, maxLength: 200 },
      details: { type: 'string', maxLength: 4000 },
      severity,
      grounding: { type: 'boolean' },
      found_on_flight_id: idSchema,
      reported_at: { type: 'string', format: 'date-time' },
    },
  },
} as const;

const updateSchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    minProperties: 1,
    properties: {
      // `summary` is absent on purpose, and so is the grant behind it: the
      // defect someone wrote down is the record. A correction is a new
      // squawk, not a rewrite of the one an investigator reads.
      details: { type: 'string', maxLength: 4000 },
      severity,
      grounding: { type: 'boolean' },
      status: { type: 'string', enum: ['open', 'deferred', 'resolved'] },
      resolution_note: { type: 'string', maxLength: 2000 },
      work_order_id: idSchema,
    },
  },
} as const;

const deferralSchema = {
  body: {
    type: 'object',
    required: ['basis'],
    additionalProperties: false,
    properties: {
      basis: { type: 'string', enum: ['mel', 'cdl', 'far_91_213', 'other'] },
      reference: { type: 'string', maxLength: 100 },
      expires_on: { type: 'string', format: 'date' },
      note: { type: 'string', maxLength: 2000 },
    },
  },
} as const;

function selectSquawks(trx: Tx) {
  return trx
    .selectFrom('squawks as s')
    .innerJoin('aircraft as a', 'a.id', 's.aircraft_id')
    .leftJoin('memberships as m', 'm.id', 's.reported_by')
    .leftJoin('users as u', 'u.id', 'm.user_id')
    .select([
      's.id',
      's.aircraft_id',
      'a.registration as aircraft_registration',
      's.summary',
      's.details',
      's.severity',
      's.grounding',
      's.status',
      's.reported_by',
      'u.email as reported_by_email',
      's.reported_at',
      's.found_on_flight_id',
      's.resolved_at',
      's.resolution_note',
      's.work_order_id',
    ]);
}

type SquawkRow = Awaited<ReturnType<ReturnType<typeof selectSquawks>['execute']>>[number];

async function withDeferrals(trx: Tx, rows: SquawkRow[]): Promise<SquawkResponse[]> {
  if (rows.length === 0) return [];

  const deferrals = await trx
    .selectFrom('squawk_deferrals')
    .select(['id', 'squawk_id', 'basis', 'reference', 'expires_on', 'note', 'deferred_at'])
    .where(
      'squawk_id',
      'in',
      rows.map((r) => r.id),
    )
    .orderBy('deferred_at', 'desc')
    .execute();

  const bySquawk = new Map<string, SquawkDeferralResponse[]>();
  for (const d of deferrals) {
    const list = bySquawk.get(d.squawk_id) ?? [];
    list.push({
      id: d.id,
      basis: d.basis,
      reference: d.reference,
      expires_on: d.expires_on,
      note: d.note,
      deferred_at: d.deferred_at.toISOString(),
    });
    bySquawk.set(d.squawk_id, list);
  }

  return rows.map((row) => ({
    ...row,
    reported_at: row.reported_at.toISOString(),
    resolved_at: row.resolved_at?.toISOString() ?? null,
    // The whole history, not just the current one. §7.2 names deferral
    // history among what gets read back after an accident.
    deferrals: bySquawk.get(row.id) ?? [],
  }));
}

export async function squawkRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { aircraft_id?: string; status?: string; open?: string } }>(
    '/squawks',
    { config: { requiresTenant: true, permission: ['squawks', 'read'] } },
    async (request) => {
      return request.withTenant(async (trx) => {
        let query = selectSquawks(trx);
        if (request.query.aircraft_id) {
          query = query.where('s.aircraft_id', '=', request.query.aircraft_id);
        }
        if (request.query.status) {
          query = query.where('s.status', '=', request.query.status as 'open');
        } else if (request.query.open === 'true') {
          // Deferred is still open as a defect — it is only the grounding
          // that a deferral lifts. Both belong on the "what is outstanding"
          // list a mechanic works from.
          query = query.where('s.status', '!=', 'resolved');
        }
        const rows = await query
          .orderBy('s.grounding', 'desc')
          .orderBy('s.reported_at', 'desc')
          .limit(500)
          .execute();
        return withDeferrals(trx, rows);
      });
    },
  );

  /**
   * Filing one. `squawks: write` — this is the pilot's half of §1.5's line,
   * and the Pilot bundle holds it.
   *
   * Idempotent like the post-flight entry, and for the same reason: a squawk
   * is filed at the tiedown, on one bar of signal, often in the same
   * submission as the flight it was found on (§8.2).
   */
  app.post<{ Body: CreateSquawkRequest }>(
    '/squawks',
    {
      schema: createSchema,
      config: { requiresTenant: true, permission: ['squawks', 'write'] },
    },
    async (request, reply) => {
      const key = request.headers['idempotency-key'];
      if (typeof key !== 'string' || key.length < 8) {
        return reply.status(400).send({
          error: 'invalid_request',
          detail: 'an Idempotency-Key header of at least 8 characters is required',
        });
      }

      const body = request.body;
      const ctx = { tenantId: request.ctx!.tenantId!, userId: request.ctx!.userId };

      const outcome = await withIdempotency<SquawkResponse>(
        ctx,
        key,
        'POST /squawks',
        body,
        async (trx) => {
          const aircraft = await trx
            .selectFrom('aircraft')
            .select('id')
            .where('id', '=', body.aircraft_id)
            .executeTakeFirst();
          if (!aircraft) throw new NotFoundError();

          const created = await trx
            .insertInto('squawks')
            .values({
              tenant_id: ctx.tenantId,
              aircraft_id: body.aircraft_id,
              summary: body.summary,
              details: body.details ?? null,
              severity: body.severity ?? 'minor',
              // 'grounding' severity always grounds; anything else takes the
              // reporter's word, and a mechanic can ground it later.
              grounding: body.grounding ?? body.severity === 'grounding',
              reported_by: await ownMembership(trx, ctx.userId),
              ...(body.reported_at ? { reported_at: new Date(body.reported_at) } : {}),
              found_on_flight_id: body.found_on_flight_id ?? null,
            })
            .returning('id')
            .executeTakeFirstOrThrow();

          const rows = await selectSquawks(trx).where('s.id', '=', created.id).execute();
          return { status: 201, body: (await withDeferrals(trx, rows))[0]! };
        },
      );

      return reply.status(outcome.replayed ? 200 : outcome.status).send(outcome.body);
    },
  );

  /**
   * Updating one — and this is where §1.5's line is actually drawn.
   *
   * Filing takes `squawks: write`, which a Pilot holds. **Closing** one, or
   * deciding it may be deferred and flown with, takes `maintenance: write`,
   * which they do not. The route declares the first and the handler requires
   * the second, because the difference depends on what is being changed
   * rather than on which endpoint was called.
   */
  app.patch<{ Params: { id: string }; Body: UpdateSquawkRequest }>(
    '/squawks/:id',
    {
      schema: updateSchema,
      config: { requiresTenant: true, permission: ['squawks', 'write'] },
    },
    async (request) => {
      const body = request.body;
      const closing = body.status === 'resolved' || body.status === 'deferred';
      if (closing) {
        const { permissions } = await request.loadGates();
        permissions.require('maintenance', 'write');
      }

      return request.withTenant(async (trx) => {
        const membership =
          body.status === 'resolved' ? await ownMembership(trx, request.ctx!.userId) : null;

        const result = await trx
          .updateTable('squawks')
          .set({
            ...body,
            // The resolution is a pair: who and when. Setting one without
            // the other is refused by a CHECK, and rightly.
            ...(body.status === 'resolved'
              ? { resolved_at: new Date(), resolved_by: membership }
              : {}),
            // Reopening clears it, so the record cannot claim a resolution
            // that was taken back.
            ...(body.status === 'open' ? { resolved_at: null, resolved_by: null } : {}),
          })
          .where('id', '=', request.params.id)
          .executeTakeFirst();
        if (result.numUpdatedRows === 0n) throw new NotFoundError();

        const rows = await selectSquawks(trx).where('s.id', '=', request.params.id).execute();
        return (await withDeferrals(trx, rows))[0]!;
      });
    },
  );

  /**
   * Deferring: the decision that the aircraft may fly with a known defect,
   * which is what an MEL and 14 CFR 91.213 are for.
   *
   * `maintenance: write`, because it is a maintenance judgement rather than
   * a report. Append-only, and lifting it is a status change on the squawk
   * that leaves this row exactly where it was.
   */
  app.post<{ Params: { id: string }; Body: CreateSquawkDeferralRequest }>(
    '/squawks/:id/deferrals',
    {
      schema: deferralSchema,
      config: { requiresTenant: true, permission: ['maintenance', 'write'] },
    },
    async (request, reply) => {
      const body = request.body;
      const squawk = await request.withTenant(async (trx) => {
        const found = await trx
          .selectFrom('squawks')
          .select('id')
          .where('id', '=', request.params.id)
          .executeTakeFirst();
        if (!found) throw new NotFoundError();

        await trx
          .insertInto('squawk_deferrals')
          .values({
            tenant_id: request.ctx!.tenantId!,
            squawk_id: request.params.id,
            basis: body.basis,
            reference: body.reference ?? null,
            expires_on: body.expires_on ?? null,
            note: body.note ?? null,
            deferred_by: await ownMembership(trx, request.ctx!.userId),
          })
          .execute();

        // The deferral and the status move together: a row that says the
        // aircraft may fly, and the status that lets it.
        await trx
          .updateTable('squawks')
          .set({ status: 'deferred' })
          .where('id', '=', request.params.id)
          .execute();

        const rows = await selectSquawks(trx).where('s.id', '=', request.params.id).execute();
        return (await withDeferrals(trx, rows))[0]!;
      });

      return reply.status(201).send(squawk);
    },
  );
}
