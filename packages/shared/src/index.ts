/**
 * The API contract — the shapes a client can rely on — and the client that
 * speaks it (§9).
 *
 * This package has **no build step**. Its consumers are bundlers (Next via
 * transpilePackages, Metro via watchFolders) which compile the TypeScript
 * directly, and the `api` workspace imports from here with `import type`
 * only, so nothing resolves this package at runtime on the server. Everything here is
 * consumed with `import type`, which TypeScript erases, so nothing resolves
 * `@flightsquare/shared` at runtime.
 *
 * The tripwire: a *value* import from this package — a constant, an enum, a
 * function — would compile and then fail at runtime, because the published
 * entry point is a `.ts` file Node cannot load. The moment this package needs
 * runtime values, it gains a `tsc` build emitting `dist/`, and the root
 * `build` script gains explicit ordering: `npm run build --workspaces` builds
 * alphabetically, which puts `api` before `packages/shared`.
 *
 * What does NOT belong here: entitlement values. §8.1 requires the client to
 * fetch resolved flags and quotas rather than carry a table of what Pro
 * includes — a compiled-in copy goes stale on the App Store and cannot be
 * corrected without a release. Shapes travel; values are fetched.
 */

// ---------------------------------------------------------------------------
// Errors — the §1.6 gates.
//
//   Feature     404   is this capability in the tenant's entitlements?
//   Permission  403   does this user hold the required level?
//   Quota       402   is the tenant under its numeric limit?
//
// Checked in that order, so a gated capability is indistinguishable from one
// that does not exist. 429 is rate limiting and is never a plan quota.
// ---------------------------------------------------------------------------

export * from './client.js';
export * from './offline.js';
export * from './uuidv7.js';

export type PermissionLevel = 'none' | 'read' | 'write';

export interface NotFoundBody {
  error: 'not_found';
}

export interface ForbiddenBody {
  error: 'forbidden';
  resource: string;
  level: Exclude<PermissionLevel, 'none'>;
}

export type Remediation = 'upgrade' | 'archive' | 'contact_support';

/** Machine-readable so the UI can offer the right remediation, per §1.6. */
export interface QuotaExceededBody {
  error: 'quota_exceeded';
  quota: string;
  limit: number;
  current: number;
  remediation: Remediation[];
}

export interface RateLimitedBody {
  error: 'rate_limited';
  retry_after: number;
}

/** §8.1's minimum-supported-version handshake. A shipped build cannot be forced to update. */
export interface ClientTooOldBody {
  error: 'client_too_old';
  client: string;
  minimum_version: string;
}

export interface UnauthorizedBody {
  error: 'unauthorized';
}

/**
 * Authenticated, but no tenant selected for a tenant-scoped route. Distinct
 * from `forbidden`, which answers a question about permission levels.
 */
export interface TenantRequiredBody {
  error: 'tenant_required';
}

export interface ConflictBody {
  error: 'conflict';
  reason: string;
}

export interface InvalidRequestBody {
  error: 'invalid_request';
  detail: string;
}

export interface InternalErrorBody {
  error: 'internal_error';
  request_id: string;
}

export type ApiErrorBody =
  | NotFoundBody
  | ForbiddenBody
  | QuotaExceededBody
  | RateLimitedBody
  | ClientTooOldBody
  | UnauthorizedBody
  | TenantRequiredBody
  | ConflictBody
  | InvalidRequestBody
  | InternalErrorBody;

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export interface HealthResponse {
  status: 'ok';
  database: 'ok';
}

export interface SignupResponse {
  tenant_id: string;
  user_id: string;
  membership_id: string;
}

export type TenantStatus = 'trial' | 'active' | 'past_due' | 'suspended' | 'closed';
export type MembershipStatus = 'invited' | 'active' | 'suspended' | 'removed';

/** One row of the post-authentication tenant picker (§3.1, §2.1). */
export interface MembershipSummaryResponse {
  tenant_id: string;
  tenant_name: string;
  tenant_status: TenantStatus;
  membership_status: MembershipStatus;
}

