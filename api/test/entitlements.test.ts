import { describe, expect, it } from 'vitest';

import { ENTITLEMENTS, ALL_KEYS, isDeclared } from '../src/entitlements/registry.js';
import { Entitlements } from '../src/entitlements/resolver.js';
import { Unlimited, limitOf, isUnlimited } from '../src/entitlements/values.js';

function entitlements(
  plan: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Entitlements {
  return new Entitlements({
    planCode: 'test',
    plan: new Map(Object.entries(plan)),
    overrides: new Map(Object.entries(overrides)),
  });
}

/**
 * §1.4's chain is the whole feature. It resolves in one order, always, and
 * the order is what makes support answerable: "which layer gave them that?"
 */
describe('entitlement resolution', () => {
  it('prefers a tenant override to a plan', () => {
    const e = entitlements({ 'aircraft.active': 1 }, { 'aircraft.active': 7 });
    expect(e.quota('aircraft.active')).toEqual(limitOf(7));
    expect(e.resolve('aircraft.active').source).toBe('override');
  });

  it('prefers a plan to the global default', () => {
    const e = entitlements({ 'aircraft.active': 3 });
    expect(e.quota('aircraft.active')).toEqual(limitOf(3));
    expect(e.resolve('aircraft.active').source).toBe('plan');
  });

  it('falls through to the global default, so resolution cannot fail', () => {
    const e = entitlements({});
    // Every key resolves, for a tenant whose plan says nothing at all.
    for (const key of ALL_KEYS) {
      expect(() => e.resolve(key), key).not.toThrow();
      expect(e.resolve(key).source, key).toBe('default');
    }
  });

  it('keeps unlimited a kind rather than a number', () => {
    const e = entitlements({ 'aircraft.active': 'unlimited' });
    const quota = e.quota('aircraft.active');
    expect(isUnlimited(quota)).toBe(true);
    expect(quota).toEqual(Unlimited);

    // The failure this prevents: a sentinel that compares as a real limit.
    // There is no number in the value at all, so `>= limit` cannot typecheck.
    expect(quota).not.toHaveProperty('value');
  });

  it('refuses a value of the wrong shape rather than coercing it', () => {
    // A flag holding a number, or a quota holding a boolean, is a data error.
    // Silently coercing would disable a feature for a whole plan invisibly.
    expect(() => entitlements({ member_billing: 1 }).flag('member_billing')).toThrow(
      /expected a boolean/,
    );
    expect(() => entitlements({ 'aircraft.active': true }).quota('aircraft.active')).toThrow(
      /expected a number or "unlimited"/,
    );
  });

  it('resolves the same key to the same object within a request', () => {
    const e = entitlements({ 'aircraft.active': 2 });
    expect(e.resolve('aircraft.active')).toBe(e.resolve('aircraft.active'));
  });
});

describe('the registry', () => {
  it('declares a global default for every key, so resolution is total', () => {
    for (const key of ALL_KEYS) {
      expect(ENTITLEMENTS[key], key).toHaveProperty('default');
    }
  });

  it('has no flights quota, on any tier', () => {
    // §4.2: a tenant that hits a cap stops logging, the meters go stale, and
    // every maintenance number becomes wrong. The key not existing is the
    // enforcement — a key that is absent cannot be set by mistake.
    expect(ALL_KEYS.filter((k) => k.startsWith('flights'))).toEqual([]);
    expect(isDeclared('flights.per_month')).toBe(false);
  });

  it('has no scheduling flag', () => {
    // Scheduling is unused in the solo case, never unavailable. One pilot
    // means an empty reservations table, not a feature switched off.
    expect(ALL_KEYS.filter((k) => k.includes('scheduling'))).toEqual([]);
  });

  it('keeps history retention unlimited by default', () => {
    // Airframe hours and compliance follow an aircraft for its entire life.
    expect(isUnlimited(entitlements({}).quota('history.retention_days'))).toBe(true);
  });
});
