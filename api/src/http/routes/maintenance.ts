import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import type {
  AircraftAvailabilityResponse,
  ComplianceRecordResponse,
  CreateComplianceRecordRequest,
  CreateMaintenanceItemRequest,
  CreateWorkOrderRequest,
  MaintenanceItemResponse,
  MaintenanceTemplateResponse,
  UpdateMaintenanceItemRequest,
  UpdateWorkOrderRequest,
  WorkOrderResponse,
} from '@flightsquare/shared';

import { ownMembership } from '../../db/membership.js';
import { ConflictError, NotFoundError } from '../errors.js';
import type { Tx } from '../../db/context.js';

/**
 * Maintenance (§3.6), and the half of the core loop that consumes what
 * flight logging produces.
 *
 * Everything here is behind `maintenance_module` — a 404 when the flag is
 * off, per §1.6, so a tenant without it cannot tell from status codes
 * whether the module exists. The flag defaults to true on every tier today
 * (§4.3 gives maintenance tracking to all three), which is exactly why the
 * gate is worth declaring: the day that stops being true, the endpoints are
 * already correct.
 *
 * Squawks are **not** here. §1.5 keeps them a separate resource because a
 * pilot reports a defect and does not sign off the work, and putting them in
 * this file behind `maintenance: read` would quietly undo that.
 */

const decimal = { type: 'string', pattern: '^[0-9]{1,7}(\\.[0-9])?$' } as const;
const meter = { type: 'string', enum: ['hobbs', 'tach', 'airframe'] } as const;

const itemFields = {
  name: { type: 'string', minLength: 1, maxLength: 200 },
  description: { type: 'string', maxLength: 2000 },
  regulatory_reference: { type: 'string', maxLength: 100 },
  grounds_aircraft: { type: 'boolean' },
  due_on: { type: 'string', format: 'date' },
  due_at_hours: decimal,
  due_at_cycles: { type: 'integer', minimum: 0 },
  hours_meter: meter,
  interval_months: { type: 'integer', minimum: 1, maximum: 600 },
  interval_hours: decimal,
  interval_cycles: { type: 'integer', minimum: 1 },
  warn_within_days: { type: 'integer', minimum: 0, maximum: 365 },
  warn_within_hours: decimal,
} as const;

const createItemSchema = {
  body: {
    type: 'object',
    required: ['name'],
    additionalProperties: false,
    properties: itemFields,
  },
} as const;

const updateItemSchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    minProperties: 1,
    properties: {
      ...itemFields,
      // §5.5 and §10: an application-facing "delete" is a status, and an
      // archived item keeps the compliance history hanging off it.
      status: { type: 'string', enum: ['active', 'archived'] },
    },
  },
} as const;

const complianceSchema = {
  body: {
    type: 'object',
    required: ['aircraft_id', 'kind', 'title', 'complied_on'],
    additionalProperties: false,
    properties: {
      aircraft_id: { type: 'string', format: 'uuid' },
      maintenance_item_id: { type: 'string', format: 'uuid' },
      work_order_id: { type: 'string', format: 'uuid' },
      kind: {
        type: 'string',
        enum: ['inspection', 'ad', 'sb', 'overhaul', 'repair', 'other'],
      },
      reference: { type: 'string', maxLength: 100 },
      title: { type: 'string', minLength: 1, maxLength: 200 },
      method: {
        type: 'string',
        enum: ['inspection', 'modification', 'replacement', 'recurring'],
      },
      complied_on: { type: 'string', format: 'date' },
      complied_at_hours: decimal,
      complied_at_cycles: { type: 'integer', minimum: 0 },
      hours_meter: meter,
      next_due_on: { type: 'string', format: 'date' },
      next_due_at_hours: decimal,
      signed_by: { type: 'string', maxLength: 200 },
      signed_certificate: { type: 'string', maxLength: 100 },
      supersedes_id: { type: 'string', format: 'uuid' },
      note: { type: 'string', maxLength: 2000 },
    },
  },
} as const;