/**
 * A freshly minted session.
 *
 * The tenant is not in here and is not in the token: it is chosen afterwards
 * and lives on the session row, so which tenant a request acts in is always
 * something the server resolved rather than something the client sent (§1.1).
 */
export interface LoginResponse {
  access_token: string;
  refresh_token: string;
  expires_at: string;
  mfa_required: boolean;
  /** So a client can render the picker without a second round trip. */
  memberships: MembershipSummaryResponse[];
}

export interface RefreshResponse {
  access_token: string;
  refresh_token: string;
  expires_at: string;
}

export interface SelectTenantResponse {
  tenant_id: string;
  tenant_name: string;
}

export interface MeResponse {
  id: string;
  email: string;
  name: string | null;
  phone: string | null;
  mfa_enabled: boolean;
  /** Recorded, not enforced: nothing in v1 is gated on it. */
  email_verified: boolean;
}

export interface UpdateProfileRequest {
  name?: string | null;
  phone?: string | null;
}

export type TenantArchetype = 'solo' | 'partnership' | 'club';

/** The current tenant, read under tenant context. */
export interface TenantResponse {
  id: string;
  slug: string;
  name: string;
  archetype: TenantArchetype;
  /** An IANA zone. How this club wants its timestamps rendered. */
  timezone: string;
  branding: Record<string, unknown>;
  /**
   * §7.3's lifecycle. Every member may know their own club is `past_due`,
   * which is the only value they will ever see here that is not `active` or
   * `trial` — a suspended or closed tenant fails at the session, so nothing
   * gets far enough to read this.
   */
  status: TenantStatus;
}

/** Settings. Not the slug — it is in URLs and invite links already sent. */
export interface UpdateTenantRequest {
  name?: string;
  timezone?: string;
}

// ---------------------------------------------------------------------------
// Members and invitations (M1)
//
// §3.1: `users` are global and memberships are tenant-scoped, so everything
// here is a membership rather than a person. The same human is an Admin of
// their own aircraft and a Pilot at their club, and this is the row that says
// which.
// ---------------------------------------------------------------------------

/** The two v1 roles (§4.4). Adding a third is rows, not a release. */
export type RoleCode = 'admin' | 'pilot';

export interface MemberResponse {
  id: string;
  user_id: string;
  email: string;
  name: string | null;
  role: string;
  role_name: string;
  status: MembershipStatus;
  joined_at: string | null;
  invited_at: string | null;
}

export interface UpdateMemberRequest {
  role?: RoleCode;
  /** §10: removal is a status. Their flights and charges stay attached. */
  status?: 'active' | 'suspended' | 'removed';
}

export interface InviteResponse {
  id: string;
  email: string;
  name: string | null;
  role: string | null;
  expires_at: string;
  created_at: string;
  expired: boolean;
}

export interface CreateInviteRequest {
  email: string;
  name?: string;
  /** Defaults to pilot — the role that cannot invite anybody else. */
  role?: RoleCode;
}

/** What the accept page knows before anybody commits to anything. */
export interface InviteLookupResponse {
  email: string;
  tenant_name: string;
  expires_at: string;
  /** Decides whether the page asks for a password or for a sign-in. */
  has_account: boolean;
}

export interface AcceptInviteRequest {
  /** Only for somebody who has never used FlightSquare. */
  password?: string;
  name?: string;
}

export interface AcceptInviteResponse {
  membership_id: string;
  tenant_id: string;
  tenant_name: string;
  email: string;
}

// ---------------------------------------------------------------------------
// Entitlements
//
// §8.1: the client fetches these and hides UI accordingly. It must never
// carry a compiled-in table of what a plan includes — that goes stale on the
// App Store and cannot be corrected without a release. Shapes travel here;
// values are fetched.
// ---------------------------------------------------------------------------

/** Which layer of §1.4's chain supplied a value. */
export type EntitlementSource = 'override' | 'plan' | 'default';

export interface ResolvedQuota {
  /** A finite limit, or the string "unlimited" — never a sentinel number. */
  limit: number | 'unlimited';
  source: EntitlementSource;
  /**
   * What the tenant is using right now, counted in the database (§4.5).
   *
   * Here so a screen can say "2 of 1 aircraft" and offer the two things §5
   * offers — upgrade, or choose what to archive — rather than waiting for
   * somebody to walk into a 402. Absent for a quota nothing counts yet.
   */
  current?: number;
}

