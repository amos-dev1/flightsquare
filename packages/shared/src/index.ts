/**
 * The API contract — the shapes a client can rely on, and nothing else.
 *
 * This package is **types only and has no build step**. Everything here is
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
