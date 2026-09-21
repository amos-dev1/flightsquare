import type { FastifyInstance } from 'fastify';
import type {
  AircraftResponse,
  CreateAircraftRequest,
  MeterReadingResponse,
} from '@flightsquare/shared';

import { sql } from 'kysely';

import { assertQuota } from '../../db/entitlements.js';
import { selectAvailability, toAvailability } from './maintenance.js';
import { NotFoundError } from '../errors.js';
import type { Tx } from '../../db/context.js';

const registrationPattern = '^[A-Z0-9][A-Z0-9-]{1,15}$';

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
      seats: { type: 'integer', minimum: 1, maximum: 50 },
      maintenance_meter: { type: 'string', enum: ['hobbs', 'tach', 'airframe'] },
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
      // §5.5: archive rather than delete. 'sold' is the other end of a life.
      status: { type: 'string', enum: ['active', 'archived', 'sold'] },
      seats: { type: ['integer', 'null'], minimum: 1, maximum: 50 },
      maintenance_meter: { type: 'string', enum: ['hobbs', 'tach', 'airframe'] },
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
  };
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
          })
          .execute();

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
      });

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
      const { seats, maintenance_meter: meter, ...aircraftFields } = request.body;

      const rows = await request.withTenant(async (trx) => {
        if (Object.keys(aircraftFields).length > 0) {
          const result = await trx
            .updateTable('aircraft')
            .set(aircraftFields)
            .where('id', '=', request.params.id)
            .executeTakeFirst();
          if (result.numUpdatedRows === 0n) throw new NotFoundError();
        }

        if (seats !== undefined || meter !== undefined) {
          await trx
            .updateTable('aircraft_config')
            .set({
              ...(seats !== undefined ? { seats: seats as number | null } : {}),
              ...(meter !== undefined ? { maintenance_meter: meter as 'hobbs' } : {}),
            })
            .where('aircraft_id', '=', request.params.id)
            .execute();
        }

        return selectAircraft(trx, request.params.id);
      });

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