/**
 * §4.4's third dimension. Which rows a level applies to — `charges: read`
 * for a Pilot means their own ledger, which a resource and a level together
 * could not say.
 *
 * For wording and for hiding, never for enforcement: the policy on the table
 * is what keeps a pilot out of somebody else's rows (§10), and this only
 * lets a screen say "My charges" instead of "Charges".
 */
export type PermissionScope = 'own' | 'all';

export interface EntitlementsResponse {
  plan_code: string;
  flags: Record<string, boolean>;
  quotas: Record<string, ResolvedQuota>;
  config: Record<string, string>;
  /** What this member holds, so the client can hide what they cannot do. */
  permissions: Record<string, 'none' | 'read' | 'write'>;
  /** How far each of those reaches. Absent means `all`. */
  permission_scopes?: Record<string, PermissionScope>;
}

// ---------------------------------------------------------------------------
// Platform billing (§3.7's left-hand column) — tenant to FlightSquare.
//
// Never "billing" without the qualifier: `/billing` in the web app is member
// billing, pilot to club, and the two get confused in conversation, in code
// and in support tickets unless the names stay apart.
// ---------------------------------------------------------------------------

export interface PlanResponse {
  code: string;
  name: string;
  description: string | null;
  /** Ordered for display; the catalogue decides, not the client. */
  sort_order: number;
  /** Whether it can be bought without talking to anybody. */
  self_serve: boolean;
  /**
   * What the provider will charge, asked of the provider — absent when the
   * plan is free, not for sale, or the provider could not be reached. Never
   * a number a shipped client carries (§8.1).
   */
  price?: { amount_cents: number; currency: string; interval: string };
  /** The flags and quotas this plan would resolve to, for comparison. */
  flags: Record<string, boolean>;
  quotas: Record<string, number | 'unlimited'>;
  /** True for the plan the tenant is on today. */
  current: boolean;
}

export type SubscriptionStatus =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'unpaid'
  | 'canceled'
  | 'incomplete'
  | 'incomplete_expired'
  | 'paused';

export interface SubscriptionResponse {
  plan_code: string;
  /** Null when the tenant has never paid — a complete state, not a gap. */
  status: SubscriptionStatus | null;
  /** ISO date-time. When the current paid period ends. */
  current_period_end: string | null;
  /**
   * §5.1: a downgrade takes effect at the end of the paid period, so this is
   * what lets a screen say "Pro until 14 October, then Free".
   */
  cancel_at_period_end: boolean;
  /** Whether checkout and the portal can be offered at all. */
  provider_configured: boolean;
}

/** Where to send the person. Always an absolute URL at the provider. */
export interface BillingRedirectResponse {
  url: string;
}

export interface CheckoutRequest {
  plan_code: string;
}

// ---------------------------------------------------------------------------
// Fleet
// ---------------------------------------------------------------------------

/**
 * `grounded` is an administrator's decision, and is separate from both
 * archiving (about the plan and the fleet list) and a grounding squawk
 * (about a defect). All three end in the same availability answer.
 */
export type AircraftStatus = 'active' | 'grounded' | 'archived' | 'sold';
export type BillingMeter = 'hobbs' | 'tach';
export type RateBasis = 'wet' | 'dry';
export type FuelUnits = 'gallons' | 'litres';
export type Ownership = 'owned' | 'leased' | 'leaseback' | 'club_owned';
export type MaintenanceMeter = 'hobbs' | 'tach' | 'airframe';

/**
 * Meters travel as strings.
 *
 * They are `numeric` in Postgres and a decimal on the wire, because a tach
 * reading of 1100.2 is not a float and rounding one is how a maintenance
 * countdown drifts. The client formats; it does not compute (§8.2).
 */