const workOrderFields = {
  reference: { type: 'string', maxLength: 100 },
  description: { type: 'string', minLength: 1, maxLength: 4000 },
  performed_by: { type: 'string', maxLength: 200 },
  performed_on: { type: 'string', format: 'date' },
  parts: { type: 'array', maxItems: 200 },
  labor_hours: decimal,
  // §3.7 rule 3: integer minor units. This is not member billing — it is
  // what the tenant paid a shop — but the rule about money is the same rule.
  cost_cents: { type: 'integer', minimum: 0 },
} as const;

const createWorkOrderSchema = {
  body: {
    type: 'object',
    required: ['aircraft_id', 'description'],
    additionalProperties: false,
    properties: {
      aircraft_id: { type: 'string', format: 'uuid' },
      ...workOrderFields,
    },
  },
} as const;

const updateWorkOrderSchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    minProperties: 1,
    properties: {
      ...workOrderFields,
      status: { type: 'string', enum: ['open', 'closed'] },
      signoff_name: { type: 'string', maxLength: 200 },
      signoff_certificate: { type: 'string', maxLength: 100 },
      signoff_kind: {
        type: 'string',
        enum: ['a_and_p', 'ia', 'repairman', 'owner', 'other'],
      },
    },
  },
} as const;

/**
 * The item joined to the resolution the database did for it.
 *
 * The countdown lives in a view rather than in columns because every answer
 * depends on current_date and on meters that advance underneath it — a
 * stored "overdue" flag is wrong the morning after it is written, and wrong
 * silently.
 */
function selectItems(trx: Tx) {
  return trx
    .selectFrom('maintenance_items as i')
    .innerJoin('maintenance_item_status as s', 's.maintenance_item_id', 'i.id')
    .select([
      'i.id',
      'i.aircraft_id',
      'i.name',
      'i.description',
      'i.regulatory_reference',
      'i.status',
      'i.grounds_aircraft',
      'i.due_on',
      'i.due_at_hours',
      'i.due_at_cycles',
      'i.interval_months',
      'i.interval_hours',
      'i.interval_cycles',
      'i.template_code',
      'i.template_version',
      's.hours_meter',
      's.current_hours',
      's.days_remaining',
      's.hours_remaining',
      's.cycles_remaining',
      's.state',
      's.last_complied_on',
      's.ever_complied',
    ]);
}

type ItemRow = Awaited<ReturnType<ReturnType<typeof selectItems>['execute']>>[number];

function toItem(row: ItemRow): MaintenanceItemResponse {
  return row;
}

async function requireAircraft(trx: Tx, aircraftId: string): Promise<void> {
  const row = await trx
    .selectFrom('aircraft')
    .select('id')
    .where('id', '=', aircraftId)
    .executeTakeFirst();
  // §6: an aircraft in another tenant is "not found". The policy already
  // made it invisible; this only turns that into the right status code.
  if (!row) throw new NotFoundError();
}

const PG_SIGNED_RECORD = 'FS409';

