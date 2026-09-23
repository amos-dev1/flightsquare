import type { FastifyInstance } from 'fastify';
import type {
  AircraftResponse,
  CreateAircraftRequest,
  MeterReadingResponse,
} from '@flightsquare/shared';

import { sql } from 'kysely';

import { assertQuota } from '../../db/entitlements.js';
import { ownMembership } from '../../db/membership.js';
import { selectAvailability, toAvailability } from './maintenance.js';
import {
  ConflictError,
  foreignKeyViolation,
  InvalidRequestError,
  isUniqueViolation,
  NotFoundError,
} from '../errors.js';
import type { Tx } from '../../db/context.js';

const registrationPattern = '^[A-Z0-9][A-Z0-9-]{1,15}$';
const decimal = { type: 'string', pattern: '^[0-9]{1,7}(\\.[0-9])?$' } as const;

/** The per-aircraft settings of V1_SCOPE M2, shared by create and update. */
const configFields = {
  seats: { type: 'integer', minimum: 1, maximum: 50 },
  maintenance_meter: { type: 'string', enum: ['hobbs', 'tach', 'airframe'] },
  billing_meter: { type: 'string', enum: ['hobbs', 'tach'] },
  rate_basis: { type: 'string', enum: ['wet', 'dry'] },
  // §3.7 rule 3: integer minor units. Never a float, not even here.
  default_rate_cents: { type: 'integer', minimum: 0 },
  fuel_capacity: decimal,
  fuel_units: { type: 'string', enum: ['gallons', 'litres'] },
} as const;

const createSchema = {
  body: {
    type: 'object',
    required: ['registration'],
    additionalProperties: false,
    properties: {
      registration: { type: 'string', pattern: registrationPattern },
      type_code: { type: 'string', maxLength: 16 },
      serial_number: { type: 'string', maxLength: 64 },
      year_manufactured: { type: 'integer', minimum: 1900, maximum: 2100 },
      home_base: { type: 'string', maxLength: 16 },
      ownership: { type: 'string', enum: ['owned', 'leased', 'leaseback', 'club_owned'] },
      ...configFields,

      // Where the meters stand today. The one time they are set rather than
      // advanced — and even here it is written as a reading, so the totals
      // stay derived from the log (§3.4).
      hobbs: decimal,
      tach: decimal,
      airframe_hours: decimal,
    },
  },
} as const;

const updateSchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    minProperties: 1,
    properties: {
      registration: { type: 'string', pattern: registrationPattern },
      type_code: { type: ['string', 'null'], maxLength: 16 },
      serial_number: { type: ['string', 'null'], maxLength: 64 },
      year_manufactured: { type: ['integer', 'null'], minimum: 1900, maximum: 2100 },
      home_base: { type: ['string', 'null'], maxLength: 16 },
      ownership: { type: 'string', enum: ['owned', 'leased', 'leaseback', 'club_owned'] },
      // §5.5: archive rather than delete. 'grounded' is an administrator
      // taking it out of service; 'sold' is the other end of a life.
      status: { type: 'string', enum: ['active', 'grounded', 'archived', 'sold'] },
      ...configFields,
    },
  },
} as const;

const readingSchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    properties: {
      // Decimal strings, not numbers: a tach reading is `numeric`, and a
      // float round-trip is how a maintenance countdown quietly drifts.
      hobbs: { type: 'string', pattern: '^[0-9]{1,7}(\\.[0-9])?$' },
      tach: { type: 'string', pattern: '^[0-9]{1,7}(\\.[0-9])?$' },
      airframe_hours: { type: 'string', pattern: '^[0-9]{1,7}(\\.[0-9])?$' },
      cycles: { type: 'integer', minimum: 0 },
      recorded_at: { type: 'string', format: 'date-time' },
      supersedes_id: { type: 'string', format: 'uuid' },
      note: { type: 'string', maxLength: 500 },
    },
  },
} as const;