export interface AircraftResponse {
  id: string;
  registration: string;
  type_code: string | null;
  serial_number: string | null;
  year_manufactured: number | null;
  home_base: string | null;
  status: AircraftStatus;
  ownership: Ownership;
  /** Derived from the meter log; never written directly. */
  airframe_hours: string | null;
  hobbs: string | null;
  tach: string | null;
  cycles: number | null;
  totals_updated_at: string | null;
  maintenance_meter: MaintenanceMeter;
  seats: number | null;

  /** Which meter the money counts on (§3.7). */
  billing_meter: BillingMeter;
  /** Wet includes fuel; dry does not, and fuel is then the pilot's own cost. */
  rate_basis: RateBasis;
  /**
   * What the aircraft costs an hour *today*, in integer minor units.
   *
   * Resolved from the effective-dated rates rather than stored: §3.7 rule 4
   * makes a rate change a new row, so there is no single column to read and
   * a charge already made keeps the rate it was made at.
   */
  default_rate_cents: number | null;
  currency: string;
  fuel_capacity: string | null;
  fuel_units: FuelUnits;
  /**
   * What the last pilot left in the tanks — aircraft *state*, and never
   * computed by arithmetic across flights (§3.4). Null until somebody
   * records one.
   */
  fuel_remaining: string | null;
}

export interface CreateAircraftRequest {
  registration: string;
  type_code?: string;
  serial_number?: string;
  year_manufactured?: number;
  /** Free text: the aerodrome table suggests, and does not refuse. */
  home_base?: string;
  ownership?: Ownership;
  seats?: number;
  maintenance_meter?: MaintenanceMeter;

  billing_meter?: BillingMeter;
  rate_basis?: RateBasis;
  default_rate_cents?: number;
  fuel_capacity?: string;
  fuel_units?: FuelUnits;

  /**
   * Where the meters stand today (M2).
   *
   * The only time a meter is set rather than advanced: after this, they move
   * through flight logs or an explicit correction and never by editing the
   * aircraft. Recorded as a reading like any other, so the totals stay
   * derived from an append-only log (§3.4).
   */
  hobbs?: string;
  tach?: string;
  airframe_hours?: string;
}

export interface MeterReadingResponse {
  id: string;
  aircraft_id: string;
  hobbs: string | null;
  tach: string | null;
  airframe_hours: string | null;
  cycles: number | null;
  recorded_at: string;
  received_at: string;
  source: string;
  supersedes_id: string | null;
  note: string | null;
  /** Set when this reading has itself been superseded by a later correction. */
  superseded: boolean;
}

export interface CreateMeterReadingRequest {
  hobbs?: string;
  tach?: string;
  airframe_hours?: string;
  cycles?: number;
  /** Defaults to now. Present so an offline client can send when it happened. */
  recorded_at?: string;
  supersedes_id?: string;
  note?: string;
}

export interface AircraftTypeResponse {
  code: string;
  manufacturer: string;
  model: string;
  category: string;
  engine_type: string;
  engine_count: number;
  typical_seats: number | null;
}

export interface AerodromeResponse {
  ident: string;
  name: string;
  municipality: string | null;
  region: string | null;
  country: string;
}

// ---------------------------------------------------------------------------
// Flights
//
// §3.4: this tracks the aircraft, not the pilot. No experience totals, no
// currency, no landings, no endorsements. `flown_by` is who had the plane and
// who owes for it, not the seed of an experience log — and the whole
// pilot-logbook story is the CSV export, so people can transcribe into their
// own.
// ---------------------------------------------------------------------------

export interface FlightResponse {
  id: string;
  aircraft_id: string;
  aircraft_registration: string;
  flown_by: string;
  flown_by_email: string | null;
  flight_date: string;
  departed_from: string | null;
  arrived_at: string | null;
  remarks: string | null;
  /** §8.2: a meter gap is flagged for an admin, never a reason to refuse. */
  needs_review: boolean;
  review_reason: string | null;
  recorded_at: string;

  /** Recorded as read. Neither meter is derived from the other. */
  hobbs_start: string | null;
  hobbs_end: string | null;
  hobbs_hours: string | null;
  tach_start: string | null;
  tach_end: string | null;
  tach_hours: string | null;

