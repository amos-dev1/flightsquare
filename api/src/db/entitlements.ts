import { sql } from 'kysely';

import { Entitlements, type EntitlementLayers } from '../entitlements/resolver.js';
import { isDeclared, type QuotaKey } from '../entitlements/registry.js';
import { limitForDatabase, type QuotaValue } from '../entitlements/values.js';
import { Permissions, type Level } from '../permissions.js';
import { QuotaExceededError } from '../http/errors.js';
import { db } from './pool.js';
import type { Tx } from './context.js';

/**
 * Load the two data layers for the current tenant. Runs inside tenant
 * context, so every read here is scoped by policy rather than by a WHERE
 * clause this code has to remember.
 */
export async function loadEntitlements(trx: Tx): Promise<Entitlements> {
  const tenant = await trx
    .selectFrom('tenants')
    .select('plan_code')
    .executeTakeFirst();

  // The policy hid the tenant: suspended, closed or gone. Resolve against
  // nothing but defaults rather than inventing a plan.
  const planCode = tenant?.plan_code ?? 'free';

  const [planRows, overrideRows] = await Promise.all([
    trx
      .selectFrom('plan_entitlements')
      .select(['key', 'value'])
      .where('plan_code', '=', planCode)
      .execute(),
    trx
      .selectFrom('tenant_entitlement_overrides')
      .select(['key', 'value'])
      .execute(),
  ]);

  const layers: EntitlementLayers = {
    planCode,
    plan: new Map(planRows.map((r) => [r.key, r.value])),
    overrides: new Map(overrideRows.map((r) => [r.key, r.value])),
  };
  return new Entitlements(layers);
}

/**
 * What this user holds in this tenant, via their membership's role bundle.
 *
 * §1.5: permission grants are per (user, tenant) via membership — the same
 * human can be an Admin of their own aircraft and a Pilot at their club, and
 * the answer has to depend on which tenant the session is in.
 */
export async function loadPermissions(trx: Tx, userId: string): Promise<Permissions> {
  const rows = await trx
    .selectFrom('memberships')
    .innerJoin(
      'role_bundle_permissions',
      'role_bundle_permissions.role_bundle_id',
      'memberships.role_bundle_id',
    )
    .select(['role_bundle_permissions.resource', 'role_bundle_permissions.level'])
    .where('memberships.user_id', '=', userId)
    .where('memberships.status', '=', 'active')
    .execute();

  return new Permissions(new Map(rows.map((r) => [r.resource, r.level as Level])));
}

const PG_QUOTA_EXCEEDED = 'FS402';

/**
 * §4.5's gate, called from inside the write transaction because that is where
 * the row lock has to live. The lock closes the check-then-insert race that
 * lets two concurrent requests both slip past a limit of one.
 */
export async function assertQuota(
  trx: Tx,
  key: QuotaKey,
  quota: QuotaValue,
): Promise<void> {
  const limit = limitForDatabase(quota);
  if (limit === null) return; // Unlimited: nothing to lock, nothing to compare.

  try {
    await sql`SELECT public.assert_quota(${key}, ${limit})`.execute(trx);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === PG_QUOTA_EXCEEDED) {
      const detail = Number((error as { detail?: unknown }).detail);
      throw new QuotaExceededError(
        key,
        limit,
        Number.isFinite(detail) ? detail : limit,
        // §5's remediation paths: upgrade, or choose what to archive.
        ['upgrade', 'archive'],
      );
    }
    throw error;
  }
}

/**
 * §1.4: an undeclared key is a startup error, not a runtime false.
 *
 * Without this, a typo in a seed row — `member_billling` — resolves to the
 * global default forever and the feature is quietly off for everyone on that
 * plan. Nothing else would notice.
 */
export async function assertEntitlementRegistryComplete(): Promise<void> {
  const { rows } = await sql<{ key: string; source: string }>`
    SELECT DISTINCT key, 'plan_entitlements' AS source FROM public.plan_entitlements
    UNION
    SELECT DISTINCT key, 'tenant_entitlement_overrides' FROM public.tenant_entitlement_overrides
  `.execute(db);

  const undeclared = rows.filter((row) => !isDeclared(row.key));
  if (undeclared.length > 0) {
    const detail = undeclared.map((r) => `${r.key} (in ${r.source})`).join(', ');
    throw new Error(
      `undeclared entitlement keys in the database: ${detail}. ` +
        'Declare them in api/src/entitlements/registry.ts with a global default, ' +
        'or remove the rows — §1.4 requires resolution to be total.',
    );
  }
}
