import type { ColumnType, Generated } from 'kysely';

/**
 * A timestamptz column. The insert side accepts `undefined`, so this already
 * means "may be defaulted by the database" — do not wrap it in `Generated<>`,
 * which nests one ColumnType inside another and leaves the select side
 * resolving to the wrapper instead of to Date.
 */
type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;

export type TenantStatus = 'trial' | 'active' | 'past_due' | 'suspended' | 'closed';
export type TenantArchetype = 'solo' | 'partnership' | 'club';
export type UserStatus = 'active' | 'locked' | 'closed';
export type MembershipStatus = 'invited' | 'active' | 'suspended' | 'removed';

export interface TenantsTable {
  id: Generated<string>;
  slug: ColumnType<string, string, never>;
  name: string;
  /** An IANA zone. How a club wants its timestamps rendered (§6). */
  timezone: Generated<string>;
  host: string | null;
  status: Generated<TenantStatus>;
  /**
   * §3.1: descriptive only. Never read at runtime to decide behaviour —
   * that is §1.3 in a better disguise.
   */
  archetype: Generated<TenantArchetype>;
  plan_code: Generated<string>;
  billing_customer_id: string | null;
  branding: Generated<Record<string, unknown>>;
  legal_hold: Generated<boolean>;
  created_at: Timestamp;
  updated_at: Timestamp;
  /** Control-plane marker, not an application verb. app_role cannot write it. */
  deleted_at: ColumnType<Date | null, never, never>;
}

export interface UsersTable {
  id: Generated<string>;
  /** Not writable by the application: changing it is a re-verification flow. */
  email: ColumnType<string, string, never>;
  name: string | null;
  phone: string | null;
  email_verified_at: Timestamp | null;
  password_hash: string | null;
  mfa_enabled: Generated<boolean>;
  mfa_secret: string | null;
  status: Generated<UserStatus>;
  created_at: Timestamp;
  updated_at: Timestamp;
  deleted_at: ColumnType<Date | null, never, never>;
}

export interface MembershipsTable {
  id: Generated<string>;
  tenant_id: string;
  user_id: string;
  /** NOT NULL: a membership without a bundle would hold no permissions. */
  role_bundle_id: string;
  status: Generated<MembershipStatus>;
  invited_at: Timestamp | null;
  joined_at: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  deleted_at: ColumnType<Date | null, never, never>;
}

export interface InvitesTable {
  id: Generated<string>;
  tenant_id: string;
  email: string;
  name: string | null;
  /** Chosen by whoever sends the invite, not by whoever accepts it. */
  role_bundle_id: string | null;
  token_hash: string;
  invited_by: string | null;
  expires_at: Timestamp;
  accepted_at: Timestamp | null;
  accepted_by: string | null;
  revoked_at: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  deleted_at: ColumnType<Date | null, never, never>;
}

export type SessionType = 'user' | 'impersonation';