  /** Aircraft state: what the next pilot is walking out to. */
  fuel_remaining_after: string | null;
  /** A transaction: what someone spent, in integer minor units. */
  fuel_added_qty: string | null;
  fuel_added_cost_cents: number | null;
  currency: string | null;
}

/**
 * The post-flight entry (§3.4) — the most important screen in the product.
 *
 * Every meter and fuel field is optional because the form records whatever
 * was actually read. What is not optional is that *some* meter ended: that is
 * what a flight record is for.
 */
/**
 * The same flights as `FlightResponse[]`, added up by the server.
 *
 * §8.2: the client never computes anything that matters. A total on a
 * dashboard matters, and the list endpoint caps at 200 rows — so adding them
 * up on the device is wrong in the direction nobody notices.
 *
 * Both meters, never one derived from the other (§3.4). A caller asking for
 * "hours" has to say which, and §11 requires whatever displays it to say so
 * too. Hours are strings for the same reason every meter is: they are
 * `numeric` in Postgres, and a float round-trip is how a maintenance
 * countdown drifts.
 *
 * Not a pilot's logbook total. §3.4 draws that line at experience totals;
 * these filters are the aeroplane and the member, for utilisation and for
 * reconciliation.
 */
export interface FlightSummaryResponse {
  flights: number;
  /** Zero rather than null for an empty set: "none yet" is an answer. */
  hobbs_hours: string;
  tach_hours: string;
  /** Calendar days, or null when there are no flights to bound. */
  first_flight_date: string | null;
  last_flight_date: string | null;
}

export interface CreateFlightRequest {
  aircraft_id: string;
  flight_date: string;
  /** A membership id. Defaults to the caller's own. */
  flown_by?: string;
  departed_from?: string;
  arrived_at?: string;
  remarks?: string;

  hobbs_start?: string;
  hobbs_end?: string;
  tach_start?: string;
  tach_end?: string;

  fuel_remaining_after?: string;
  fuel_added_qty?: string;
  fuel_added_cost_cents?: number;
  receipt_reference?: string;

  /** When the flight ended. Defaults to now; an offline client sends its own. */
  recorded_at?: string;
}

// ---------------------------------------------------------------------------
// Maintenance (§3.6)
//
// The second half of the core loop. Meters advance from flights, items tick
// down against them, and an overdue item or a grounding squawk reaches the
// scheduler through one resolved view rather than through every booking path
// asking about squawks itself (§3.3).
//
// `squawks` is a separate resource from `maintenance` here for the same
// reason it is separate in §1.5: a pilot reports a defect and does not sign
// off the work. Collapsing them makes the central permission line in the
// product inexpressible.
// ---------------------------------------------------------------------------

export type MaintenanceItemStatus = 'active' | 'archived';
export type MaintenanceState = 'ok' | 'due_soon' | 'overdue' | 'inactive';
export type SquawkSeverity = 'advisory' | 'minor' | 'major' | 'grounding';
export type SquawkStatus = 'open' | 'deferred' | 'resolved';
export type DeferralBasis = 'mel' | 'cdl' | 'far_91_213' | 'other';
export type ComplianceKind = 'inspection' | 'ad' | 'sb' | 'overhaul' | 'repair' | 'other';
export type ComplianceMethod = 'inspection' | 'modification' | 'replacement' | 'recurring';
export type WorkOrderStatus = 'open' | 'closed';
export type SignoffKind = 'a_and_p' | 'ia' | 'repairman' | 'owner' | 'other';

/**
 * An item, with the resolution the server did for it.
 *
 * The countdown is computed server-side and sent whole. §8.2: the client
 * never computes anything that matters, and "is this aeroplane legal to fly"
 * is as close to mattering as this product gets.
 */
export interface MaintenanceItemResponse {
  id: string;
  aircraft_id: string;
  name: string;
  description: string | null;
  regulatory_reference: string | null;
  status: MaintenanceItemStatus;
  /** Whether going overdue stops the aircraft flying (§3.3). */
  grounds_aircraft: boolean;

  due_on: string | null;
  due_at_hours: string | null;
  due_at_cycles: number | null;
  /** Which meter the hours are counted on — tach for engine items (§3.6). */
  hours_meter: MaintenanceMeter;
  current_hours: string | null;

