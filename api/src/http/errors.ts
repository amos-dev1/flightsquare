import type {
  ClientTooOldBody,
  ConflictBody,
  ForbiddenBody,
  NotFoundBody,
  QuotaExceededBody,
  RateLimitedBody,
  Remediation,
  TenantRequiredBody,
  UnauthorizedBody,
} from '@flightsquare/shared';

/**
 * The §1.6 gates, and nothing else.
 *
 *   Feature     is this capability in the tenant's entitlements?   404
 *   Permission  does this user hold the required level?            403
 *   Quota       is the tenant under its numeric limit?             402
 *
 * Checked in that order, always. Feature first is what makes a gated
 * capability indistinguishable from one that does not exist: a tenant
 * without the maintenance module cannot tell from status codes whether the
 * module exists, whether they would be allowed to use it, or how close to a
 * limit they are.
 *
 * 429 is rate limiting — requests per unit time — and is never a plan quota.
 *
 * Upsell copy belongs in the UI, reached through entitlement data the client
 * already has. Never soften a required 404 into a 402 or 403 because the
 * message would be friendlier.
 */

export abstract class ApiError extends Error {
  abstract readonly statusCode: number;
  /**
   * The wire shape, typed from @flightsquare/shared so the contract the
   * clients are generated against and the thing actually sent cannot drift.
   */
  abstract toBody(): ApiErrorBodies;
}

type ApiErrorBodies =
  | NotFoundBody
  | ForbiddenBody
  | QuotaExceededBody
  | RateLimitedBody
  | ClientTooOldBody
  | UnauthorizedBody
  | TenantRequiredBody
  | ConflictBody;

/**
 * A gated feature, and also a resource in another tenant. §6: errors do not
 * leak cross-tenant existence — "aircraft not found" for a tail number in
 * someone else's tenant, never "you don't have access to that aircraft".
 *
 * If the gated capability is a *field* on an otherwise-visible resource,
 * omit the field instead of 404-ing the whole resource.
 */
export class NotFoundError extends ApiError {
  readonly statusCode = 404;
  constructor(message = 'not found') {
    super(message);
  }
  toBody(): NotFoundBody {
    return { error: 'not_found' };
  }
}

export class PermissionError extends ApiError {
  readonly statusCode = 403;
  constructor(
    readonly resource: string,
    readonly level: 'read' | 'write',
  ) {
    super(`requires ${resource}:${level}`);
  }
  toBody(): ForbiddenBody {
    return { error: 'forbidden', resource: this.resource, level: this.level };
  }
}

/** Machine-readable so the UI can offer the right remediation, per §1.6. */
export class QuotaExceededError extends ApiError {
  readonly statusCode = 402;
  constructor(
    readonly quota: string,
    readonly limit: number,
    readonly current: number,
    readonly remediation: Remediation[] = ['upgrade'],
  ) {
    super(`quota ${quota} exhausted`);
  }
  toBody(): QuotaExceededBody {
    return {
      error: 'quota_exceeded',
      quota: this.quota,
      limit: this.limit,
      current: this.current,
      remediation: this.remediation,
    };
  }
}

export class RateLimitError extends ApiError {
  readonly statusCode = 429;
  constructor(readonly retryAfterSeconds: number) {
    super('rate limited');
  }
  toBody(): RateLimitedBody {
    return { error: 'rate_limited', retry_after: this.retryAfterSeconds };
  }
}

/** §8.1's minimum-supported-version handshake. */
export class ClientTooOldError extends ApiError {
  readonly statusCode = 426;
  constructor(
    readonly client: string,
    readonly minimumVersion: string,
  ) {
    super(`client ${client} must be at least ${minimumVersion}`);
  }
  toBody(): ClientTooOldBody {
    return {
      error: 'client_too_old',
      client: this.client,
      minimum_version: this.minimumVersion,
    };
  }
}

/**
 * A duplicate on signup. The body is deliberately identical whether the slug
 * or the email collided — see auth.provision_tenant's comment.
 */
export class ConflictError extends ApiError {
  readonly statusCode = 409;
  constructor(readonly reason: string) {
    super(reason);
  }
  toBody(): ConflictBody {
    return { error: 'conflict', reason: this.reason };
  }
}

/**
 * No session. Deliberately says nothing about why — expired, absent,
 * malformed and "we have not built sessions yet" are indistinguishable to
 * the caller.
 */
export class UnauthorizedError extends ApiError {
  readonly statusCode = 401;
  constructor() {
    super('unauthorized');
  }
  toBody(): UnauthorizedBody {
    return { error: 'unauthorized' };
  }
}

/**
 * Authenticated, but the session has not picked a tenant and the route needs
 * one. A distinct code rather than a reused 403: §1.6's 403 answers "does
 * this user hold the required level on the resource", which is a different
 * question from "which tenant are we even in".
 */
export class TenantRequiredError extends ApiError {
  readonly statusCode = 403;
  constructor() {
    super('no tenant selected for this session');
  }
  toBody(): TenantRequiredBody {
    return { error: 'tenant_required' };
  }
}

const PG_UNIQUE_VIOLATION = '23505';
const PG_INSUFFICIENT_PRIVILEGE = '42501';

export function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: unknown }).code === PG_UNIQUE_VIOLATION;
}

/**
 * A row-level security refusal reaching this layer is a bug above it, not a
 * client error: it means the API tried to write outside its own tenant. It
 * must never be reported to the client as anything but a 500.
 */
export function isRlsRefusal(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: unknown }).code === PG_INSUFFICIENT_PRIVILEGE;
}
