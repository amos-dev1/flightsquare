import { Unlimited, limitOf, type QuotaValue } from './values.js';

/**
 * Every entitlement key, with a global default.
 *
 * This is what makes resolution **total** (§1.4): the chain is tenant
 * override → plan → global default, and because the last layer always has a
 * value, resolution cannot fail or return "unknown". A key that is not
 * declared here is a startup error, never a runtime `false` — boot fails
 * loudly rather than silently disabling a feature in production.
 *
 * §1.3: anything that varies between tenants is one of exactly three things —
 * a flag, a quota, or a config value. If a requirement seems to need a
 * fourth, that is a design conversation, not a conditional.
 *
 * Two keys that are deliberately absent, and should stay that way:
 *
 *   flights.* — there is no flight quota on any tier. A tenant that hits a cap
 *   stops logging, the meters go stale, and every maintenance number in the
 *   product becomes wrong (§4.2). The key not existing is the enforcement.
 *
 *   scheduling — not a flag. Scheduling is *unused* in the solo case, never
 *   *unavailable*: one pilot means an empty reservations table, not a feature
 *   switched off, and the moment a second pilot arrives it already works.
 */

export type EntitlementKind = 'flag' | 'quota' | 'config';

interface FlagDeclaration {
  kind: 'flag';
  default: boolean;
  note?: string;
}
interface QuotaDeclaration {
  kind: 'quota';
  default: QuotaValue;
  /** stock: a count now · flow: a count per period · window: how far back */
  shape: 'stock' | 'flow' | 'window';
  note?: string;
}
interface ConfigDeclaration {
  kind: 'config';
  default: string;
  note?: string;
}

export type Declaration = FlagDeclaration | QuotaDeclaration | ConfigDeclaration;

export const ENTITLEMENTS = {
  // ---- flags (§4.1), gated with 404 -------------------------------------
  maintenance_module: {
    kind: 'flag',
    default: true,
    note: 'Every tier has maintenance tracking (§4.3); no plan row overrides it.',
  },
  member_billing: {
    kind: 'flag',
    default: false,
    note: 'Pro and up. A free tenant has one member, so there is nobody to bill (§3.7).',
  },
  custom_branding: { kind: 'flag', default: false },
  api_access: { kind: 'flag', default: false },
  sso_saml: { kind: 'flag', default: false },
  webhooks: { kind: 'flag', default: false },
  audit_export: { kind: 'flag', default: false },

  // ---- stock quotas: a count at a point in time, enforced at creation ----
  'aircraft.active': { kind: 'quota', shape: 'stock', default: limitOf(1) },
  'members.active': { kind: 'quota', shape: 'stock', default: limitOf(1) },
  'storage.bytes': { kind: 'quota', shape: 'stock', default: limitOf(1073741824) },

  // ---- flow quotas: a count within a period ------------------------------
  'exports.per_month': { kind: 'quota', shape: 'flow', default: limitOf(2) },
  'api.calls_per_day': { kind: 'quota', shape: 'flow', default: limitOf(0) },

  // ---- window quotas: how far back data stays visible --------------------
  'history.retention_days': {
    kind: 'quota',
    shape: 'window',
    default: Unlimited,
    note:
      'The mechanism exists and is unused. Airframe hours and compliance follow ' +
      'an aircraft for its entire life and are consulted at every annual, every ' +
      'prebuy and every sale; hiding them behind a plan would be the fastest way ' +
      'to lose trust in this market (§4.2).',
  },

  // ---- config (§1.3) -----------------------------------------------------
  'units.fuel': { kind: 'config', default: 'gallons' },
} as const satisfies Record<string, Declaration>;

export type EntitlementKey = keyof typeof ENTITLEMENTS;

export type FlagKey = {
  [K in EntitlementKey]: (typeof ENTITLEMENTS)[K]['kind'] extends 'flag' ? K : never;
}[EntitlementKey];

export type QuotaKey = {
  [K in EntitlementKey]: (typeof ENTITLEMENTS)[K]['kind'] extends 'quota' ? K : never;
}[EntitlementKey];

export type ConfigKey = {
  [K in EntitlementKey]: (typeof ENTITLEMENTS)[K]['kind'] extends 'config' ? K : never;
}[EntitlementKey];

export function isDeclared(key: string): key is EntitlementKey {
  return Object.hasOwn(ENTITLEMENTS, key);
}

export function declarationOf(key: EntitlementKey): Declaration {
  return ENTITLEMENTS[key] as Declaration;
}

export const ALL_KEYS = Object.keys(ENTITLEMENTS) as EntitlementKey[];
