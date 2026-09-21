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
  mfa_enabled: boolean;
}

export type TenantArchetype = 'solo' | 'partnership' | 'club';

/** The current tenant, read under tenant context. */
export interface TenantResponse {
  id: string;
  slug: string;
  name: string;
  archetype: TenantArchetype;
  branding: Record<string, unknown>;
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
}

export interface EntitlementsResponse {
  plan_code: string;
  flags: Record<string, boolean>;
  quotas: Record<string, ResolvedQuota>;
  config: Record<string, string>;
  /** What this member holds, so the client can hide what they cannot do. */
  permissions: Record<string, 'none' | 'read' | 'write'>;
}

// ---------------------------------------------------------------------------
// Fleet
// ---------------------------------------------------------------------------

export type AircraftStatus = 'active' | 'archived' | 'sold';
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
}

export interface CreateAircraftRequest {
  registration: string;
  type_code?: string;
  serial_number?: string;
  year_manufactured?: number;
  home_base?: string;
  ownership?: Ownership;
  seats?: number;
  maintenance_meter?: MaintenanceMeter;
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