/** The shape the client gets: the aircraft row joined to its config. */
async function selectAircraft(trx: Tx, id?: string) {
  let query = trx
    .selectFrom('aircraft')
    .leftJoin('aircraft_config', 'aircraft_config.aircraft_id', 'aircraft.id')
    .select([
      'aircraft.id',
      'aircraft.registration',
      'aircraft.type_code',
      'aircraft.serial_number',
      'aircraft.year_manufactured',
      'aircraft.home_base',
      'aircraft.status',
      'aircraft.ownership',
      'aircraft.airframe_hours',
      'aircraft.hobbs',
      'aircraft.tach',
      'aircraft.cycles',
      'aircraft.totals_updated_at',
      'aircraft_config.maintenance_meter',
      'aircraft_config.seats',
      'aircraft_config.billing_meter',
      'aircraft_config.rate_basis',
      'aircraft_config.currency',
      /**
       * Today's rate, resolved rather than stored (§3.7 rule 4). The rate
       * table is effective-dated, so "what does it cost" is a question with
       * a date in it — and the answer for a flight already logged lives on
       * the charge, not here.
       */
      sql<number | null>`(
        SELECT r.amount_cents
          FROM public.aircraft_rates r
         WHERE r.aircraft_id = aircraft.id
           AND r.effective_from <= current_date
         ORDER BY r.effective_from DESC, r.id DESC
         LIMIT 1)`.as('default_rate_cents'),
      'aircraft_config.fuel_capacity',
      'aircraft_config.fuel_units',
      /**
       * §3.4: fuel remaining is aircraft *state* — latest reading wins, and
       * it is never computed by arithmetic across flights, because pilots
       * estimate, gauges lie, and somebody always tops off without logging
       * it. So it is read back as the last one recorded, not summed.
       */
      sql<string | null>`(
        SELECT ff.fuel_remaining_after
          FROM public.flight_fuel ff
          JOIN public.flights f ON f.id = ff.flight_id
         WHERE f.aircraft_id = aircraft.id
           AND ff.fuel_remaining_after IS NOT NULL
         ORDER BY f.recorded_at DESC, f.id DESC
         LIMIT 1)`.as('fuel_remaining'),
      /**
       * When that reading was taken.
       *
       * Fuel, location and the meters come from three different places and
       * are frequently three different moments — the meters advance on every
       * flight, fuel only when somebody records it, and a location only when
       * the arrival field was filled in. One "last recorded" line over all
       * three would be a claim about two of them that nothing supports, so
       * each reading carries its own and the client shares one line only when
       * they genuinely agree.
       */
      sql<Date | null>`(
        SELECT f.recorded_at
          FROM public.flight_fuel ff
          JOIN public.flights f ON f.id = ff.flight_id
         WHERE f.aircraft_id = aircraft.id
           AND ff.fuel_remaining_after IS NOT NULL
         ORDER BY f.recorded_at DESC, f.id DESC
         LIMIT 1)`.as('fuel_remaining_at'),
      /**
       * Where it last landed, as far as this product can honestly say.
       *
       * There is no telemetry and no position source: the only recorded
       * location in the schema is the `arrived_at` a pilot typed on the
       * post-flight form, which is free text since 0014. So this is "the last
       * place a flight was logged as arriving", and the UI says so rather
       * than implying the aeroplane is being tracked.
       */
      sql<string | null>`(
        SELECT f.arrived_at
          FROM public.flights f
         WHERE f.aircraft_id = aircraft.id
           AND f.arrived_at IS NOT NULL
         ORDER BY f.recorded_at DESC, f.id DESC
         LIMIT 1)`.as('last_location'),
      sql<Date | null>`(
        SELECT f.recorded_at
          FROM public.flights f
         WHERE f.aircraft_id = aircraft.id
           AND f.arrived_at IS NOT NULL
         ORDER BY f.recorded_at DESC, f.id DESC
         LIMIT 1)`.as('last_location_at'),
    ]);
  if (id !== undefined) query = query.where('aircraft.id', '=', id);
  return query.orderBy('aircraft.registration').execute();
}

function toResponse(row: Awaited<ReturnType<typeof selectAircraft>>[number]): AircraftResponse {
  return {
    id: row.id,
    registration: row.registration,
    type_code: row.type_code,
    serial_number: row.serial_number,
    year_manufactured: row.year_manufactured,
    home_base: row.home_base,
    status: row.status,
    ownership: row.ownership,
    airframe_hours: row.airframe_hours,
    hobbs: row.hobbs,
    tach: row.tach,
    cycles: row.cycles,
    totals_updated_at: row.totals_updated_at?.toISOString() ?? null,
    maintenance_meter: row.maintenance_meter ?? 'tach',
    seats: row.seats,
    billing_meter: row.billing_meter ?? 'hobbs',
    rate_basis: row.rate_basis ?? 'dry',
    default_rate_cents: row.default_rate_cents,
    currency: row.currency ?? 'USD',
    fuel_capacity: row.fuel_capacity,
    fuel_units: row.fuel_units ?? 'gallons',
    fuel_remaining: row.fuel_remaining,
    fuel_remaining_at: row.fuel_remaining_at?.toISOString() ?? null,
    last_location: row.last_location,
    last_location_at: row.last_location_at?.toISOString() ?? null,
  };
}