  interval_months: number | null;
  interval_hours: string | null;
  interval_cycles: number | null;

  days_remaining: number | null;
  hours_remaining: string | null;
  cycles_remaining: number | null;
  state: MaintenanceState;

  last_complied_on: string | null;
  /**
   * False means nobody has recorded compliance yet — seeded from the preset
   * library and never confirmed. The UI says "not recorded", not "overdue":
   * they are different claims and only one of them is about the aircraft.
   */
  ever_complied: boolean;
  /** Which preset version seeded this row. Provenance only (§3.6). */
  template_code: string | null;
  template_version: number | null;
}

export interface CreateMaintenanceItemRequest {
  name: string;
  description?: string;
  regulatory_reference?: string;
  grounds_aircraft?: boolean;
  due_on?: string;
  due_at_hours?: string;
  due_at_cycles?: number;
  hours_meter?: MaintenanceMeter;
  interval_months?: number;
  interval_hours?: string;
  interval_cycles?: number;
  warn_within_days?: number;
  warn_within_hours?: string;
}

export type UpdateMaintenanceItemRequest = Partial<CreateMaintenanceItemRequest> & {
  status?: MaintenanceItemStatus;
};

/** One entry in the preset library (§3.6), offered before it is instantiated. */
export interface MaintenanceTemplateResponse {
  code: string;
  version: number;
  name: string;
  description: string | null;
  regulatory_reference: string | null;
  auto_instantiate: boolean;
  interval_months: number | null;
  interval_hours: string | null;
  hours_meter: MaintenanceMeter | null;
  grounds_aircraft: boolean;
}

export interface ComplianceRecordResponse {
  id: string;
  aircraft_id: string;
  maintenance_item_id: string | null;
  work_order_id: string | null;
  kind: ComplianceKind;
  reference: string | null;
  title: string;
  method: ComplianceMethod | null;
  complied_on: string;
  complied_at_hours: string | null;
  complied_at_cycles: number | null;
  hours_meter: MaintenanceMeter | null;
  next_due_on: string | null;
  next_due_at_hours: string | null;
  signed_by: string | null;
  signed_certificate: string | null;
  supersedes_id: string | null;
  note: string | null;
  recorded_at: string;
  /** Set when a later correction supersedes this row. Both stay (§3.6). */
  superseded: boolean;
}

/**
 * Recording compliance. Append-only: a correction is a new record naming the
 * one it supersedes, and nothing here is ever edited.
 */
export interface CreateComplianceRecordRequest {
  aircraft_id: string;
  maintenance_item_id?: string;
  work_order_id?: string;
  kind: ComplianceKind;
  reference?: string;
  title: string;
  method?: ComplianceMethod;
  complied_on: string;
  complied_at_hours?: string;
  complied_at_cycles?: number;
  hours_meter?: MaintenanceMeter;
  /** A recurring AD states its own next due point; it is not an interval. */
  next_due_on?: string;
  next_due_at_hours?: string;
  signed_by?: string;
  signed_certificate?: string;
  supersedes_id?: string;
  note?: string;
}

export interface SquawkResponse {
  id: string;
  aircraft_id: string;
  aircraft_registration: string;
  summary: string;
  details: string | null;
  severity: SquawkSeverity;
  /** Whether the aircraft flies. Separate from severity, because it is a
   * separate judgement: an inspection can ground something reported as minor. */
  grounding: boolean;
  status: SquawkStatus;
  reported_by: string;
  reported_by_email: string | null;
  reported_at: string;
  found_on_flight_id: string | null;
  resolved_at: string | null;
  resolution_note: string | null;
  work_order_id: string | null;
  deferrals: SquawkDeferralResponse[];
}

export interface SquawkDeferralResponse {
  id: string;
  basis: DeferralBasis;
  reference: string | null;
  expires_on: string | null;
  note: string | null;
  deferred_at: string;
}

