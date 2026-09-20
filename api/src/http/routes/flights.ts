import type { FastifyInstance } from 'fastify';
import type { CreateFlightRequest, FlightResponse } from '@flightsquare/shared';

import { withIdempotency } from '../../db/idempotency.js';
import { NotFoundError } from '../errors.js';
import type { Tx } from '../../db/context.js';

const decimal = { type: 'string', pattern: '^[0-9]{1,7}(\\.[0-9])?$' } as const;

const createSchema = {
  body: {
    type: 'object',
    required: ['aircraft_id', 'flight_date'],
    additionalProperties: false,
    properties: {
      aircraft_id: { type: 'string', format: 'uuid' },
      flight_date: { type: 'string', format: 'date' },
      flown_by: { type: 'string', format: 'uuid' },
      departed_from: { type: 'string', maxLength: 16 },
      arrived_at: { type: 'string', maxLength: 16 },
      remarks: { type: 'string', maxLength: 2000 },

      // Decimal strings, not numbers. A tach reading is `numeric`, and a
      // float round-trip is how a maintenance countdown quietly drifts.
      hobbs_start: decimal,
      hobbs_end: decimal,
      tach_start: decimal,
      tach_end: decimal,

      fuel_remaining_after: decimal,
      fuel_added_qty: decimal,
      // §3.7 rule 3: integer minor units. Never a float, not even here.
      fuel_added_cost_cents: { type: 'integer', minimum: 0 },
      receipt_reference: { type: 'string', maxLength: 200 },

      recorded_at: { type: 'string', format: 'date-time' },
    },
  },
} as const;

function selectFlights(trx: Tx) {
  return trx
    .selectFrom('flights')
    .innerJoin('aircraft', 'aircraft.id', 'flights.aircraft_id')
    .leftJoin('flight_meters', 'flight_meters.flight_id', 'flights.id')
    .leftJoin('flight_fuel', 'flight_fuel.flight_id', 'flights.id')
    .leftJoin('memberships', 'memberships.id', 'flights.flown_by')
    .leftJoin('users', 'users.id', 'memberships.user_id')
    .select([
      'flights.id',
      'flights.aircraft_id',
      'aircraft.registration as aircraft_registration',
      'flights.flown_by',
      'users.email as flown_by_email',
      'flights.flight_date',
      'flights.departed_from',
      'flights.arrived_at',
      'flights.remarks',
      'flights.needs_review',
      'flights.review_reason',
      'flights.recorded_at',
      'flight_meters.hobbs_start',
      'flight_meters.hobbs_end',
      'flight_meters.hobbs_hours',
      'flight_meters.tach_start',
      'flight_meters.tach_end',
      'flight_meters.tach_hours',
      'flight_fuel.fuel_remaining_after',
      'flight_fuel.fuel_added_qty',
      'flight_fuel.fuel_added_cost_cents',
      'flight_fuel.currency',
    ]);
}

type FlightRow = Awaited<ReturnType<ReturnType<typeof selectFlights>['execute']>>[number];

function toResponse(row: FlightRow): FlightResponse {
  return { ...row, recorded_at: row.recorded_at.toISOString() };
}

/** The caller's own membership in this tenant. */
async function ownMembership(trx: Tx, userId: string): Promise<string> {
  const row = await trx
    .selectFrom('memberships')
    .select('id')
    .where('user_id', '=', userId)
    .where('status', '=', 'active')
    .executeTakeFirst();
  if (!row) throw new NotFoundError();
  return row.id;
}