/**
 * The three ways a write to `aircraft` fails because of what the caller
 * typed, turned into answers they can act on.
 *
 * Without this every one of them is an unhandled error: a 500, a
 * "Something went wrong" on screen, and a stack trace in the log for what is
 * a routine typo. §6 also wants the registration case to be a conflict rather
 * than a leak about what exists — within one tenant, which is where this
 * constraint lives, saying so is exactly what the person needs to hear.
 *
 * The reference tables are seeded thinly on purpose (§2.2 — the real lists
 * are an import job), so an unknown airport is the *expected* case for
 * anybody outside the twenty fields we hold. It has to read as a limitation
 * of our data, not as a mistake they made.
 */
function rethrowAircraftWriteError(error: unknown): never {
  if (isUniqueViolation(error)) {
    throw new ConflictError('that registration is already in your fleet');
  }

  switch (foreignKeyViolation(error)) {
    // `aircraft_home_base_fkey` used to be here. 0011 dropped it: the
    // aerodrome table holds twenty of some twenty thousand fields, and a key
    // against a list that incomplete refuses almost every true answer.
    case 'aircraft_type_code_fkey':
      throw new InvalidRequestError(
        'that type designator is not in our list yet — leave it blank, or use ' +
          'one of the types the field suggests',
      );
    default:
      throw error;
  }
}

