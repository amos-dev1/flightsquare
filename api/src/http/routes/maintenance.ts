import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import type {
  AircraftAvailabilityResponse,
  BookingMaintenanceCheckResponse,
  CompletionResponse,
  CreateCompletionRequest,
  GroundingOverrideRequest,
  GroundingOverrideResponse,
  MaintenanceItemHistoryResponse,
  MaintenanceSummaryResponse,
  PreviewMaintenanceRequest,
  PreviewMaintenanceResponse,
  VoidCompletionRequest,
  MaintenanceRuleInput,
  MaintenanceRuleKind,
  MaintenanceRuleResponse,
  MaintenanceState,
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
import { previewRules } from '../../maintenance/intervals.js';
import { ConflictError, InvalidRequestError, NotFoundError } from '../errors.js';
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

/** §4.2: up to three, combined whichever-comes-first. More than three is not a
 *  richer item, it is a form nobody can read. */
const itemFieldsRules = {
  type: 'array',
  minItems: 1,
  maxItems: 3,
  items: {
    type: 'object',
    required: ['kind'],
    additionalProperties: false,
    properties: {
      kind: {
        type: 'string',
        enum: ['tach_hr', 'hobbs_hr', 'airframe_hr', 'cycles',
               'cal_month', 'cal_day', 'fixed_date'],
        },
      every: decimal,
      end_of_month: { type: 'boolean' },
      fixed_date: { type: 'string', format: 'date' },
      anchor_on: { type: 'string', format: 'date' },
      anchor_hours: decimal,
      anchor_cycles: { type: 'integer', minimum: 0 },
      warn_at: decimal,
      critical_at: decimal,
    },
  },
} as const;

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
  category: { type: 'string', enum: ['airframe', 'engine', 'prop', 'avionics', 'other'] },
  position: { type: 'string', maxLength: 50 },
  restriction_label: { type: 'string', maxLength: 100 },
  tolerance_hours: decimal,
  next_from: { type: 'string', enum: ['completion', 'previous_due'] },
  rules: itemFieldsRules,
} as const;


const completionSchema = {
  body: {
    type: 'object',
    required: ['done_on'],
    additionalProperties: false,
    properties: {
      // §4.7: dates are frequently in the past, because work is logged days
      // after it was done. Nothing here refuses one.
      done_on: { type: 'string', format: 'date' },
      tach: decimal,
      hobbs: decimal,
      performed_by: { type: 'string', maxLength: 200 },
      cert_no: { type: 'string', maxLength: 100 },
      notes: { type: 'string', maxLength: 2000 },
      next_from: { type: 'string', enum: ['completion', 'previous_due'] },
    },
  },
} as const;

const voidSchema = {
  body: {
    type: 'object',
    required: ['reason'],
    additionalProperties: false,
    // A reason, and one somebody typed: taking back a signed inspection is not
    // something "oops" is a record of.
    properties: { reason: { type: 'string', minLength: 5, maxLength: 500 } },
  },
} as const;

const overrideSchema = {
  body: {
    type: 'object',
    required: ['reason', 'until'],
    additionalProperties: false,
    properties: {
      // §4.5 asks for a typed reason, and means typed: "ok" is not a record of
      // why an aeroplane flew against an overdue inspection.
      reason: { type: 'string', minLength: 10, maxLength: 500 },
      until: { type: 'string', format: 'date-time' },
      maintenance_item_id: { type: 'string', format: 'uuid' },
    },
  },
} as const;

const previewSchema = {
  body: {
    type: 'object',
    required: ['aircraft_id', 'rules'],
    additionalProperties: false,
    properties: {
      aircraft_id: { type: 'string', format: 'uuid' },
      rules: itemFieldsRules,
      anchor_on: { type: 'string', format: 'date' },
      anchor_hours: decimal,
      anchor_cycles: { type: 'integer', minimum: 0 },
      tolerance_hours: decimal,
    },
  },
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
      's.governing_rule_id',
      's.governing_kind',
      's.governing_remaining',
      's.projected_date',
      'i.category',
      'i.restriction_label',
      'i.tolerance_hours',
      'i.next_from',
    ]);
}

type ItemRow = Awaited<ReturnType<ReturnType<typeof selectItems>['execute']>>[number];

/**
 * Every rule for a set of items, in one query.
 *
 * One query rather than one per item: the maintenance home lists a whole
 * fleet's items and each has up to three rules, which is an N+1 that grows
 * with the club.
 */
async function rulesFor(trx: Tx, itemIds: string[]): Promise<Map<string, MaintenanceRuleResponse[]>> {
  const byItem = new Map<string, MaintenanceRuleResponse[]>();
  if (itemIds.length === 0) return byItem;

  const rows = await trx
    .selectFrom('maintenance_rule_status')
    .select([
      'rule_id',
      'maintenance_item_id',
      'kind',
      'every',
      'end_of_month',
      'due_on',
      'due_at_hours',
      'due_at_cycles',
      'warn_at',
      'critical_at',
      'remaining',
      'state',
      'projected_date',
    ])
    .where('maintenance_item_id', 'in', itemIds)
    .orderBy('kind')
    .execute();

  for (const row of rows) {
    const list = byItem.get(row.maintenance_item_id) ?? [];
    list.push({
      id: row.rule_id,
      kind: row.kind,
      every: row.every,
      end_of_month: row.end_of_month,
      due_on: row.due_on,
      due_at_hours: row.due_at_hours,
      due_at_cycles: row.due_at_cycles,
      warn_at: row.warn_at,
      critical_at: row.critical_at,
      remaining: row.remaining,
      state: row.state,
      projected_date: row.projected_date,
    });
    byItem.set(row.maintenance_item_id, list);
  }
  return byItem;
}