export async function maintenanceRoutes(app: FastifyInstance): Promise<void> {
  // -------------------------------------------------------------------------
  // Items
  // -------------------------------------------------------------------------

  /**
   * The fleet view: what is due, worst first. This is the screen a club
   * looks at on a Monday morning, and the one that answers "can we fly this
   * weekend" before anybody drives to the airport.
   */
  app.get<{ Querystring: { aircraft_id?: string; state?: string } }>(
    '/maintenance',
    {
      config: {
        requiresTenant: true,
        feature: 'maintenance_module',
        permission: ['maintenance', 'read'],
      },
    },
    async (request) => {
      const rows = await request.withTenant(async (trx) => {
        let query = selectItems(trx).where('i.status', '=', 'active');
        if (request.query.aircraft_id) {
          query = query.where('i.aircraft_id', '=', request.query.aircraft_id);
        }
        if (request.query.state) {
          query = query.where('s.state', '=', request.query.state as 'overdue');
        }
        return query
          // Overdue, then due soon, then the rest — and within each, the
          // nearest date first. Ordering by name would bury a grounded
          // aeroplane under an oil change.
          .orderBy(
            sql`case s.state when 'overdue' then 0 when 'due_soon' then 1 else 2 end`,
          )
          .orderBy('s.due_on', (ob) => ob.asc().nullsLast())
          .execute();
      });
      return rows.map(toItem);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/aircraft/:id/maintenance-items',
    {
      config: {
        requiresTenant: true,
        feature: 'maintenance_module',
        permission: ['maintenance', 'read'],
      },
    },
    async (request) => {
      const rows = await request.withTenant(async (trx) => {
        await requireAircraft(trx, request.params.id);
        return selectItems(trx)
          .where('i.aircraft_id', '=', request.params.id)
          .orderBy('i.status')
          .orderBy('i.name')
          .execute();
      });
      return rows.map(toItem);
    },
  );

  app.post<{ Params: { id: string }; Body: CreateMaintenanceItemRequest }>(
    '/aircraft/:id/maintenance-items',
    {
      schema: createItemSchema,
      config: {
        requiresTenant: true,
        feature: 'maintenance_module',
        permission: ['maintenance', 'write'],
      },
    },
    async (request, reply) => {
      const body = request.body;
      if (
        body.due_on === undefined &&
        body.due_at_hours === undefined &&
        body.due_at_cycles === undefined
      ) {
        // An item due on nothing never comes due, which makes it a note
        // rather than an inspection. The database says so too; this is a
        // better message than a CHECK violation surfacing as a 500.
        return reply.status(400).send({
          error: 'invalid_request',
          detail: 'an item needs a due date, a due hour reading, or due cycles',
        });
      }

      const row = await request.withTenant(async (trx) => {
        await requireAircraft(trx, request.params.id);
        const created = await trx
          .insertInto('maintenance_items')
          .values({
            tenant_id: request.ctx!.tenantId!,
            aircraft_id: request.params.id,
            name: body.name,
            description: body.description ?? null,
            regulatory_reference: body.regulatory_reference ?? null,
            grounds_aircraft: body.grounds_aircraft ?? false,
            due_on: body.due_on ?? null,
            due_at_hours: body.due_at_hours ?? null,
            due_at_cycles: body.due_at_cycles ?? null,
            hours_meter: body.hours_meter ?? null,
            interval_months: body.interval_months ?? null,
            interval_hours: body.interval_hours ?? null,
            interval_cycles: body.interval_cycles ?? null,
            ...(body.warn_within_days !== undefined
              ? { warn_within_days: body.warn_within_days }
              : {}),
            ...(body.warn_within_hours !== undefined
              ? { warn_within_hours: body.warn_within_hours }
              : {}),
          })
          .returning('id')
          .executeTakeFirstOrThrow();

        return selectItems(trx).where('i.id', '=', created.id).executeTakeFirstOrThrow();
      });

      return reply.status(201).send(toItem(row));
    },
  );

  /**
   * §3.6: adding an aircraft should not mean typing in fifteen intervals.
   *
   * The applicability rules and the copy live in one SQL function so that
   * both test suites and both clients exercise the same implementation. It
   * is idempotent, so the button can be pressed twice.
   */
  app.post<{ Params: { id: string } }>(
    '/aircraft/:id/maintenance-items/from-library',
    {
      config: {
        requiresTenant: true,
        feature: 'maintenance_module',
        permission: ['maintenance', 'write'],
      },
    },
    async (request) => {
      const rows = await request.withTenant(async (trx) => {
        await requireAircraft(trx, request.params.id);
        await sql`SELECT public.instantiate_maintenance_templates(${request.params.id}::uuid)`
          .execute(trx);
        return selectItems(trx)
          .where('i.aircraft_id', '=', request.params.id)
          .where('i.status', '=', 'active')
          .orderBy('i.name')
          .execute();
      });
      return rows.map(toItem);
    },
  );

  app.patch<{ Params: { id: string }; Body: UpdateMaintenanceItemRequest }>(
    '/maintenance-items/:id',
    {
      schema: updateItemSchema,
      config: {
        requiresTenant: true,
        feature: 'maintenance_module',
        permission: ['maintenance', 'write'],
      },
    },
    async (request) => {
      // A tenant's items are their own rows and are freely editable (§3.6).
      // The compliance history behind them is not, which is the line that
      // matters: correcting an interval is bookkeeping, correcting a signed
      // record is not something this product lets anyone do.
      const row = await request.withTenant(async (trx) => {
        const result = await trx
          .updateTable('maintenance_items')
          .set(request.body)
          .where('id', '=', request.params.id)
          .executeTakeFirst();
        if (result.numUpdatedRows === 0n) throw new NotFoundError();
        return selectItems(trx).where('i.id', '=', request.params.id).executeTakeFirst();
      });
      if (!row) throw new NotFoundError();
      return toItem(row);
    },
  );

  /** The library itself, so a tenant can add a preset they were not seeded. */
  app.get(
    '/maintenance/library',
    {
      config: {
        requiresTenant: true,
        feature: 'maintenance_module',
        permission: ['maintenance', 'read'],
      },
    },
    async () => {
      // Reference data (§2.2): no tenant to be in, so it reads the pool
      // directly rather than through withTenant.
      const rows = await app.db
        .selectFrom('maintenance_interval_templates')
        .select([
          'code',
          'version',
          'name',
          'description',
          'regulatory_reference',
          'auto_instantiate',
          'interval_months',
          'interval_hours',
          'hours_meter',
          'grounds_aircraft',
        ])
        .orderBy('name')
        .execute();
      return rows satisfies MaintenanceTemplateResponse[];
    },
  );

  // -------------------------------------------------------------------------
  // Compliance — append-only, and the thing that rolls an item forward
  // -------------------------------------------------------------------------

  app.get<{ Params: { id: string } }>(
    '/aircraft/:id/compliance-records',
    {
      config: {
        requiresTenant: true,
        feature: 'maintenance_module',
        permission: ['maintenance', 'read'],
      },
    },
    async (request) => {
      return request.withTenant(async (trx) => {
        await requireAircraft(trx, request.params.id);
        const rows = await trx
          .selectFrom('compliance_records')
          .selectAll()
          .where('aircraft_id', '=', request.params.id)
          .orderBy('complied_on', 'desc')
          .orderBy('id', 'desc')
          .execute();

        // Superseded rows are labelled, never hidden: the correction and
        // what it corrected are both part of the trail (§3.6).
        const superseded = new Set(
          rows.map((r) => r.supersedes_id).filter((id): id is string => id !== null),
        );
        return rows.map(
          (r): ComplianceRecordResponse => ({
            id: r.id,
            aircraft_id: r.aircraft_id,
            maintenance_item_id: r.maintenance_item_id,
            work_order_id: r.work_order_id,
            kind: r.kind,
            reference: r.reference,
            title: r.title,
            method: r.method,
            complied_on: r.complied_on,
            complied_at_hours: r.complied_at_hours,
            complied_at_cycles: r.complied_at_cycles,
            hours_meter: r.hours_meter,
            next_due_on: r.next_due_on,
            next_due_at_hours: r.next_due_at_hours,
            signed_by: r.signed_by,
            signed_certificate: r.signed_certificate,
            supersedes_id: r.supersedes_id,
            note: r.note,
            recorded_at: r.recorded_at.toISOString(),
            superseded: superseded.has(r.id),
          }),
        );
      });
    },
  );

  /**
   * Recording compliance. The item it names rolls forward in the same
   * transaction, by a trigger rather than by this handler — "the annual was
   * signed, so the next one is due" must not be something a caller can
   * forget, and an item left overdue after its inspection would ground an
   * airworthy aeroplane.
   *
   * There is no update path and no delete path, here or anywhere: a
   * correction is a new record naming the one it supersedes (§3.6).
   */
  app.post<{ Body: CreateComplianceRecordRequest }>(
    '/compliance-records',
    {
      schema: complianceSchema,
      config: {
        requiresTenant: true,
        feature: 'maintenance_module',
        permission: ['maintenance', 'write'],
      },
    },
    async (request, reply) => {
      const body = request.body;
      const created = await request.withTenant(async (trx) => {
        await requireAircraft(trx, body.aircraft_id);
        const row = await trx
          .insertInto('compliance_records')
          .values({
            tenant_id: request.ctx!.tenantId!,
            aircraft_id: body.aircraft_id,
            maintenance_item_id: body.maintenance_item_id ?? null,
            work_order_id: body.work_order_id ?? null,
            kind: body.kind,
            reference: body.reference ?? null,
            title: body.title,
            method: body.method ?? null,
            complied_on: body.complied_on,
            complied_at_hours: body.complied_at_hours ?? null,
            complied_at_cycles: body.complied_at_cycles ?? null,
            hours_meter: body.hours_meter ?? null,
            next_due_on: body.next_due_on ?? null,
            next_due_at_hours: body.next_due_at_hours ?? null,
            signed_by: body.signed_by ?? null,
            signed_certificate: body.signed_certificate ?? null,
            supersedes_id: body.supersedes_id ?? null,
            note: body.note ?? null,
            recorded_by: await ownMembership(trx, request.ctx!.userId),
          })
          .returning(['id', 'recorded_at'])
          .executeTakeFirstOrThrow();

        const item = body.maintenance_item_id
          ? await selectItems(trx)
              .where('i.id', '=', body.maintenance_item_id)
              .executeTakeFirst()
          : undefined;

        return { id: row.id, recorded_at: row.recorded_at.toISOString(), item };
      });

      // The rolled-forward item comes back with the record, so the screen
      // that recorded an annual can show the new due date without a second
      // round trip — and so the client never computes it (§8.2).
      return reply.status(201).send({
        id: created.id,
        recorded_at: created.recorded_at,
        maintenance_item: created.item ? toItem(created.item) : null,
      });
    },
  );

  // -------------------------------------------------------------------------
  // Work orders
  // -------------------------------------------------------------------------

  app.get<{ Querystring: { aircraft_id?: string } }>(
    '/work-orders',
    {
      config: {
        requiresTenant: true,
        feature: 'maintenance_module',
        permission: ['maintenance', 'read'],
      },
    },
    async (request) => {
      const rows = await request.withTenant(async (trx) => {
        let query = trx.selectFrom('work_orders').selectAll();
        if (request.query.aircraft_id) {
          query = query.where('aircraft_id', '=', request.query.aircraft_id);
        }
        return query
          .orderBy('performed_on', (ob) => ob.desc().nullsFirst())
          .orderBy('id', 'desc')
          .execute();
      });
      return rows.map(toWorkOrder);
    },
  );

  app.post<{ Body: CreateWorkOrderRequest }>(
    '/work-orders',
    {
      schema: createWorkOrderSchema,
      config: {
        requiresTenant: true,
        feature: 'maintenance_module',
        permission: ['maintenance', 'write'],
      },
    },
    async (request, reply) => {
      const body = request.body;
      const row = await request.withTenant(async (trx) => {
        await requireAircraft(trx, body.aircraft_id);
        return trx
          .insertInto('work_orders')
          .values({
            tenant_id: request.ctx!.tenantId!,
            aircraft_id: body.aircraft_id,
            reference: body.reference ?? null,
            description: body.description,
            performed_by: body.performed_by ?? null,
            performed_on: body.performed_on ?? null,
            ...(body.parts !== undefined ? { parts: JSON.stringify(body.parts) } : {}),
            labor_hours: body.labor_hours ?? null,
            cost_cents: body.cost_cents ?? null,
            created_by: request.ctx!.userId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
      });
      return reply.status(201).send(toWorkOrder(row));
    },
  );

  /**
   * Editing, and signing, which are the same request shape and very much not
   * the same act: supplying a signoff closes the record to every further
   * edit. A correction after that is a new work order, because a signature
   * is not revisable.
   */
  app.patch<{ Params: { id: string }; Body: UpdateWorkOrderRequest }>(
    '/work-orders/:id',
    {
      schema: updateWorkOrderSchema,
      config: {
        requiresTenant: true,
        feature: 'maintenance_module',
        permission: ['maintenance', 'write'],
      },
    },
    async (request) => {
      const { parts, signoff_name: name, signoff_kind: kind, ...rest } = request.body;
      const signing = name !== undefined || kind !== undefined;
      if (signing && (name === undefined || kind === undefined)) {
        throw new ConflictError('a signoff needs both a name and a kind');
      }

      try {
        const row = await request.withTenant(async (trx) => {
          const updated = await trx
            .updateTable('work_orders')
            .set({
              ...rest,
              ...(parts !== undefined ? { parts: JSON.stringify(parts) } : {}),
              ...(signing
                ? {
                    signoff_name: name,
                    signoff_kind: kind,
                    // The date is the server's, not the client's: a
                    // signature's timestamp is not something a caller gets
                    // to assert.
                    signed_at: new Date(),
                    status: 'closed' as const,
                  }
                : {}),
            })
            .where('id', '=', request.params.id)
            .returningAll()
            .executeTakeFirst();
          if (!updated) throw new NotFoundError();
          return updated;
        });
        return toWorkOrder(row);
      } catch (error) {
        if ((error as { code?: unknown }).code === PG_SIGNED_RECORD) {
          throw new ConflictError(
            'that work order is signed and cannot be edited; record a correcting one',
          );
        }
        throw error;
      }
    },
  );
}

function toWorkOrder(row: {
  id: string;
  aircraft_id: string;
  reference: string | null;
  description: string;
  performed_by: string | null;
  performed_on: string | null;
  parts: unknown;
  labor_hours: string | null;
  cost_cents: number | null;
  currency: string;
  status: 'open' | 'closed';
  signoff_name: string | null;
  signoff_certificate: string | null;
  signoff_kind: WorkOrderResponse['signoff_kind'];
  signed_at: Date | null;
}): WorkOrderResponse {
  return { ...row, signed_at: row.signed_at?.toISOString() ?? null };
}

/** Exported for the fleet routes, which answer §3.3's question about booking. */
export function selectAvailability(trx: Tx) {
  return trx
    .selectFrom('aircraft_availability')
    .select([
      'aircraft_id',
      'registration',
      'aircraft_status',
      'available',
      'grounding_squawks',
      'overdue_grounding_items',
      'grounding_reasons',
    ]);
}

export function toAvailability(row: {
  aircraft_id: string;
  registration: string;
  aircraft_status: AircraftAvailabilityResponse['aircraft_status'];
  available: boolean;
  grounding_squawks: string;
  overdue_grounding_items: string;
  grounding_reasons: string[];
}): AircraftAvailabilityResponse {
  return {
    aircraft_id: row.aircraft_id,
    registration: row.registration,
    aircraft_status: row.aircraft_status,
    available: row.available,
    // count() comes back as bigint, which node-postgres hands over as a
    // string rather than silently losing precision. It is a handful of
    // squawks; Number is safe and the wire shape says number.
    grounding_squawks: Number(row.grounding_squawks),
    overdue_grounding_items: Number(row.overdue_grounding_items),
    grounding_reasons: row.grounding_reasons,
  };
}