export async function aircraftRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/aircraft',
    { config: { requiresTenant: true, permission: ['aircraft', 'read'] } },
    async (request) => {
      const rows = await request.withTenant((trx) => selectAircraft(trx));
      return rows.map(toResponse);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/aircraft/:id',
    { config: { requiresTenant: true, permission: ['aircraft', 'read'] } },
    async (request) => {
      const rows = await request.withTenant((trx) => selectAircraft(trx, request.params.id));
      // §6: an aircraft in another tenant is "not found", never "you don't
      // have access to that aircraft" — the two must be indistinguishable.
      const row = rows[0];
      if (!row) throw new NotFoundError();
      return toResponse(row);
    },
  );

  app.post<{ Body: CreateAircraftRequest }>(
    '/aircraft',
    {
      schema: createSchema,
      config: { requiresTenant: true, permission: ['aircraft', 'write'] },
    },
    async (request, reply) => {
      const { entitlements } = await request.loadGates();
      const body = request.body;

      const created = await request.withTenant(async (trx) => {
        // §4.5: inside the write transaction, because the row lock has to be.
        // Checked here rather than in the preHandler for exactly that reason.
        await assertQuota(trx, 'aircraft.active', entitlements.quota('aircraft.active'));

        const aircraft = await trx
          .insertInto('aircraft')
          .values({
            tenant_id: request.ctx!.tenantId!,
            registration: body.registration,
            type_code: body.type_code ?? null,
            serial_number: body.serial_number ?? null,
            year_manufactured: body.year_manufactured ?? null,
            home_base: body.home_base ?? null,
            ownership: body.ownership ?? 'owned',
          })
          .returning('id')
          .executeTakeFirstOrThrow();

        await trx
          .insertInto('aircraft_config')
          .values({
            aircraft_id: aircraft.id,
            tenant_id: request.ctx!.tenantId!,
            seats: body.seats ?? null,
            maintenance_meter: body.maintenance_meter ?? 'tach',
            ...(body.billing_meter !== undefined
              ? { billing_meter: body.billing_meter }
              : {}),
            ...(body.rate_basis !== undefined ? { rate_basis: body.rate_basis } : {}),
            fuel_capacity: body.fuel_capacity ?? null,
            ...(body.fuel_units !== undefined ? { fuel_units: body.fuel_units } : {}),
          })
          .execute();

        // §3.7 rule 4: the rate is a row with a date on it, from the first
        // one onwards. Dated today, because that is when it starts being
        // true — and nothing has been flown yet to re-price.
        if (body.default_rate_cents !== undefined) {
          await trx
            .insertInto('aircraft_rates')
            .values({
              tenant_id: request.ctx!.tenantId!,
              aircraft_id: aircraft.id,
              amount_cents: body.default_rate_cents,
              created_by: await ownMembership(trx, request.ctx!.userId),
            })
            .execute();
        }

        /**
         * Where the meters stand on the day the aeroplane is added.
         *
         * Written as a reading rather than onto the aircraft row, because the
         * totals are derived from an append-only log and app_role holds no
         * grant to write them directly (§3.4). This is the only moment a
         * meter is *set*; after it they advance through flight logs or an
         * explicit correction, and never by editing the aircraft.
         */
        if (body.hobbs || body.tach || body.airframe_hours) {
          await trx
            .insertInto('meter_readings')
            .values({
              tenant_id: request.ctx!.tenantId!,
              aircraft_id: aircraft.id,
              hobbs: body.hobbs ?? null,
              tach: body.tach ?? null,
              airframe_hours: body.airframe_hours ?? null,
              recorded_at: new Date(),
              source: 'manual',
              recorded_by: request.ctx!.userId,
              note: 'Opening reading, recorded when the aircraft was added.',
            })
            .execute();
        }

        // §3.6: adding an aircraft instantiates the applicable presets, as
        // copies with no link back to the library. They arrive due *now*
        // with no compliance date behind them — the system knows nothing
        // about this airframe's history yet, and dating an annual twelve
        // months out would assert that it is in annual.
        //
        // Gated on the flag rather than assumed: seeding rows for a module
        // the tenant does not have would be creating data they cannot see.
        if (entitlements.flag('maintenance_module')) {
          await sql`SELECT public.instantiate_maintenance_templates(${aircraft.id}::uuid)`
            .execute(trx);
        }

        return selectAircraft(trx, aircraft.id);
      }).catch(rethrowAircraftWriteError);

      return reply.status(201).send(toResponse(created[0]!));
    },
  );

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/aircraft/:id',
    {
      schema: updateSchema,
      config: { requiresTenant: true, permission: ['aircraft', 'write'] },
    },
    async (request) => {
      const {
        seats,
        maintenance_meter: meter,
        billing_meter: billingMeter,
        rate_basis: rateBasis,
        default_rate_cents: rateCents,
        fuel_capacity: fuelCapacity,
        fuel_units: fuelUnits,
        ...aircraftFields
      } = request.body;
      const { entitlements } = await request.loadGates();

      const configChanges = {
        ...(seats !== undefined ? { seats: seats as number | null } : {}),
        ...(meter !== undefined ? { maintenance_meter: meter as 'hobbs' } : {}),
        ...(billingMeter !== undefined ? { billing_meter: billingMeter as 'hobbs' } : {}),
        ...(rateBasis !== undefined ? { rate_basis: rateBasis as 'wet' } : {}),

        ...(fuelCapacity !== undefined
          ? { fuel_capacity: fuelCapacity as string | null }
          : {}),
        ...(fuelUnits !== undefined ? { fuel_units: fuelUnits as 'gallons' } : {}),
      };

      const rows = await request.withTenant(async (trx) => {
        if (Object.keys(aircraftFields).length > 0) {
          // §4.5: un-archiving is a create as far as the count is concerned.
          // Without this, archive one, add another, restore the first, and a
          // free tenant is sitting on two active aircraft with a limit of
          // one — and nothing ever said no. The lock belongs in the same
          // transaction as the write it guards, which is why it is here
          // rather than in the preHandler.
          if (aircraftFields.status === 'active') {
            const current = await trx
              .selectFrom('aircraft')
              .select('status')
              .where('id', '=', request.params.id)
              .executeTakeFirst();
            if (current && current.status !== 'active') {
              await assertQuota(trx, 'aircraft.active', entitlements.quota('aircraft.active'));
            }
          }

          const result = await trx
            .updateTable('aircraft')
            .set(aircraftFields)
            .where('id', '=', request.params.id)
            .executeTakeFirst();
          if (result.numUpdatedRows === 0n) throw new NotFoundError();
        }

        /**
         * Changing the rate writes a new row dated today, and leaves every
         * charge already made exactly as it was. That is §3.7 rule 1 and
         * rule 4 working together: February keeps February's price.
         */
        if (rateCents !== undefined && rateCents !== null) {
          await trx
            .insertInto('aircraft_rates')
            .values({
              tenant_id: request.ctx!.tenantId!,
              aircraft_id: request.params.id,
              amount_cents: rateCents as number,
              created_by: await ownMembership(trx, request.ctx!.userId),
            })
            .execute();
        }

        if (Object.keys(configChanges).length > 0) {
          await trx
            .updateTable('aircraft_config')
            .set(configChanges)
            .where('aircraft_id', '=', request.params.id)
            .execute();
        }

        return selectAircraft(trx, request.params.id);
      }).catch(rethrowAircraftWriteError);

      const row = rows[0];
      if (!row) throw new NotFoundError();
      return toResponse(row);
    },
  );

  // -------------------------------------------------------------------------
  // Availability (§3.3)
  //
  // `aircraft: read`, not `maintenance: read`, and no feature gate. Everyone
  // who can see the fleet needs to know what is dispatchable — a Pilot holds
  // `maintenance: read` today, but tying "can I book this" to the
  // maintenance module would mean a tenant without it booked grounded
  // aircraft.
  //
  // The rule itself is not here. It is one view (§6.2: booking paths consult
  // aircraft_availability rather than querying squawks), so the scheduler
  // will ask the same question this endpoint asks and get the same answer.
  // -------------------------------------------------------------------------

  app.get(
    '/availability',
    { config: { requiresTenant: true, permission: ['aircraft', 'read'] } },
    async (request) => {
      const rows = await request.withTenant((trx) =>
        selectAvailability(trx).orderBy('registration').execute(),
      );
      return rows.map(toAvailability);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/aircraft/:id/availability',
    { config: { requiresTenant: true, permission: ['aircraft', 'read'] } },
    async (request) => {
      const row = await request.withTenant((trx) =>
        selectAvailability(trx).where('aircraft_id', '=', request.params.id).executeTakeFirst(),
      );
      if (!row) throw new NotFoundError();
      return toAvailability(row);
    },
  );

  // -------------------------------------------------------------------------
  // Meters
  // -------------------------------------------------------------------------

  app.get<{ Params: { id: string } }>(
    '/aircraft/:id/meter-readings',
    { config: { requiresTenant: true, permission: ['aircraft', 'read'] } },
    async (request) => {
      const rows = await request.withTenant(async (trx) => {
        const aircraft = await trx
          .selectFrom('aircraft')
          .select('id')
          .where('id', '=', request.params.id)
          .executeTakeFirst();
        if (!aircraft) throw new NotFoundError();

        const readings = await trx
          .selectFrom('meter_readings')
          .selectAll()
          .where('aircraft_id', '=', request.params.id)
          .orderBy('recorded_at', 'desc')
          .orderBy('id', 'desc')
          .execute();

        // Superseded rows stay in the log and are labelled, never hidden:
        // the correction and what it corrected are both part of the trail.
        const superseded = new Set(
          readings.map((r) => r.supersedes_id).filter((id): id is string => id !== null),
        );
        return readings.map(
          (r): MeterReadingResponse => ({
            id: r.id,
            aircraft_id: r.aircraft_id,
            hobbs: r.hobbs,
            tach: r.tach,
            airframe_hours: r.airframe_hours,
            cycles: r.cycles,
            recorded_at: r.recorded_at.toISOString(),
            received_at: r.received_at.toISOString(),
            source: r.source,
            supersedes_id: r.supersedes_id,
            note: r.note,
            superseded: superseded.has(r.id),
          }),
        );
      });
      return rows;
    },
  );

  app.post<{ Params: { id: string }; Body: Record<string, string | number> }>(
    '/aircraft/:id/meter-readings',
    {
      schema: readingSchema,
      config: { requiresTenant: true, permission: ['aircraft', 'write'] },
    },
    async (request, reply) => {
      const body = request.body;
      if (
        body.hobbs === undefined &&
        body.tach === undefined &&
        body.airframe_hours === undefined &&
        body.cycles === undefined
      ) {
        // A reading that records nothing is not a reading. The database says
        // so too; this is just a better message.
        return reply.status(400).send({
          error: 'invalid_request',
          detail: 'a reading must carry at least one meter value',
        });
      }

      const created = await request.withTenant(async (trx) => {
        const aircraft = await trx
          .selectFrom('aircraft')
          .select('id')
          .where('id', '=', request.params.id)
          .executeTakeFirst();
        if (!aircraft) throw new NotFoundError();

        return trx
          .insertInto('meter_readings')
          .values({
            tenant_id: request.ctx!.tenantId!,
            aircraft_id: request.params.id,
            hobbs: (body.hobbs as string | undefined) ?? null,
            tach: (body.tach as string | undefined) ?? null,
            airframe_hours: (body.airframe_hours as string | undefined) ?? null,
            cycles: (body.cycles as number | undefined) ?? null,
            // §8.2: the client sends when it happened; the server records
            // when it arrived. They differ, sometimes by days.
            recorded_at: body.recorded_at ? new Date(body.recorded_at as string) : new Date(),
            source: 'manual',
            recorded_by: request.ctx!.userId,
            supersedes_id: (body.supersedes_id as string | undefined) ?? null,
            note: (body.note as string | undefined) ?? null,
          })
          .returning(['id', 'recorded_at'])
          .executeTakeFirstOrThrow();
      });

      return reply.status(201).send({
        id: created.id,
        recorded_at: created.recorded_at.toISOString(),
      });
    },
  );
}