async function toItems(trx: Tx, rows: ItemRow[]): Promise<MaintenanceItemResponse[]> {
  const rules = await rulesFor(trx, rows.map((row) => row.id));
  return rows.map((row) => ({ ...row, rules: rules.get(row.id) ?? [] }));
}

async function toItem(trx: Tx, row: ItemRow): Promise<MaintenanceItemResponse> {
  return (await toItems(trx, [row]))[0]!;
}

/**
 * Write an item's rules, replacing whatever was there.
 *
 * Replace rather than merge: a form that sends two rules means the item has
 * two, and reconciling "which of these is the one I already had" through a
 * client that may be six months old (§8.1) is a guess nobody needs to make.
 *
 * The old `interval_*` and `due_*` fields still work — a shipped build posts
 * them — and translate to one rule each, exactly as 0023's backfill did.
 */
/**
 * The soonest due point a set of rules implies, before any row exists.
 *
 * `writeRules` works this out per rule and `restate_item_due_points` reduces it
 * to the item — but the item's CHECK requires a due point at the moment it is
 * inserted, which is before either has run. Same function, one step earlier.
 */
async function impliedDuePoints(
  trx: Tx,
  drafts: MaintenanceRuleInput[],
  anchor: { on: string | null; hours: string | null; cycles: number | null },
): Promise<{ on: string | null; hours: string | null; cycles: number | null }> {
  let on: string | null = null;
  let hours: string | null = null;
  let cycles: number | null = null;

  for (const draft of drafts) {
    const due = await sql<{
      due_on: string | null;
      due_at_hours: string | null;
      due_at_cycles: number | null;
    }>`
      SELECT * FROM public.next_due_for(
        ${draft.kind}, ${draft.every ?? null}::numeric, ${draft.end_of_month ?? false},
        ${draft.anchor_on ?? anchor.on ?? null}::date,
        ${draft.anchor_hours ?? anchor.hours ?? null}::numeric,
        ${draft.anchor_cycles ?? anchor.cycles ?? null}::integer)
    `.execute(trx);
    const next = due.rows[0];
    if (!next) continue;

    // A fixed date is its own due point and does not roll forward.
    const dueOn = draft.kind === 'fixed_date' ? (draft.fixed_date ?? null) : next.due_on;

    // The earliest wins, which is §3.6's rule for an item on several bases.
    if (dueOn !== null && (on === null || dueOn < on)) on = dueOn;
    if (next.due_at_hours !== null && (hours === null || Number(next.due_at_hours) < Number(hours))) {
      hours = next.due_at_hours;
    }
    if (next.due_at_cycles !== null && (cycles === null || next.due_at_cycles < cycles)) {
      cycles = next.due_at_cycles;
    }
  }

  return { on, hours, cycles };
}

async function writeRules(
  trx: Tx,
  tenantId: string,
  itemId: string,
  body: CreateMaintenanceItemRequest | UpdateMaintenanceItemRequest,
  anchor: { on?: string | null; hours?: string | null; cycles?: number | null },
): Promise<void> {
  const drafts: MaintenanceRuleInput[] = [];
  if (body.rules) {
    drafts.push(...body.rules);
  } else {
    // The fields that predate rules, one rule each — exactly as 0023's
    // backfill translated them.
    if (body.interval_months != null) {
      drafts.push({
        kind: 'cal_month',
        every: String(body.interval_months),
        // A caller that wants calendar months says so. These fields never
        // carried the distinction, and assuming it would roll an oil change
        // to the end of the month for no reason.
        end_of_month: false,
        warn_at: String(body.warn_within_days ?? 30),
      });
    }
    if (body.interval_hours) {
      drafts.push({
        kind:
          body.hours_meter === 'hobbs' ? 'hobbs_hr'
          : body.hours_meter === 'airframe' ? 'airframe_hr'
          : 'tach_hr',
        every: body.interval_hours,
        warn_at: body.warn_within_hours ?? '10.0',
      });
    }
    if (body.interval_cycles != null) {
      drafts.push({ kind: 'cycles', every: String(body.interval_cycles), warn_at: '25' });
    }
  }

  // Nothing to say about the rules: leave them exactly as they are. A PATCH
  // that only renames an item must not silently drop its intervals.
  if (drafts.length === 0) return;

  await trx.deleteFrom('maintenance_item_rules').where('maintenance_item_id', '=', itemId).execute();

  for (const draft of drafts) {
    const warnAt = draft.warn_at ?? defaultWarn(draft.kind);
    // The due point comes from the same function the completion trigger uses,
    // so an item created today and an item completed today land identically.
    const due = await sql<{
      due_on: string | null;
      due_at_hours: string | null;
      due_at_cycles: number | null;
    }>`
      SELECT * FROM public.next_due_for(
        ${draft.kind}, ${draft.every ?? null}::numeric, ${draft.end_of_month ?? false},
        ${draft.anchor_on ?? anchor.on ?? null}::date,
        ${draft.anchor_hours ?? anchor.hours ?? null}::numeric,
        ${draft.anchor_cycles ?? anchor.cycles ?? null}::integer)
    `.execute(trx);
    const next = due.rows[0]!;

    await trx
      .insertInto('maintenance_item_rules')
      .values({
        tenant_id: tenantId,
        maintenance_item_id: itemId,
        kind: draft.kind,
        every: draft.every ?? null,
        end_of_month: draft.end_of_month ?? false,
        fixed_date: draft.fixed_date ?? null,
        // A fixed date is its own due point and does not roll forward.
        due_on: draft.kind === 'fixed_date' ? (draft.fixed_date ?? null) : next.due_on,
        due_at_hours: next.due_at_hours,
        due_at_cycles: next.due_at_cycles,
        warn_at: warnAt,
        critical_at: draft.critical_at ?? defaultCritical(draft.kind, warnAt),
      })
      .execute();
  }

  // The item's own due columns are the soonest of its rules. Everything
  // downstream still reads them: 0017's notice trigger, the due index, and
  // the response above.
  await sql`SELECT public.restate_item_due_points(${itemId}::uuid)`.execute(trx);
}