export async function flightRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { aircraft_id?: string; needs_review?: string } }>(
    '/flights',
    { config: { requiresTenant: true, permission: ['flights', 'read'] } },
    async (request) => {
      const rows = await request.withTenant(async (trx) => {
        let query = selectFlights(trx);
        if (request.query.aircraft_id) {
          query = query.where('flights.aircraft_id', '=', request.query.aircraft_id);
        }
        if (request.query.needs_review === 'true') {
          query = query.where('flights.needs_review', '=', true);
        }
        return query
          .orderBy('flights.flight_date', 'desc')
          .orderBy('flights.recorded_at', 'desc')
          .limit(200)
          .execute();
      });
      return rows.map(toResponse);
    },
  );

  /**
   * The post-flight entry. §3.4 calls it the most important screen in the
   * product: if it takes more than a minute at the tiedown, people skip it,
   * the meters go stale, and every number in the app quietly becomes wrong.
   *
   * Deliberately **not** quota-checked. §4.2: never cap flights, on any tier.
   * A tenant that hit a cap would stop logging and the damage would be to the
   * data rather than to the experience.
   */
  app.post<{ Body: CreateFlightRequest }>(
    '/flights',
    {
      schema: createSchema,
      config: { requiresTenant: true, permission: ['flights', 'write'] },
    },
    async (request, reply) => {
      const key = request.headers['idempotency-key'];
      if (typeof key !== 'string' || key.length < 8) {
        // §8.2 asks every write to carry one, and this is the write that most
        // needs it: it is made offline, retried, and advances the meters.
        return reply.status(400).send({
          error: 'invalid_request',
          detail: 'an Idempotency-Key header of at least 8 characters is required',
        });
      }

      const body = request.body;

      // A flight that advanced no meter is not a flight this product records:
      // advancing the meters is what a flight record is *for*. The database
      // says so too, but a CHECK violation surfacing as a 500 tells the
      // person at the tiedown nothing about what to fix.
      if (body.hobbs_end === undefined && body.tach_end === undefined) {
        return reply.status(400).send({
          error: 'invalid_request',
          detail: 'a flight needs an ending Hobbs or tach reading',
        });
      }

      const ctx = { tenantId: request.ctx!.tenantId!, userId: request.ctx!.userId };

      const outcome = await withIdempotency<FlightResponse>(
        ctx,
        key,
        'POST /flights',
        body,
        async (trx) => {
          const aircraft = await trx
            .selectFrom('aircraft')
            .select('id')
            .where('id', '=', body.aircraft_id)
            .executeTakeFirst();
          if (!aircraft) throw new NotFoundError();

          const flight = await trx
            .insertInto('flights')
            .values({
              tenant_id: ctx.tenantId,
              aircraft_id: body.aircraft_id,
              flown_by: body.flown_by ?? (await ownMembership(trx, ctx.userId)),
              flight_date: body.flight_date,
              departed_from: body.departed_from ?? null,
              arrived_at: body.arrived_at ?? null,
              remarks: body.remarks ?? null,
              // §8.2: the client says when the flight ended; the server
              // records when it heard about it. They differ, sometimes by days.
              recorded_at: body.recorded_at ? new Date(body.recorded_at) : new Date(),
              created_by: ctx.userId,
            })
            .returning('id')
            .executeTakeFirstOrThrow();

          // Inserting these is what advances the meters — a trigger turns
          // them into a meter_reading, so the core loop cannot be skipped by
          // a caller that forgets.
          await trx
            .insertInto('flight_meters')
            .values({
              flight_id: flight.id,
              tenant_id: ctx.tenantId,
              hobbs_start: body.hobbs_start ?? null,
              hobbs_end: body.hobbs_end ?? null,
              tach_start: body.tach_start ?? null,
              tach_end: body.tach_end ?? null,
            })
            .execute();

          const hasFuel =
            body.fuel_remaining_after !== undefined ||
            body.fuel_added_qty !== undefined ||
            body.fuel_added_cost_cents !== undefined;

          if (hasFuel) {
            await trx
              .insertInto('flight_fuel')
              .values({
                flight_id: flight.id,
                tenant_id: ctx.tenantId,
                fuel_remaining_after: body.fuel_remaining_after ?? null,
                fuel_added_qty: body.fuel_added_qty ?? null,
                fuel_added_cost_cents: body.fuel_added_cost_cents ?? null,
                receipt_reference: body.receipt_reference ?? null,
              })
              .execute();
          }

          const rows = await selectFlights(trx).where('flights.id', '=', flight.id).execute();
          return { status: 201, body: toResponse(rows[0]!) };
        },
      );

      // A replay returns 200 with the original body rather than 201: the
      // flight was created once, and saying so twice would be a lie.
      return reply.status(outcome.replayed ? 200 : outcome.status).send(outcome.body);
    },
  );

  /**
   * §3.4: a CSV of a member's **own** flight rows, so they can transcribe
   * into their real logbook. That is the whole extent of the pilot-logbook
   * story — an export, not a feature — and every request past this line gets
   * declined until it is a deliberate decision rather than a drift.
   */
  app.get(
    '/flights/export.csv',
    { config: { requiresTenant: true, permission: ['flights', 'read'] } },
    async (request, reply) => {
      const rows = await request.withTenant(async (trx) => {
        // Own rows by construction rather than by permission: open decision 3
        // has not settled how the model expresses "own only", and this
        // endpoint does not need it to.
        const membership = await ownMembership(trx, request.ctx!.userId);
        return selectFlights(trx)
          .where('flights.flown_by', '=', membership)
          .orderBy('flights.flight_date', 'asc')
          .execute();
      });

      const header = [
        'date', 'aircraft', 'from', 'to',
        'hobbs_start', 'hobbs_end', 'hobbs_hours',
        'tach_start', 'tach_end', 'tach_hours', 'remarks',
      ];

      const lines = [
        header.join(','),
        ...rows.map((row) =>
          [
            row.flight_date,
            row.aircraft_registration,
            row.departed_from ?? '',
            row.arrived_at ?? '',
            row.hobbs_start ?? '',
            row.hobbs_end ?? '',
            row.hobbs_hours ?? '',
            row.tach_start ?? '',
            row.tach_end ?? '',
            row.tach_hours ?? '',
            row.remarks ?? '',
          ]
            .map(csvField)
            .join(','),
        ),
      ];

      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', 'attachment; filename="flights.csv"')
        .send(`${lines.join('\n')}\n`);
    },
  );
}

/** RFC 4180: quote anything containing a comma, quote or newline. */
function csvField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}
