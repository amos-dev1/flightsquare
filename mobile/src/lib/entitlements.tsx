import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { EntitlementsResponse } from '@flightsquare/shared';

import { api, withAuth } from './api';

/**
 * §1.4's resolved entitlements, fetched once for the whole app.
 *
 * §8.1: fetched, never compiled in. A table of what Pro includes would go
 * stale on the App Store and could not be corrected without a release — so
 * every question of the form "does this club have X" is asked of the server
 * and answered with data.
 *
 * A context rather than a hook per screen because several screens want the
 * same answer in the same second: the tab bar decides whether Charges
 * exists, and the dashboard wants the aircraft count out of
 * `quotas['aircraft.active'].current` and the billing flag for the balance.
 * One fetch, one answer, no chance of two screens disagreeing.
 *
 * `undefined` until it arrives, and that distinction is load-bearing: a
 * screen that treats "not yet known" as "not entitled" shows a tab and takes
 * it away a second later, which is worse than a beat of patience.
 */

interface Entitlements {
  resolved: EntitlementsResponse | undefined;
  /** Whether a fetch has finished, successfully or not. */
  settled: boolean;
  refresh: () => Promise<void>;
}

const EntitlementsContext = createContext<Entitlements>({
  resolved: undefined,
  settled: false,
  refresh: async () => undefined,
});

export function EntitlementsProvider({ children }: { children: ReactNode }) {
  const [resolved, setResolved] = useState<EntitlementsResponse | undefined>(undefined);
  const [settled, setSettled] = useState(false);

  const refresh = async (): Promise<void> => {
    try {
      setResolved(await withAuth(() => api.entitlements()));
    } catch {
      // Offline at launch, or a tenant that has gone away. Leave whatever
      // was known last in place: nothing here is a security control, and a
      // stale flag hides a tab for a moment rather than exposing anything.
      // The gates that matter are enforced server-side, every time (§1.6).
    } finally {
      setSettled(true);
    }
  };

  useEffect(() => {
    void refresh();
    // Once, on mount. A plan change arrives through a webhook on the server
    // and shows up on the next launch or pull-to-refresh, which is soon
    // enough for something a club does a handful of times a year.
  }, []);

  return (
    <EntitlementsContext.Provider value={{ resolved, settled, refresh }}>
      {children}
    </EntitlementsContext.Provider>
  );
}

export function useEntitlements(): Entitlements {
  return useContext(EntitlementsContext);
}

/** A flag, false until proven otherwise. */
export function useFlag(key: string): boolean {
  return useEntitlements().resolved?.flags[key] === true;
}

/**
 * What a quota permits and what is being used, from §4.5's counters.
 *
 * `current` is absent rather than zero for a quota nothing counts yet, so a
 * screen can tell "none used" from "not measured" — which is why this hands
 * back the whole thing instead of a number.
 */
export function useQuota(key: string): { limit: number | 'unlimited'; current?: number } | undefined {
  return useEntitlements().resolved?.quotas[key];
}

/** What this member holds. Cosmetic only — the server decides (§8.1). */
export function usePermission(resource: string): 'none' | 'read' | 'write' {
  return useEntitlements().resolved?.permissions[resource] ?? 'none';
}

/**
 * Whether anybody shares these aeroplanes.
 *
 * The constitution is emphatic that **scheduling need tracks pilot count,
 * not ownership** — "a single owner who shares their aircraft with a partner
 * and two friends has a real scheduling problem", and "a solo owner flying
 * alone needs no scheduling at all". So this asks the only question that
 * actually creates the need, and deliberately does not ask the plan's name:
 * §1.3 forbids branching on tenant identity, §4.3 makes a tier rows in
 * `plans`, and a Pro tenant with one pilot has no more use for a calendar
 * than a free one.
 *
 * **Nothing here makes scheduling unavailable.** §4.3 says it is *unused* in
 * the solo case, never switched off, and that is exactly what this is: no
 * feature flag, no 404, no second code path. The endpoints keep working, the
 * screen keeps working, RLS keeps deciding — the calendar simply is not led
 * with when there is nobody to share with. The moment a second member is
 * invited the count is two and it is all already there, already correct.
 *
 * Defaults to **true** while the count is unknown. Showing a calendar nobody
 * needs is a smaller error than hiding one somebody does, and it keeps the
 * "never unavailable" promise during the beat before entitlements arrive.
 */
export function useMoreThanOnePilot(): boolean {
  const current = useQuota('members.active')?.current;
  return current === undefined ? true : current > 1;
}