/**
 * The parts of a request body that are actually columns on the item.
 *
 * `rules` is a child table and the due points are derived from it, so handing
 * the whole body to `.set()` would both fail on the one and lie with the other.
 */
function columnsOf(
  body: UpdateMaintenanceItemRequest,
): Record<string, unknown> {
  const { rules: _rules, due_on: _on, due_at_hours: _hours, due_at_cycles: _cycles,
          ...columns } = body;
  return columns;
}

/**
 * What actually moved between two snapshots of a row.
 *
 * The log stores whole rows, because a trigger cannot know in advance which
 * columns will matter. A reader can: showing them thirty unchanged fields to
 * find the one that moved is how a log stops being read.
 */
function changedFields(
  before: unknown,
  after: unknown,
): Record<string, { from: unknown; to: unknown }> {
  const from = (before ?? {}) as Record<string, unknown>;
  const to = (after ?? {}) as Record<string, unknown>;
  const changed: Record<string, { from: unknown; to: unknown }> = {};

  for (const key of new Set([...Object.keys(from), ...Object.keys(to)])) {
    // Housekeeping, not a change anybody made.
    if (key === 'updated_at' || key === 'created_at') continue;
    if (JSON.stringify(from[key]) !== JSON.stringify(to[key])) {
      changed[key] = { from: from[key] ?? null, to: to[key] ?? null };
    }
  }
  return changed;
}

/** §4.4's states, worst first — the same order the status view ranks them in. */
const SEVERITY = ['overdue', 'due_soon', 'upcoming', 'ok', 'inactive'] as const;

function worstState(states: MaintenanceState[]): MaintenanceState {
  for (const state of SEVERITY) {
    if (states.includes(state)) return state;
  }
  return 'ok';
}

/** §4.4's defaults, which a caller may override per rule. */
function defaultWarn(kind: MaintenanceRuleKind): string {
  return kind === 'cycles' ? '25'
    : kind === 'tach_hr' || kind === 'hobbs_hr' || kind === 'airframe_hr' ? '10.0'
    : '30';
}