export interface CreateSquawkRequest {
  aircraft_id: string;
  summary: string;
  details?: string;
  severity?: SquawkSeverity;
  grounding?: boolean;
  /** Filed from the post-flight screen, so the flight it was found on. */
  found_on_flight_id?: string;
  /** §8.2: when it was noticed, which is not when the phone found signal. */
  reported_at?: string;
}

/**
 * Resolving or deferring needs `maintenance: write`, not `squawks: write` —
 * a pilot reports a defect and does not close it. The server enforces that;
 * the client hides the buttons (§8.1).
 */
export interface UpdateSquawkRequest {
  details?: string;
  severity?: SquawkSeverity;
  grounding?: boolean;
  status?: SquawkStatus;
  resolution_note?: string;
  work_order_id?: string;
}

export interface CreateSquawkDeferralRequest {
  basis: DeferralBasis;
  reference?: string;
  expires_on?: string;
  note?: string;
}

export interface WorkOrderResponse {
  id: string;
  aircraft_id: string;
  reference: string | null;
  description: string;
  performed_by: string | null;
  performed_on: string | null;
  parts: unknown;
  labor_hours: string | null;
  /** §3.7 rule 3: integer minor units, never a float. */
  cost_cents: number | null;
  currency: string;
  status: WorkOrderStatus;
  signoff_name: string | null;
  signoff_certificate: string | null;
  signoff_kind: SignoffKind | null;
  /** Once this is set the record is closed to edits — a signature is not
   * revisable, and a correction is a new work order. */
  signed_at: string | null;
}

export interface CreateWorkOrderRequest {
  aircraft_id: string;
  description: string;
  reference?: string;
  performed_by?: string;
  performed_on?: string;
  parts?: unknown[];
  labor_hours?: string;
  cost_cents?: number;
}

export interface UpdateWorkOrderRequest {
  description?: string;
  reference?: string;
  performed_by?: string;
  performed_on?: string;
  parts?: unknown[];
  labor_hours?: string;
  cost_cents?: number;
  status?: WorkOrderStatus;
  /** Signing. Supplying these closes the record to every further edit. */
  signoff_name?: string;
  signoff_certificate?: string;
  signoff_kind?: SignoffKind;
}

/**
 * §3.3: the one place that decides whether an aircraft may be booked.
 *
 * The scheduler consults this rather than querying squawks, so the rule
 * exists once. `grounding_reasons` is plain language because a club calling
 * a member to cancel their Saturday has to be able to say what did it.
 */
export interface AircraftAvailabilityResponse {
  aircraft_id: string;
  registration: string;
  aircraft_status: AircraftStatus;
  available: boolean;
  grounding_squawks: number;
  overdue_grounding_items: number;
  grounding_reasons: string[];
}

// ---------------------------------------------------------------------------
// Scheduling (§3.3)
//
// A reservation holds resource *lines* rather than an aircraft id. Today
// every one has exactly one line of type 'aircraft', which is why the wire
// shape flattens it — but the shape underneath is what lets an instructor be
// a second line later without the conflict logic changing.
// ---------------------------------------------------------------------------

export type ReservationStatus = 'booked' | 'cancelled' | 'completed';

export interface ReservationResponse {
  id: string;
  aircraft_id: string;
  aircraft_registration: string;
  /** A membership id — who will be flying, not who filled in the form. */
  booked_by: string;
  booked_by_name: string | null;
  booked_by_email: string | null;
  starts_at: string;
  ends_at: string;
  purpose: string | null;
  notes: string | null;
  status: ReservationStatus;
  /**
   * §3.3: when an aircraft is grounded its future bookings are flagged for
   * the club to act on, never cancelled by the system — somebody has to call
   * those members, and only they know what else was arranged around it.
   */
  needs_review: boolean;
  review_reason: string | null;
  /** Whether this viewer may change it: their own, or any if they administer. */
  can_edit: boolean;
}

export interface CreateReservationRequest {
  aircraft_id: string;
  starts_at: string;
  ends_at: string;
  purpose?: string;
  notes?: string;
  /** A membership id. Defaults to the caller's; only an admin may pass another. */
  booked_by?: string;
}

