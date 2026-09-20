import {
  ALL_KEYS,
  ENTITLEMENTS,
  declarationOf,
  type ConfigKey,
  type EntitlementKey,
  type FlagKey,
  type QuotaKey,
} from './registry.js';
import {
  parseConfig,
  parseFlag,
  parseQuota,
  type QuotaValue,
} from './values.js';

/** Which layer supplied the value. §7.8's inspector exists to show this. */
export type EntitlementSource = 'override' | 'plan' | 'default';

export interface ResolvedEntitlement {
  key: EntitlementKey;
  value: boolean | QuotaValue | string;
  source: EntitlementSource;
}

export interface EntitlementLayers {
  planCode: string;
  /** Values from plan_entitlements for this tenant's plan. */
  plan: ReadonlyMap<string, unknown>;
  /** Values from tenant_entitlement_overrides for this tenant. */
  overrides: ReadonlyMap<string, unknown>;
}

/**
 * §1.4's chain, and nothing else: tenant override → plan → global default.
 * First layer that has a value for the key wins. There is no fourth layer and
 * no per-call override argument.
 *
 * Pure by construction — it takes the layers rather than fetching them, so it
 * cannot consult the request, the user, or the clock.
 */
export class Entitlements {
  readonly planCode: string;
  readonly #layers: EntitlementLayers;
  readonly #cache = new Map<EntitlementKey, ResolvedEntitlement>();

  constructor(layers: EntitlementLayers) {
    this.#layers = layers;
    this.planCode = layers.planCode;
  }

  resolve(key: EntitlementKey): ResolvedEntitlement {
    const cached = this.#cache.get(key);
    if (cached) return cached;

    const declaration = declarationOf(key);
    let raw: unknown;
    let source: EntitlementSource;

    if (this.#layers.overrides.has(key)) {
      raw = this.#layers.overrides.get(key);
      source = 'override';
    } else if (this.#layers.plan.has(key)) {
      raw = this.#layers.plan.get(key);
      source = 'plan';
    } else {
      // Always present, which is what makes resolution total.
      const resolved: ResolvedEntitlement = {
        key,
        value: declaration.default,
        source: 'default',
      };
      this.#cache.set(key, resolved);
      return resolved;
    }

    const value =
      declaration.kind === 'flag'
        ? parseFlag(raw, key)
        : declaration.kind === 'quota'
          ? parseQuota(raw, key)
          : parseConfig(raw, key);

    const resolved: ResolvedEntitlement = { key, value, source };
    this.#cache.set(key, resolved);
    return resolved;
  }

  flag(key: FlagKey): boolean {
    return this.resolve(key).value as boolean;
  }

  quota(key: QuotaKey): QuotaValue {
    return this.resolve(key).value as QuotaValue;
  }

  config(key: ConfigKey): string {
    return this.resolve(key).value as string;
  }

  /** Every key resolved, with its source. What §7.8's inspector renders. */
  all(): ResolvedEntitlement[] {
    return ALL_KEYS.map((key) => this.resolve(key));
  }

  kindOf(key: EntitlementKey): 'flag' | 'quota' | 'config' {
    return ENTITLEMENTS[key].kind;
  }
}