function defaultCritical(kind: MaintenanceRuleKind, warnAt: string): string {
  const floor =
    kind === 'cycles' ? 10
    : kind === 'tach_hr' || kind === 'hobbs_hr' || kind === 'airframe_hr' ? 3
    : 7;
  // Never above the warning: a critical threshold wider than its warning
  // would mean the item went orange before it went amber.
  return String(Math.min(Number(warnAt), floor));
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
        permission: ['maintenance.items', 'read'],
      },
    },
    async (request) => {
      const items: MaintenanceItemResponse[] = await request.withTenant(async (trx) => {
        let query = selectItems(trx).where('i.status', '=', 'active');
        if (request.query.aircraft_id) {
          query = query.where('i.aircraft_id', '=', request.query.aircraft_id);
        }
        if (request.query.state) {
          query = query.where('s.state', '=', request.query.state as 'overdue');
        }
        const rows = await query
          // Overdue, then due soon, then upcoming, then the rest — and within
          // each, the nearest date first. Ordering by name would bury a
          // grounded aeroplane under an oil change.
          .orderBy(
            sql`case s.state when 'overdue' then 0 when 'due_soon' then 1
                             when 'upcoming' then 2 else 3 end`,
          )
          .orderBy('s.due_on', (ob) => ob.asc().nullsLast())
          .execute();
        return toItems(trx, rows);
      });
      return items;
    },
  );

  /**
   * One item, resolved (mockup 04).
   *
   * The list endpoint already returns everything this does, and a detail screen
   * reached from a notification has an item id and no aircraft id — asking for
   * the fleet's worth of items to find one of them is how a deep link gets slow
   * on a tiedown. Additive, per §8.1: nothing changed shape to make room.
   */
  app.get<{ Params: { id: string } }>(
    '/maintenance-items/:id',
    {
      config: {
        requiresTenant: true,
        feature: 'maintenance_module',
        permission: ['maintenance.items', 'read'],
      },
    },
    async (request) => {
      return request.withTenant<MaintenanceItemResponse>(async (trx) => {
        // No tenant predicate: RLS put one there (§1.1). An id from another
        // club resolves to nothing, which is the 404 §6 asks for — "not found",
        // never "not yours".
        const row = await selectItems(trx).where('i.id', '=', request.params.id).executeTakeFirst();
        if (!row) throw new NotFoundError();
        return toItem(trx, row);
      });
    },
  );

  /**
   * What has been logged against this item, including what was taken back.
   *
   * Voided records are labelled and never hidden, for the same reason
   * superseded ones are not (§3.6): the trail is the point, and a completion
   * that was retracted is part of it. The screen greys the row and says why
   * rather than losing it.
   */
  app.get<{ Params: { id: string } }>(
    '/maintenance-items/:id/completions',
    {
      config: {
        requiresTenant: true,
        feature: 'maintenance_module',
        permission: ['maintenance.items', 'read'],
      },
    },
    async (request) => {
      return request.withTenant<ComplianceRecordResponse[]>(async (trx) => {
        const item = await trx
          .selectFrom('maintenance_items')
          .select('id')
          .where('id', '=', request.params.id)
          .executeTakeFirst();
        if (!item) throw new NotFoundError();

        const rows = await trx
          .selectFrom('compliance_records as c')
          .leftJoin('compliance_voids as v', 'v.compliance_record_id', 'c.id')
          .leftJoin('compliance_records as later', 'later.supersedes_id', 'c.id')
          .selectAll('c')
          .select(['v.reason as void_reason', 'later.id as superseded_by'])
          .where('c.maintenance_item_id', '=', request.params.id)
          .orderBy('c.complied_on', 'desc')
          .orderBy('c.recorded_at', 'desc')
          .execute();

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
            superseded: r.superseded_by !== null,
            voided: r.void_reason !== null,
            void_reason: r.void_reason,
          }),
        );
      });
    },
  );

  app.get<{ Params: { id: string } }>(
    '/aircraft/:id/maintenance-items',
    {
      config: {
        requiresTenant: true,
        feature: 'maintenance_module',
        permission: ['maintenance.items', 'read'],
      },
    },
    async (request) => {
      const items: MaintenanceItemResponse[] = await request.withTenant(async (trx) => {
        await requireAircraft(trx, request.params.id);
        const rows = await selectItems(trx)
          .where('i.aircraft_id', '=', request.params.id)
          .orderBy('i.status')
          .orderBy('i.name')
          .execute();
        return toItems(trx, rows);
      });
      return items;
    },
  );

  /**
   * Logging a completion, from the sheet rather than from the record (§4.7).
   *
   * `POST /compliance-records` already does this and stays — it takes the
   * regulatory shape, with AD references and signatures. This takes mockup 05's
   * shape: a date, the meters, who did it, and whether the next interval runs
   * from here or from the due point it was meant to happen at.
   *
   * It returns the rolled-forward item, so the screen that logged an annual can
   * show the new due date without a second call and without computing it
   * (§8.2).
   */
  app.post<{ Params: { id: string }; Body: CreateCompletionRequest }>(
    '/maintenance-items/:id/completions',
    {
      schema: completionSchema,
      config: {
        requiresTenant: true,
        feature: 'maintenance_module',
        permission: ['maintenance.items', 'write'],
      },
    },
    async (request, reply) => {
      const body = request.body;

      const result = await request.withTenant(async (trx) => {
        const item = await trx
          .selectFrom('maintenance_items')
          .select(['id', 'aircraft_id', 'name', 'hours_meter', 'next_from'])
          .where('id', '=', request.params.id)
          .executeTakeFirst();
        if (!item) throw new NotFoundError();

        // §4.7 lets the sheet choose, and the choice belongs on the item
        // because it governs every rule the completion rolls forward.
        if (body.next_from && body.next_from !== item.next_from) {
          await trx
            .updateTable('maintenance_items')
            .set({ next_from: body.next_from })
            .where('id', '=', item.id)
            .execute();
        }

        // Which meter this item counts on decides which number is *its*
        // compliance reading; the other is recorded on the record all the same.
        const meter = item.hours_meter ?? 'tach';
        const created = await trx
          .insertInto('compliance_records')
          .values({
            tenant_id: request.ctx!.tenantId!,
            aircraft_id: item.aircraft_id,
            maintenance_item_id: item.id,
            kind: 'inspection',
            title: item.name,
            complied_on: body.done_on,
            complied_at_hours:
              (meter === 'hobbs' ? body.hobbs : body.tach) ?? body.tach ?? null,
            hours_meter: meter,
            signed_by: body.performed_by ?? null,
            signed_certificate: body.cert_no ?? null,
            note: body.notes ?? null,
            recorded_by: await ownMembership(trx, request.ctx!.userId),
          })
          .returning(['id', 'recorded_at'])
          .executeTakeFirstOrThrow();

        const saved = await selectItems(trx)
          .where('i.id', '=', item.id)
          .executeTakeFirstOrThrow();

        return { created, item: await toItem(trx, saved) };
      });

      return reply.status(201).send({
        id: result.created.id,
        recorded_at: result.created.recorded_at.toISOString(),
        maintenance_item: result.item,
      } satisfies CompletionResponse);
    },
  );

  /**
   * Taking a completion back (§4.7, §13: "voiding the latest completion
   * restores the previous anchor").
   *
   * Not a delete and not an edit: `compliance_records` holds SELECT and INSERT
   * and nothing else, because §3.6 makes it the table read back after an
   * accident. The void is its own append-only fact, and the item is rebuilt
   * from the latest record that is neither superseded nor voided.
   */
  app.post<{ Params: { id: string }; Body: VoidCompletionRequest }>(
    '/maintenance-completions/:id/void',
    {
      schema: voidSchema,
      config: {
        requiresTenant: true,
        feature: 'maintenance_module',
        permission: ['maintenance.items', 'write'],
      },
    },
    async (request) => {
      return request.withTenant(async (trx) => {
        const record = await trx
          .selectFrom('compliance_records')
          .select(['id', 'maintenance_item_id'])
          .where('id', '=', request.params.id)
          .executeTakeFirst();
        if (!record?.maintenance_item_id) throw new NotFoundError();

        await trx
          .insertInto('compliance_voids')
          .values({
            tenant_id: request.ctx!.tenantId!,
            compliance_record_id: record.id,
            reason: request.body.reason,
            voided_by: await ownMembership(trx, request.ctx!.userId),
          })
          .execute()
          .catch((error: unknown) => {
            // The unique constraint: voiding twice is not twice as void.
            if ((error as { code?: string }).code === '23505') {
              throw new ConflictError('that completion has already been voided');
            }
            throw error;
          });

        await sql`SELECT public.recompute_item_from_compliance(${record.maintenance_item_id}::uuid)`
          .execute(trx);

        const saved = await selectItems(trx)
          .where('i.id', '=', record.maintenance_item_id)
          .executeTakeFirstOrThrow();
        return toItem(trx, saved);
      });
    },
  );

  /**
   * §4.5's override: fly it anyway, for a reason and until a time.
   *
   * `maintenance.items: write`, because deciding an aeroplane may fly against
   * an overdue inspection is the sharpest end of signing off work — and the
   * one judgement in the module that the app most explicitly does not make
   * (§1 principle 2: the app advises, the A&P decides).
   *
   * It is an event, not a setting. The expiry is required and bounded, so the
   * aeroplane returns to the honest answer by itself rather than when somebody
   * remembers.
   */
  app.post<{ Params: { id: string }; Body: GroundingOverrideRequest }>(
    '/aircraft/:id/grounding/override',
    {
      schema: overrideSchema,
      config: {
        requiresTenant: true,
        feature: 'maintenance_module',
        permission: ['maintenance.items', 'write'],
      },
    },
    async (request, reply) => {
      const until = new Date(request.body.until);
      if (Number.isNaN(until.getTime()) || until <= new Date()) {
        return reply.status(400).send({
          error: 'invalid_request',
          detail: 'an override has to end in the future',
        });
      }
      // A month is longer than any ferry permit and shorter than forgetting.
      // An override that outlives the problem is the thing this must not be.
      const horizon = new Date(Date.now() + 30 * 86_400_000);
      if (until > horizon) {
        return reply.status(400).send({
          error: 'invalid_request',
          detail: 'an override can run for at most 30 days; set a nearer date and renew it',
        });
      }

      const result = await request.withTenant(async (trx) => {
        await requireAircraft(trx, request.params.id);

        if (request.body.maintenance_item_id) {
          const item = await trx
            .selectFrom('maintenance_items')
            .select('id')
            .where('id', '=', request.body.maintenance_item_id)
            .where('aircraft_id', '=', request.params.id)
            .executeTakeFirst();
          if (!item) throw new NotFoundError();
        }

        const created = await trx
          .insertInto('maintenance_grounding_events')
          .values({
            tenant_id: request.ctx!.tenantId!,
            aircraft_id: request.params.id,
            cause: request.body.maintenance_item_id ? 'item' : 'manual',
            maintenance_item_id: request.body.maintenance_item_id ?? null,
            override_reason: request.body.reason,
            override_until: until,
            override_by: await ownMembership(trx, request.ctx!.userId),
          })
          .returning(['id', 'override_until'])
          .executeTakeFirstOrThrow();

        // The dispatch state as it now stands, from the one view that decides
        // it — so the screen that pressed the button needs no second call and
        // cannot draw a different conclusion from the booking path.
        const dispatch = await selectAvailability(trx)
          .where('aircraft_id', '=', request.params.id)
          .executeTakeFirstOrThrow();

        return { created, dispatch };
      });

      return reply.status(201).send({
        id: result.created.id,
        aircraft_id: request.params.id,
        reason: request.body.reason,
        until: result.created.override_until!.toISOString(),
        available: result.dispatch.available,
        grounding_reasons: result.dispatch.grounding_reasons,
      } satisfies GroundingOverrideResponse);
    },
  );

  /**
   * What changed on an item, and who changed it (§7).
   *
   * `maintenance.items: read` — this is the record, which is the half a pilot
   * does not hold. Only the fields that actually moved are reported: a diff of
   * two whole rows is something nobody reads, and a log nobody reads is not a
   * log.
   */
  app.get<{ Params: { id: string } }>(
    '/maintenance-items/:id/history',
    {
      config: {
        requiresTenant: true,
        feature: 'maintenance_module',
        permission: ['maintenance.items', 'read'],
      },
    },
    async (request) => {
      return request.withTenant(async (trx) => {
        const item = await trx
          .selectFrom('maintenance_items')
          .select('id')
          .where('id', '=', request.params.id)
          .executeTakeFirst();
        if (!item) throw new NotFoundError();

        const rows = await trx
          .selectFrom('maintenance_item_history as h')
          .leftJoin('memberships as m', 'm.id', 'h.actor')
          .leftJoin('users as u', 'u.id', 'm.user_id')
          .select(['h.id', 'h.action', 'h.before', 'h.after', 'h.at', 'u.email as actor_email'])
          .where('h.maintenance_item_id', '=', request.params.id)
          .orderBy('h.at', 'desc')
          .orderBy('h.id', 'desc')
          .limit(200)
          .execute();

        return rows.map((row) => ({
          id: row.id,
          action: row.action,
          actor_email: row.actor_email,
          at: row.at.toISOString(),
          changed: changedFields(row.before, row.after),
        })) satisfies MaintenanceItemHistoryResponse[];
      });
    },
  );

  /**
   * What a rule would be, for a form nobody has saved (SPEC §8).
   *
   * Drives the live footer in mockups 03 and 05. §13 requires it to match what
   * saving produces, and it does by construction rather than by agreement: this
   * and the completion trigger call the same two database functions.
   *
   * A POST because it carries a body, not because it changes anything — and
   * `maintenance.items: write`, because the only people who see it are the ones
   * who are about to save.
   */
  app.post<{ Body: PreviewMaintenanceRequest }>(
    '/maintenance-items/preview',
    {
      schema: previewSchema,
      config: {
        requiresTenant: true,
        feature: 'maintenance_module',
        permission: ['maintenance.items', 'write'],
      },
    },
    async (request) => {
      const body = request.body;

      const result = await request.withTenant(async (trx) => {
        const aircraft = await trx
          .selectFrom('aircraft as a')
          .leftJoin('tenants as t', 't.id', 'a.tenant_id')
          .select([
            'a.tach', 'a.hobbs', 'a.airframe_hours', 'a.cycles',
            // §4.2: the aeroplane's own today, never the server's.
            sql<string>`(now() AT TIME ZONE coalesce(a.timezone, t.timezone, 'UTC'))::date`
              .as('today'),
          ])
          .where('a.id', '=', body.aircraft_id)
          .executeTakeFirst();
        if (!aircraft) throw new NotFoundError();

        return previewRules(
          trx,
          body.rules.map((rule) => ({
            kind: rule.kind,
            every: rule.every ?? null,
            end_of_month: rule.end_of_month ?? false,
            fixed_date: rule.fixed_date ?? null,
            anchor_on: rule.anchor_on ?? null,
            anchor_hours: rule.anchor_hours ?? null,
            anchor_cycles: rule.anchor_cycles ?? null,
            warn_at: rule.warn_at ?? defaultWarn(rule.kind),
            critical_at:
              rule.critical_at ?? defaultCritical(rule.kind, rule.warn_at ?? defaultWarn(rule.kind)),
          })),
          {
            on: body.anchor_on ?? null,
            hours: body.anchor_hours ?? null,
            cycles: body.anchor_cycles ?? null,
          },
          {
            tach: aircraft.tach,
            hobbs: aircraft.hobbs,
            airframe_hours: aircraft.airframe_hours,
            cycles: aircraft.cycles,
            today: aircraft.today,
          },
          body.tolerance_hours ?? null,
        );
      });

      return {
        rules: result.map((rule) => ({
          kind: rule.kind,
          due_on: rule.due_on,
          due_at_hours: rule.due_at_hours,
          due_at_cycles: rule.due_at_cycles,
          remaining: rule.remaining,
          state: rule.state,
        })),
        // The worst of them, which is what the footer leads with — the same
        // rule the saved item would report as governing.
        state: worstState(result.map((rule) => rule.state)),
      } satisfies PreviewMaintenanceResponse;
    },
  );

  /**
   * What a pilot is told (SPEC §3, §5 screen 02).
   *
   * `maintenance.summary: read`, which is the half of maintenance a pilot
   * holds. Everything here answers "may I fly it, and what is coming up" and
   * nothing answers "what was done to it" — no history, no notes, no rules, and
   * five items rather than the list.
   */
  app.get<{ Params: { id: string } }>(
    '/aircraft/:id/maintenance/summary',
    {
      config: {
        requiresTenant: true,
        feature: 'maintenance_module',
        permission: ['maintenance.summary', 'read'],
      },
    },
    async (request) => {
      return request.withTenant(async (trx) => {
        const aircraft = await trx
          .selectFrom('aircraft')
          .select(['id', 'registration', 'tach', 'hobbs', 'totals_updated_at'])
          .where('id', '=', request.params.id)
          .executeTakeFirst();
        if (!aircraft) throw new NotFoundError();

        // §3.3: the one view three causes resolve into. The summary reports it
        // rather than re-deciding, so a pilot and the booking path can never
        // disagree about whether the aeroplane flies.
        const dispatch = await selectAvailability(trx)
          .where('aircraft_id', '=', request.params.id)
          .executeTakeFirst();

        const items = await trx
          .selectFrom('maintenance_item_status')
          .select([
            'maintenance_item_id', 'name', 'state', 'governing_kind',
            'governing_remaining', 'due_on', 'ever_complied', 'restriction_label',
          ])
          .where('aircraft_id', '=', request.params.id)
          .where('status', '=', 'active')
          .orderBy(
            sql`case state when 'overdue' then 0 when 'due_soon' then 1
                           when 'upcoming' then 2 else 3 end`,
          )
          .orderBy('due_on', (ob) => ob.asc().nullsLast())
          .execute();

        return {
          aircraft_id: aircraft.id,
          registration: aircraft.registration,
          available: dispatch?.available ?? true,
          grounding_reasons: dispatch?.grounding_reasons ?? [],
          // §4.5: a lapsed pitot-static does not stop the aeroplane flying, it
          // stops it flying IFR. Said as a restriction, never as a grounding.
          restrictions: items
            .filter((item) => item.state === 'overdue' && item.restriction_label)
            .map((item) => item.restriction_label!),
          tach: aircraft.tach,
          hobbs: aircraft.hobbs,
          totals_updated_at: aircraft.totals_updated_at?.toISOString() ?? null,
          upcoming: items.slice(0, 5).map((item) => ({
            id: item.maintenance_item_id,
            name: item.name,
            state: item.state,
            governing_kind: item.governing_kind,
            governing_remaining: item.governing_remaining,
            due_on: item.due_on,
            ever_complied: item.ever_complied,
          })),
        } satisfies MaintenanceSummaryResponse;
      });
    },
  );

  /**
   * SPEC §4.6: would a booking of this many hours take the aeroplane past
   * something?
   *
   * **Warn only.** The one thing that refuses a booking is
   * `aircraft_availability`, and it answers a different question — whether the
   * aeroplane is dispatchable now. This is about a block of time that has not
   * happened yet, and the honest response is to say so and let the member book:
   * a club pilot taking the 172 for three hours when the oil change is two out
   * may well be flying it to the shop.
   *
   * `reservations: read` rather than `maintenance.items`, because the question
   * belongs to the booking path and a pilot holds nothing on the record (§1.5).
   * It discloses nothing new: the summary endpoint a pilot already holds names
   * the same items.
   */
  app.get<{ Params: { id: string }; Querystring: { hours?: string } }>(
    '/aircraft/:id/bookings/check',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['hours'],
          properties: { hours: decimal },
        },
      },
      config: {
        requiresTenant: true,
        feature: 'maintenance_module',
        permission: ['reservations', 'read'],
      },
    },
    async (request) => {
      const hours = request.query.hours ?? '0';

      return request.withTenant<BookingMaintenanceCheckResponse>(async (trx) => {
        await requireAircraft(trx, request.params.id);

        const { rows } = await sql<{
          id: string;
          name: string;
          kind: MaintenanceRuleKind;
          remaining: string;
          grounds_aircraft: boolean;
        }>`
          SELECT i.id, i.name, s.kind, s.remaining, i.grounds_aircraft
            FROM public.maintenance_rule_status s
            JOIN public.maintenance_items i ON i.id = s.maintenance_item_id
           WHERE s.aircraft_id = ${request.params.id}
             AND i.status = 'active'
             -- Hour rules only: a calendar item does not care how long somebody
             -- flies, and cycles are not what a booking is measured in.
             AND s.kind IN ('tach_hr', 'hobbs_hr', 'airframe_hr')
             AND s.remaining IS NOT NULL
             -- Already past is a different sentence, and the summary's grounding
             -- reasons and restrictions are the ones that say it. "This booking
             -- would take it past" is false for something it is already past.
             AND s.remaining >= 0
             AND s.remaining <= ${hours}::numeric
           ORDER BY s.remaining
        `.execute(trx);

        return {
          aircraft_id: request.params.id,
          hours,
          crosses: rows.map((row) => ({
            id: row.id,
            name: row.name,
            kind: row.kind,
            remaining: row.remaining,
            grounds_aircraft: row.grounds_aircraft,
          })),
        };
      });
    },
  );

  app.post<{ Params: { id: string }; Body: CreateMaintenanceItemRequest }>(
    '/aircraft/:id/maintenance-items',
    {
      schema: createItemSchema,
      config: {
        requiresTenant: true,
        feature: 'maintenance_module',
        permission: ['maintenance.items', 'write'],
      },
    },
    async (request, reply) => {
      const body = request.body;

      const row = await request.withTenant(async (trx) => {
        await requireAircraft(trx, request.params.id);

        /*
          Where the first due point comes from.

          A form that says "every 50 tach hours, last done at 1,225.0" has
          stated everything needed, and 1,275.0 is arithmetic — §8.2 is explicit
          that the client never computes anything that matters, and a due point
          is the clearest case. So the rules are resolved here, by the same
          function the completion trigger uses, rather than being demanded from
          the caller. The `due_*` fields still work and still win where given,
          because a shipped build sends them (§8.1).
        */
        const implied = await impliedDuePoints(trx, body.rules ?? [], {
          on: body.due_on ?? null,
          hours: body.due_at_hours ?? null,
          cycles: body.due_at_cycles ?? null,
        });

        const due = {
          on: body.due_on ?? implied.on,
          hours: body.due_at_hours ?? implied.hours,
          cycles: body.due_at_cycles ?? implied.cycles,
        };

        if (due.on === null && due.hours === null && due.cycles === null) {
          // An item due on nothing never comes due, which makes it a note
          // rather than an inspection. The database says so too; this is a
          // better message than a CHECK violation surfacing as a 500.
          throw new InvalidRequestError(
            'an item needs an interval with something to count from, a due date, a due hour reading, or due cycles',
          );
        }

        const created = await trx
          .insertInto('maintenance_items')
          .values({
            tenant_id: request.ctx!.tenantId!,
            aircraft_id: request.params.id,
            name: body.name,
            description: body.description ?? null,
            regulatory_reference: body.regulatory_reference ?? null,
            grounds_aircraft: body.grounds_aircraft ?? false,
            due_on: due.on,
            due_at_hours: due.hours,
            due_at_cycles: due.cycles,
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

        await writeRules(trx, request.ctx!.tenantId!, created.id, body, {
          on: body.due_on ?? null,
          hours: body.due_at_hours ?? null,
          cycles: body.due_at_cycles ?? null,
        });

        const saved = await selectItems(trx)
          .where('i.id', '=', created.id)
          .executeTakeFirstOrThrow();
        return toItem(trx, saved);
      });

      return reply.status(201).send(row);
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
        permission: ['maintenance.items', 'write'],
      },
    },
    async (request) => {
      const items: MaintenanceItemResponse[] = await request.withTenant(async (trx) => {
        await requireAircraft(trx, request.params.id);
        await sql`SELECT public.instantiate_maintenance_templates(${request.params.id}::uuid)`
          .execute(trx);
        const rows = await selectItems(trx)
          .where('i.aircraft_id', '=', request.params.id)
          .where('i.status', '=', 'active')
          .orderBy('i.name')
          .execute();
        return toItems(trx, rows);
      });
      return items;
    },
  );

  app.patch<{ Params: { id: string }; Body: UpdateMaintenanceItemRequest }>(
    '/maintenance-items/:id',
    {
      schema: updateItemSchema,
      config: {
        requiresTenant: true,
        feature: 'maintenance_module',
        permission: ['maintenance.items', 'write'],
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
          // `rules` is not a column, and the due points are derived from them.
          .set(columnsOf(request.body))
          .where('id', '=', request.params.id)
          .executeTakeFirst();
        if (result.numUpdatedRows === 0n) throw new NotFoundError();

        /*
          The trap 0022 set, closed.

          `maintenance_items.due_on` and `due_at_hours` are the soonest of the
          item's rules since 0022, restated by `restate_item_due_points`.
          Writing them here — which this handler did, because they are columns
          and `.set(body)` wrote whatever arrived — moved the number the API
          returns and nothing the status view reads. An admin would correct a
          due date, see it change, and the aeroplane would go on counting down
          to the old one.

          So an edit that mentions intervals or a due point rewrites the rules,
          and the columns follow from them.
        */
        await writeRules(trx, request.ctx!.tenantId!, request.params.id, request.body, {
          on: request.body.due_on ?? null,
          hours: request.body.due_at_hours ?? null,
          cycles: request.body.due_at_cycles ?? null,
        });

        const saved = await selectItems(trx)
          .where('i.id', '=', request.params.id)
          .executeTakeFirst();
        return saved ? await toItem(trx, saved) : null;
      });
      if (!row) throw new NotFoundError();
      return row;
    },
  );

  /** The library itself, so a tenant can add a preset they were not seeded. */
  app.get(
    '/maintenance/library',
    {
      config: {
        requiresTenant: true,
        feature: 'maintenance_module',
        permission: ['maintenance.items', 'read'],
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
        permission: ['maintenance.items', 'read'],
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
        permission: ['maintenance.items', 'write'],
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
        maintenance_item: created.item,
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
        permission: ['maintenance.items', 'read'],
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
        permission: ['maintenance.items', 'write'],
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
        permission: ['maintenance.items', 'write'],
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
