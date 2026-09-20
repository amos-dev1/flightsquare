/**
 * A quota is `Unlimited` or a finite `Limit`, and never a number standing in
 * for "no limit".
 *
 * §4.4 is explicit about this: do not encode unlimited as -1, 0, NULL or
 * Number.MAX_SAFE_INTEGER, because every one of those eventually gets
 * compared with `<` by accident and the comparison quietly succeeds. A tagged
 * union cannot be compared by accident — the type system stops it.
 */
export type QuotaValue =
  | { readonly kind: 'unlimited' }
  | { readonly kind: 'limit'; readonly value: number };

export const Unlimited: QuotaValue = { kind: 'unlimited' };

export function limitOf(value: number): QuotaValue {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`a quota limit must be a non-negative integer, got ${value}`);
  }
  return { kind: 'limit', value };
}

export function isUnlimited(quota: QuotaValue): boolean {
  return quota.kind === 'unlimited';
}

/** The limit to hand to assert_quota; NULL there means unlimited. */
export function limitForDatabase(quota: QuotaValue): number | null {
  return quota.kind === 'unlimited' ? null : quota.value;
}

/** Parse what came out of jsonb. Anything else is a data error, loudly. */
export function parseQuota(raw: unknown, key: string): QuotaValue {
  if (raw === 'unlimited') return Unlimited;
  if (typeof raw === 'number') return limitOf(raw);
  throw new Error(
    `entitlement ${key} is a quota but holds ${JSON.stringify(raw)}; ` +
      'expected a number or "unlimited"',
  );
}

export function parseFlag(raw: unknown, key: string): boolean {
  if (typeof raw === 'boolean') return raw;
  throw new Error(
    `entitlement ${key} is a flag but holds ${JSON.stringify(raw)}; expected a boolean`,
  );
}

export function parseConfig(raw: unknown, key: string): string {
  if (typeof raw === 'string') return raw;
  throw new Error(
    `entitlement ${key} is a config value but holds ${JSON.stringify(raw)}; expected a string`,
  );
}
