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