export interface SessionsTable {
  id: Generated<string>;
  user_id: string;
  /** §10: only 'user' is written today; the discriminator ships anyway. */
  session_type: Generated<SessionType>;
  acting_admin_user_id: string | null;
  /** Not `tenant_id`: a session belongs to a user and *selects* a tenant. */
  selected_tenant_id: string | null;
  access_token_hash: string;
  access_expires_at: Timestamp;
  expires_at: Timestamp;
  revoked_at: Timestamp | null;
  last_used_at: Timestamp | null;
  client: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface RefreshTokensTable {
  id: Generated<string>;
  session_id: string;
  token_hash: string;
  expires_at: Timestamp;
  /** Set when exchanged. A second presentation after this is theft. */
  used_at: Timestamp | null;
  revoked_at: Timestamp | null;
  created_at: Timestamp;
}

export interface DeviceRegistrationsTable {
  id: Generated<string>;
  user_id: string;
  platform: 'ios' | 'android' | 'web';
  push_token: string;
  last_seen_at: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/**
 * Single-use secrets that arrive by email. app_role holds no grant here —
 * every path in and out is one of the two §2.1 functions, which is what makes
 * the door countable.
 */
export interface AuthTokensTable {
  id: ColumnType<string, never, never>;
  user_id: ColumnType<string, never, never>;
  kind: ColumnType<'email_verification' | 'password_reset', never, never>;
  token_hash: ColumnType<string, never, never>;
  expires_at: ColumnType<Date, never, never>;
  used_at: ColumnType<Date | null, never, never>;
  created_at: ColumnType<Date, never, never>;
}

/**
 * The queue a sender will drain. Append-only, and `never` on every read side
 * because app_role holds no SELECT: the bodies carry live token links.
 */
export interface OutboxTable {
  id: Generated<string>;
  to_email: string;
  subject: string;
  body: string;
  kind: string;
  created_at: Timestamp;
  sent_at: ColumnType<Date | null, never, never>;
  attempts: ColumnType<number, never, never>;
  last_error: ColumnType<string | null, never, never>;
}

export interface AuditLogTable {
  id: Generated<string>;
  tenant_id: string;
  actor_user_id: string | null;
  acting_admin_user_id: string | null;
  resource: string;
  resource_id: string | null;
  action: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  occurred_at: Timestamp;
}

export interface PlansTable {
  code: string;
  name: string;
  description: string | null;
  sort_order: Generated<number>;
  /** Whether this plan can be bought without talking to anybody. */
  self_serve: Generated<boolean>;
  /**
   * The provider's lookup key for this plan's price — stable across test and
   * live, unlike a price id. No amount is stored: the provider is asked what
   * it will charge, so there is never a second copy to drift (§3.7 rule 1).
   */
  price_lookup_key: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/** Stripe's vocabulary, kept as Stripe says it (see migration 0015). */
export type SubscriptionStatus =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'unpaid'
  | 'canceled'
  | 'incomplete'
  | 'incomplete_expired'
  | 'paused';

/**
 * Platform billing (§3.7's left-hand column) — tenant to FlightSquare.
 *
 * Every column is read-only to the application. The row is written by
 * public.apply_subscription, because a role that can write its own plan
 * resolves itself onto every entitlement in the registry.
 */
export interface SubscriptionsTable {
  id: ColumnType<string, never, never>;
  tenant_id: ColumnType<string, never, never>;
  provider: ColumnType<string, never, never>;
  provider_subscription_id: ColumnType<string, never, never>;
  plan_code: ColumnType<string, never, never>;
  status: ColumnType<SubscriptionStatus, never, never>;
  current_period_end: ColumnType<Date | null, never, never>;
  cancel_at_period_end: ColumnType<boolean, never, never>;
  created_at: ColumnType<Date, never, never>;
  updated_at: ColumnType<Date, never, never>;
}

/**
 * Webhook idempotency, and the whole of it: a replayed delivery hits the
 * unique key and does nothing. Insert-only — no update, no delete.
 */
export interface BillingEventsTable {
  id: Generated<string>;
  tenant_id: string;
  provider: Generated<string>;
  provider_event_id: string;
  type: string;
  received_at: Timestamp;
}

export interface PlanEntitlementsTable {
  plan_code: string;
  key: string;
  /** jsonb: boolean for a flag, number or "unlimited" for a quota, string for config. */
  value: unknown;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface TenantEntitlementOverridesTable {
  tenant_id: string;
  key: string;
  value: unknown;
  reason: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface TenantUsageTable {
  tenant_id: string;
  quota_key: string;
  /** Maintained by triggers. app_role holds no write grant here on purpose. */
  current_value: ColumnType<string, never, never>;
  updated_at: ColumnType<Date, never, never>;
}

export interface RoleBundlesTable {
  id: Generated<string>;
  tenant_id: string;
  code: string;
  name: string;
  is_default: Generated<boolean>;
  created_at: Timestamp;
  updated_at: Timestamp;
  deleted_at: ColumnType<Date | null, never, never>;
}

export interface RoleBundlePermissionsTable {
  tenant_id: string;
  role_bundle_id: string;
  resource: string;
  level: string;
  /** §4.4's third dimension: which rows the level applies to. */
  scope: Generated<'own' | 'all'>;
  created_at: Timestamp;
}

export type AircraftStatus = 'active' | 'grounded' | 'archived' | 'sold';
export type Ownership = 'owned' | 'leased' | 'leaseback' | 'club_owned';
export type MaintenanceMeter = 'hobbs' | 'tach' | 'airframe';

export interface AircraftTypesTable {
  code: string;
  manufacturer: string;
  model: string;
  category: string;
  engine_type: string;
  engine_count: Generated<number>;
  typical_seats: number | null;
  created_at: Timestamp;
}

export interface AerodromesTable {
  ident: string;
  icao_code: string | null;
  iata_code: string | null;
  name: string;
  municipality: string | null;
  region: string | null;
  country: string;
  latitude: string | null;
  longitude: string | null;
  elevation_ft: number | null;
  created_at: Timestamp;
}

export interface AircraftTable {
  id: Generated<string>;
  tenant_id: string;
  registration: string;
  type_code: string | null;
  serial_number: string | null;
  year_manufactured: number | null;
  home_base: string | null;
  /** §5.5: archiving is a status, and an archived aircraft keeps its history. */
  status: Generated<AircraftStatus>;
  ownership: Generated<Ownership>;

  // Derived from meter_readings by a trigger. `never` on the write side is
  // not decoration: app_role holds no UPDATE grant on these columns, so a
  // query that tried would fail at the database anyway (§3.4).
  airframe_hours: ColumnType<string | null, never, never>;
  hobbs: ColumnType<string | null, never, never>;
  tach: ColumnType<string | null, never, never>;
  engine_hours_since_overhaul: ColumnType<string | null, never, never>;
  cycles: ColumnType<number | null, never, never>;
  totals_updated_at: ColumnType<Date | null, never, never>;

  created_at: Timestamp;
  updated_at: Timestamp;
  deleted_at: ColumnType<Date | null, never, never>;
}

export type BillingMeter = 'hobbs' | 'tach';
export type RateBasis = 'wet' | 'dry';
export type FuelUnits = 'gallons' | 'litres';

export interface AircraftConfigTable {
  aircraft_id: string;
  tenant_id: string;
  seats: number | null;
  maintenance_meter: Generated<MaintenanceMeter>;
  /** Which meter the money counts on — frequently not the maintenance one. */
  billing_meter: Generated<BillingMeter>;
  /** §3.7: wet includes fuel, so a pilot who buys it is credited back. */
  rate_basis: Generated<RateBasis>;
  currency: Generated<string>;
  fuel_capacity: string | null;
  fuel_units: Generated<FuelUnits>;
  mel_reference: string | null;
  equipment: Generated<Record<string, unknown>>;
  performance: Generated<Record<string, unknown>>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface MeterReadingsTable {
  id: Generated<string>;
  tenant_id: string;
  aircraft_id: string;
  /** numeric arrives as a string; parsing it to a float would lose precision. */
  hobbs: string | null;
  tach: string | null;
  airframe_hours: string | null;
  cycles: number | null;
  /** When the reading was taken. The server orders by this, not by arrival. */
  recorded_at: Timestamp;
  received_at: Timestamp;
  source: Generated<'manual' | 'flight' | 'maintenance' | 'import'>;
  recorded_by: string | null;
  /** A correction points at the row it replaces; neither is ever deleted. */
  supersedes_id: string | null;
  note: string | null;
  created_at: Timestamp;
}

export type MaintenanceItemStatus = 'active' | 'archived';
export type MaintenanceState = 'ok' | 'due_soon' | 'overdue' | 'inactive';
export type SquawkSeverity = 'advisory' | 'minor' | 'major' | 'grounding';
export type SquawkStatus = 'open' | 'deferred' | 'resolved';
export type DeferralBasis = 'mel' | 'cdl' | 'far_91_213' | 'other';
export type ComplianceKind = 'inspection' | 'ad' | 'sb' | 'overhaul' | 'repair' | 'other';
export type ComplianceMethod = 'inspection' | 'modification' | 'replacement' | 'recurring';
export type WorkOrderStatus = 'open' | 'closed';
export type SignoffKind = 'a_and_p' | 'ia' | 'repairman' | 'owner' | 'other';

/** A `date` column: a calendar day, with no time and no zone to get wrong. */
type CalendarDate = ColumnType<string, string, string>;

/** A view column. Selectable, and `never` on both write sides because it is. */
type ViewColumn<T> = ColumnType<T, never, never>;

/**
 * §2.2 global reference. Instantiated as a copy and never referenced (§3.6),
 * so nothing in the application writes here and no tenant row points at it.
 */
export interface MaintenanceIntervalTemplatesTable {
  code: string;
  version: number;
  name: string;
  description: string | null;
  regulatory_reference: string | null;
  applies_to: string;
  applies_value: string | null;
  auto_instantiate: Generated<boolean>;
  interval_months: number | null;
  interval_hours: string | null;
  interval_cycles: number | null;
  hours_meter: MaintenanceMeter | null;
  grounds_aircraft: Generated<boolean>;
  warn_within_days: Generated<number>;
  warn_within_hours: Generated<string>;
  created_at: Timestamp;
}

export interface MaintenanceItemsTable {
  id: Generated<string>;
  tenant_id: string;
  aircraft_id: string;
  name: string;
  description: string | null;
  regulatory_reference: string | null;
  /** §5.5: archiving is a status, and an archived item keeps its history. */
  status: Generated<MaintenanceItemStatus>;
  /** Feeds aircraft_availability once the item goes overdue (§3.3). */
  grounds_aircraft: Generated<boolean>;
  due_on: CalendarDate | null;
  due_at_hours: string | null;
  due_at_cycles: number | null;
  hours_meter: MaintenanceMeter | null;
  interval_months: number | null;
  interval_hours: string | null;
  interval_cycles: number | null;
  warn_within_days: Generated<number>;
  warn_within_hours: Generated<string>;
  // Rolled forward by a trigger when compliance lands, never by the caller.
  last_complied_on: ColumnType<string | null, never, never>;
  last_complied_hours: ColumnType<string | null, never, never>;
  last_complied_cycles: ColumnType<number | null, never, never>;
  /** Provenance only: which preset version seeded this row (§3.6). */
  template_code: string | null;
  template_version: number | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface SquawksTable {
  id: Generated<string>;
  tenant_id: string;
  aircraft_id: string;
  /**
   * `never` on update: app_role holds no UPDATE grant on this column. The
   * defect someone wrote down is the record, and a correction is a new
   * squawk rather than a rewrite of the one an investigator reads.
   */
  summary: ColumnType<string, string, never>;
  details: string | null;
  /** How bad it is. Whether it flies is `grounding`, which is a judgement. */
  severity: Generated<SquawkSeverity>;
  grounding: Generated<boolean>;
  status: Generated<SquawkStatus>;
  reported_by: ColumnType<string, string, never>;
  reported_at: Timestamp;
  received_at: Timestamp;
  found_on_flight_id: string | null;
  resolved_at: Timestamp | null;
  resolved_by: string | null;
  resolution_note: string | null;
  work_order_id: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/** Append-only: §7.2 names deferral history among what gets subpoenaed. */
export interface SquawkDeferralsTable {
  id: Generated<string>;
  tenant_id: string;
  squawk_id: string;
  basis: DeferralBasis;
  reference: string | null;
  expires_on: CalendarDate | null;
  note: string | null;
  deferred_by: string;
  deferred_at: Timestamp;
  created_at: Timestamp;
}

export interface WorkOrdersTable {
  id: Generated<string>;
  tenant_id: string;
  aircraft_id: string;
  reference: string | null;
  description: string;
  performed_by: string | null;
  performed_on: CalendarDate | null;
  parts: Generated<unknown>;
  labor_hours: string | null;
  /** §3.7 rule 3: integer minor units, never a float. */
  cost_cents: number | null;
  currency: Generated<string>;
  status: Generated<WorkOrderStatus>;
  signoff_name: string | null;
  signoff_certificate: string | null;
  signoff_kind: SignoffKind | null;
  /** Once set, a trigger refuses every further UPDATE on the row. */
  signed_at: Timestamp | null;
  created_by: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/**
 * Append-only, never edited (§3.6). `never` on every update side is not
 * decoration: app_role holds SELECT and INSERT and nothing else, so a query
 * that tried would be refused by the database anyway.
 */
export interface ComplianceRecordsTable {
  id: Generated<string>;
  tenant_id: string;
  aircraft_id: string;
  maintenance_item_id: string | null;
  work_order_id: string | null;
  kind: ComplianceKind;
  reference: string | null;
  title: string;
  method: ComplianceMethod | null;
  complied_on: CalendarDate;
  complied_at_hours: string | null;
  complied_at_cycles: number | null;
  hours_meter: MaintenanceMeter | null;
  next_due_on: CalendarDate | null;
  next_due_at_hours: string | null;
  signed_by: string | null;
  signed_certificate: string | null;
  /** A correction points at the row it replaces; neither is ever deleted. */
  supersedes_id: string | null;
  note: string | null;
  recorded_by: string | null;
  recorded_at: Timestamp;
  created_at: Timestamp;
}

/**
 * Views, not tables. Both are `security_invoker`, so the policies of the
 * tables underneath stay in the path — without that they would read every
 * tenant, and they would do it silently.
 */
export interface MaintenanceItemStatusView {
  maintenance_item_id: ViewColumn<string>;
  tenant_id: ViewColumn<string>;
  aircraft_id: ViewColumn<string>;
  name: ViewColumn<string>;
  status: ViewColumn<MaintenanceItemStatus>;
  grounds_aircraft: ViewColumn<boolean>;
  due_on: ViewColumn<string | null>;
  due_at_hours: ViewColumn<string | null>;
  due_at_cycles: ViewColumn<number | null>;
  hours_meter: ViewColumn<MaintenanceMeter>;
  current_hours: ViewColumn<string | null>;
  template_code: ViewColumn<string | null>;
  last_complied_on: ViewColumn<string | null>;
  /** False means "no record", which is not the same claim as "overdue". */
  ever_complied: ViewColumn<boolean>;
  days_remaining: ViewColumn<number | null>;
  hours_remaining: ViewColumn<string | null>;
  cycles_remaining: ViewColumn<number | null>;
  state: ViewColumn<MaintenanceState>;
}

/** §3.3: the one place that decides whether an aircraft may be booked. */
export interface AircraftAvailabilityView {
  aircraft_id: ViewColumn<string>;
  tenant_id: ViewColumn<string>;
  registration: ViewColumn<string>;
  aircraft_status: ViewColumn<AircraftStatus>;
  grounding_squawks: ViewColumn<string>;
  overdue_grounding_items: ViewColumn<string>;
  available: ViewColumn<boolean>;
  grounding_reasons: ViewColumn<string[]>;
}

export type ReservationStatus = 'booked' | 'cancelled' | 'completed';

/**
 * §3.3. A booking's hours live here; what it holds lives in
 * `reservation_resources`, one row per thing — always exactly one of type
 * 'aircraft' today, and the reason an instructor can be a second one later
 * without any of the conflict logic changing.
 */
export interface ReservationsTable {
  id: Generated<string>;
  tenant_id: string;
  /** Who will be flying. Not editable: the column carries no UPDATE grant. */
  booked_by: ColumnType<string, string, never>;
  purpose: string | null;
  notes: string | null;
  starts_at: Timestamp;
  ends_at: Timestamp;
  status: Generated<ReservationStatus>;
  /** §3.3: grounded aircraft flag their future bookings, never cancel them. */
  needs_review: Generated<boolean>;
  review_reason: string | null;
  cancelled_at: Timestamp | null;
  cancelled_by: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/**
 * One row per thing a booking or a blackout holds, and the table the
 * exclusion constraint lives on.
 *
 * `during` and `blocking` are `never` on the write side because app_role
 * holds no grant on them: they are copies of the parent kept in step by a
 * §2.3 helper, and an application that could write them could move a line
 * off the hours its booking claims while the constraint stayed satisfied.
 */
export interface ReservationResourcesTable {
  id: Generated<string>;
  tenant_id: string;
  reservation_id: string | null;
  blackout_id: string | null;
  resource_type: 'aircraft';
  resource_id: string;
  during: ColumnType<string, string, never>;
  blocking: ColumnType<boolean, never, never>;
  created_at: Timestamp;
}

export interface BlackoutsTable {
  id: Generated<string>;
  tenant_id: string;
  aircraft_id: string;
  reason: string;
  starts_at: Timestamp;
  ends_at: Timestamp;
  created_by: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/**
 * §3.5's checkout rule — "is Dave signed off in the 182?" — and nothing
 * more. No certificate numbers, no ratings, no hours: §3.4's boundary holds,
 * and this says only that somebody may fly a particular aeroplane.
 */
export interface MemberAircraftAuthorizationsTable {
  tenant_id: string;
  membership_id: string;
  aircraft_id: string;
  authorized_on: ColumnType<string, string | undefined, never>;
  authorized_by: string | null;
  note: string | null;
  created_at: Timestamp;
}

/**
 * §3.7 rule 4: a rate change is a new row, never an edit. There is no UPDATE
 * grant on any of these, which is what makes the rule true rather than
 * remembered.
 */
export interface AircraftRatesTable {
  id: Generated<string>;
  tenant_id: string;
  aircraft_id: string;
  /** Rule 3: integer minor units. Never float, never NUMERIC in JS. */
  amount_cents: number;
  currency: Generated<string>;
  effective_from: ColumnType<string, string | undefined, never>;
  created_by: string | null;
  created_at: Timestamp;
}

export interface MemberAircraftRatesTable {
  id: Generated<string>;
  tenant_id: string;
  membership_id: string;
  aircraft_id: string;
  amount_cents: number;
  currency: Generated<string>;
  effective_from: ColumnType<string, string | undefined, never>;
  created_by: string | null;
  created_at: Timestamp;
}

/**
 * §3.7 rule 1: the hours, the rate *applied*, and which rule supplied it —
 * never a foreign key to a rate somebody may edit next March.
 *
 * Generated by a §2.3 helper on flight logging. The INSERT side stays open
 * only for a reversing entry, which is how rule 2 makes a correction.
 */
export interface FlightChargesTable {
  id: Generated<string>;
  tenant_id: string;
  flight_id: string | null;
  membership_id: string;
  meter: 'hobbs' | 'tach';
  meter_hours: string;
  rate_cents: number;
  rate_source: 'member' | 'aircraft';
  rate_basis: 'wet' | 'dry';
  amount_cents: number;
  currency: Generated<string>;
  /** What this undoes. Both rows stay; nothing is ever edited away. */
  reverses_id: string | null;
  reason: string | null;
  created_by: string | null;
  created_at: Timestamp;
}

export interface FuelCreditsTable {
  id: Generated<string>;
  tenant_id: string;
  flight_id: string | null;
  membership_id: string;
  quantity: string | null;
  amount_cents: number;
  currency: Generated<string>;
  reverses_id: string | null;
  reason: string | null;
  created_by: string | null;
  created_at: Timestamp;
}

/**
 * The only hand-written line in the ledger, and in v1 the whole of how money
 * moving is recorded: "Dave paid $400 by cheque" is an adjustment.
 *
 * Positive increases what the member owes; negative reduces it. A payment is
 * negative, and so is a write-off.
 */
export interface LedgerAdjustmentsTable {
  id: Generated<string>;
  tenant_id: string;
  membership_id: string;
  amount_cents: number;
  currency: Generated<string>;
  reason: string;
  created_by: string | null;
  created_at: Timestamp;
}

export interface FlightsTable {
  id: Generated<string>;
  tenant_id: string;
  aircraft_id: string;
  /** §3.4: the billing subject and the accountability record — a membership. */
  flown_by: string;
  flight_date: ColumnType<string, string, string>;
  departed_from: string | null;
  arrived_at: string | null;
  remarks: string | null;
  /** §8.2: a meter gap is flagged for an admin, never rejected. */
  needs_review: Generated<boolean>;
  review_reason: string | null;
  recorded_at: Timestamp;
  received_at: Timestamp;
  created_by: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface FlightMetersTable {
  flight_id: string;
  tenant_id: string;
  hobbs_start: string | null;
  hobbs_end: string | null;
  tach_start: string | null;
  tach_end: string | null;
  /** GENERATED: an end minus a start is not a fact anyone observed. */
  hobbs_hours: ColumnType<string | null, never, never>;
  tach_hours: ColumnType<string | null, never, never>;
  created_at: Timestamp;
}

export interface FlightFuelTable {
  flight_id: string;
  tenant_id: string;
  /** State: latest wins, never summed across flights (§3.4). */
  fuel_remaining_after: string | null;
  /** Transaction: an immutable record of what someone spent. */
  fuel_added_qty: string | null;
  /** §3.7 rule 3: integer minor units, never a float. */
  fuel_added_cost_cents: number | null;
  currency: Generated<string>;
  receipt_reference: string | null;
  created_at: Timestamp;
}

export interface IdempotencyKeysTable {
  tenant_id: string;
  key: string;
  endpoint: string;
  fingerprint: string;
  status_code: number;
  response: unknown;
  created_at: Timestamp;
}

export interface Database {
  aircraft_rates: AircraftRatesTable;
  member_aircraft_rates: MemberAircraftRatesTable;
  flight_charges: FlightChargesTable;
  fuel_credits: FuelCreditsTable;
  ledger_adjustments: LedgerAdjustmentsTable;
  reservations: ReservationsTable;
  reservation_resources: ReservationResourcesTable;
  blackouts: BlackoutsTable;
  member_aircraft_authorizations: MemberAircraftAuthorizationsTable;
  auth_tokens: AuthTokensTable;
  outbox: OutboxTable;
  maintenance_interval_templates: MaintenanceIntervalTemplatesTable;
  maintenance_items: MaintenanceItemsTable;
  maintenance_item_status: MaintenanceItemStatusView;
  aircraft_availability: AircraftAvailabilityView;
  squawks: SquawksTable;
  squawk_deferrals: SquawkDeferralsTable;
  work_orders: WorkOrdersTable;
  compliance_records: ComplianceRecordsTable;
  flights: FlightsTable;
  flight_meters: FlightMetersTable;
  flight_fuel: FlightFuelTable;
  idempotency_keys: IdempotencyKeysTable;
  aircraft: AircraftTable;
  aircraft_config: AircraftConfigTable;
  aircraft_types: AircraftTypesTable;
  aerodromes: AerodromesTable;
  meter_readings: MeterReadingsTable;
  plans: PlansTable;
  plan_entitlements: PlanEntitlementsTable;
  tenant_entitlement_overrides: TenantEntitlementOverridesTable;
  tenant_usage: TenantUsageTable;
  subscriptions: SubscriptionsTable;
  billing_events: BillingEventsTable;
  role_bundles: RoleBundlesTable;
  role_bundle_permissions: RoleBundlePermissionsTable;
  tenants: TenantsTable;
  users: UsersTable;
  memberships: MembershipsTable;
  invites: InvitesTable;
  sessions: SessionsTable;
  refresh_tokens: RefreshTokensTable;
  device_registrations: DeviceRegistrationsTable;
  audit_log: AuditLogTable;
}
