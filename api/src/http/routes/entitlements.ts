import type { FastifyInstance } from 'fastify';
import type { EntitlementsResponse, ResolvedQuota } from '@flightsquare/shared';

import { isUnlimited } from '../../entitlements/values.js';
import type { QuotaValue } from '../../entitlements/values.js';

function serialiseQuota(quota: QuotaValue): number | 'unlimited' {
  return isUnlimited(quota) ? 'unlimited' : (quota as { value: number }).value;
}

export async function entitlementsRoutes(app: FastifyInstance): Promise<void> {
  /**
   * What this tenant may do, resolved.
   *
   * §8.1: the client fetches this and hides UI accordingly. It must never
   * carry a hardcoded table of what Pro includes — that table goes stale on
   * the App Store and cannot be corrected without a release. Which is also
   * why the response carries values rather than a plan name for the client to
   * interpret.
   *
   * Every member may read it: hiding a button correctly requires knowing what
   * is switched on, and the values are not secret. The gates that matter are
   * enforced server-side on the endpoints themselves (§1.6).
   */
  app.get(
    '/entitlements',
    { config: { requiresTenant: true, permission: 'any_member' } },
    async (request) => {
      const { entitlements, permissions } = await request.loadGates();

      const flags: Record<string, boolean> = {};
      const quotas: Record<string, ResolvedQuota> = {};
      const config: Record<string, string> = {};

      for (const resolved of entitlements.all()) {
        const kind = entitlements.kindOf(resolved.key);
        if (kind === 'flag') {
          flags[resolved.key] = resolved.value as boolean;
        } else if (kind === 'quota') {
          quotas[resolved.key] = {
            limit: serialiseQuota(resolved.value as QuotaValue),
            // §7.8: which layer supplied it. Most support tickets are "the
            // customer says they cannot do X", and this ends that ticket class.
            source: resolved.source,
          };
        } else {
          config[resolved.key] = resolved.value as string;
        }
      }

      return {
        plan_code: entitlements.planCode,
        flags,
        quotas,
        config,
        permissions: permissions.toJSON(),
        // §8.1 is additive-only: a new field, never a changed one. An old
        // build that has never heard of scopes keeps working and simply
        // shows a little more than it needs to, which the server refuses
        // anyway.
        permission_scopes: permissions.scopesToJSON(),
      } satisfies EntitlementsResponse;
    },
  );
}