export interface UpdateReservationRequest {
  starts_at?: string;
  ends_at?: string;
  purpose?: string;
  notes?: string;
  /** Clearing the review flag is the admin saying they have made the call. */
  needs_review?: boolean;
}

/** An admin taking the aeroplane off the calendar: annual, AOG, owner-held. */
export interface BlackoutResponse {
  id: string;
  aircraft_id: string;
  aircraft_registration: string;
  reason: string;
  starts_at: string;
  ends_at: string;
}

export interface CreateBlackoutRequest {
  aircraft_id: string;
  reason: string;
  starts_at: string;
  ends_at: string;
}

/** §3.5: the club checkout, and deliberately nothing about the pilot. */
export interface AuthorizationResponse {
  membership_id: string;
  aircraft_id: string;
  email: string;
  name: string | null;
  authorized_on: string;
  authorized_by_email: string | null;
  note: string | null;
}

export interface CreateAuthorizationRequest {
  membership_id: string;
  note?: string;
}

// ---------------------------------------------------------------------------
// Member billing (§3.7, M6)
//
// Pilot → their club. Not platform billing, which is the tenant →
// FlightSquare. §3.7 opens by insisting the two never share a name, and
// nothing here touches the other one.
//
// **v1 produces statements and does not move money.** Recording that somebody
// paid is a manual adjustment, which is the smallest thing that makes a
// ledger balance.
// ---------------------------------------------------------------------------

export type RateSource = 'member' | 'aircraft';
export type StatementLineKind = 'charge' | 'credit' | 'adjustment';

export interface RateResponse {
  id: string;
  aircraft_id: string;
  aircraft_registration: string;
  /** Integer minor units, always. Never a float, never a decimal string. */
  amount_cents: number;
  currency: string;
  effective_from: string;
  /** Set on a member override; absent on the club's own rate. */
  membership_id?: string;
  member_email?: string;
}

export interface CreateRateRequest {
  aircraft_id: string;
  amount_cents: number;
  /** Defaults to today. A rate change is a new row, never an edit (§3.7). */
  effective_from?: string;
  /** Present for a member-specific override; absent for the club rate. */
  membership_id?: string;
}

/**
 * One line of a statement.
 *
 * A charge says which rule priced it, because a statement that cannot
 * explain itself is a statement somebody disputes.
 */
export interface StatementLine {
  id: string;
  kind: StatementLineKind;
  /** When the ledger row was written. The posting instant, not the event. */
  occurred_at: string;
  /**
   * The date the line is *about*, and the one every period filter uses.
   *
   * For a charge or a fuel credit that is the flight's date, not the moment
   * somebody got round to logging it — §8.2 says those differ, routinely by
   * days, and a treasurer closing September means the flights flown in
   * September. For an adjustment or a reversal it is the day the treasurer
   * acted, because that is the event being recorded.
   */
  occurred_on: string;
  description: string;
  /** Positive is owed, negative is credited back. Integer minor units. */
  amount_cents: number;
  currency: string;
  flight_id: string | null;
  /** Charges only: which layer of §3.7's chain answered. */
  rate_source: RateSource | null;
  rate_cents: number | null;
  meter: string | null;
  meter_hours: string | null;
  /** Set when a later entry reverses this one. Both rows stay. */
  reversed: boolean;
  reverses_id: string | null;
}

export interface StatementResponse {
  membership_id: string;
  email: string;
  name: string | null;
  from: string | null;
  to: string | null;
  lines: StatementLine[];
  charged_cents: number;
  credited_cents: number;
  adjusted_cents: number;
  /** What they owe at the end of the period. Charges − credits + adjustments. */
  balance_cents: number;
  currency: string;
}

/** The treasurer's view: everybody, and what each of them owes. */
export interface MemberBalanceResponse {
  membership_id: string;
  email: string;
  name: string | null;
  balance_cents: number;
  currency: string;
}

export interface CreateAdjustmentRequest {
  membership_id: string;
  /** Negative records a payment; positive adds something they owe. */
  amount_cents: number;
  /** Not optional: an unexplained line in a ledger is an argument later. */
  reason: string;
}

export interface ReverseChargeRequest {
  reason: string;
}
