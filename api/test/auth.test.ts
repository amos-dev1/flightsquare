import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { sql } from 'kysely';

import {
  findUserByEmail,
  listMembershipsForUser,
  provisionTenantForExistingUser,
  resolveTenantBySlug,
  tenantForBillingCustomer,
} from '../src/db/auth.js';
import { closeDatabase } from '../src/db/pool.js';
import { withUser } from '../src/db/context.js';
import { cleanupTestTenants, provisionTestTenant, uniqueSlug } from './helpers/fixtures.js';

/** The §2.1 permitted list, called the way the application calls it. */
describe('pre-session lookups', () => {
  let tenant: Awaited<ReturnType<typeof provisionTestTenant>>;

  beforeAll(async () => {
    await cleanupTestTenants();
    tenant = await provisionTestTenant('lookups');
  });

  afterAll(async () => {
    await cleanupTestTenants();
    await closeDatabase();
  });

  it('resolves a tenant by slug with no context set', async () => {
    const resolved = await resolveTenantBySlug(tenant.slug);
    expect(resolved?.tenant_id).toBe(tenant.tenant_id);
    expect(resolved?.status).toBe('trial');
  });

  it('finds a user by email, case-insensitively', async () => {
    const found = await findUserByEmail(tenant.email.toUpperCase());
    expect(found?.user_id).toBe(tenant.user_id);
    expect(found?.password_hash).toBeTruthy();
  });

  it('returns nothing for an unknown email rather than throwing', async () => {
    expect(await findUserByEmail('nobody@vitest.test')).toBeNull();
  });

  it('lists the tenants a user belongs to', async () => {
    const memberships = await listMembershipsForUser(tenant.user_id);
    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.tenant_id).toBe(tenant.tenant_id);
  });

  it('returns null for an unknown billing customer', async () => {
    expect(await tenantForBillingCustomer('cus_does_not_exist')).toBeNull();
  });

  it('lets an authenticated user start a second tenant', async () => {
    const second = await provisionTenantForExistingUser(tenant.user_id, {
      slug: uniqueSlug('second'),
      name: 'Second Tenant',
      archetype: 'partnership',
    });
    expect(second.user_id).toBe(tenant.user_id);

    const memberships = await listMembershipsForUser(tenant.user_id);
    expect(memberships).toHaveLength(2);
  });

  it('refuses to enrol somebody else into a tenant it creates', async () => {
    const other = await provisionTestTenant('other');

    // provisionTenantForExistingUser() cannot express this mistake — it sets
    // the session from the same id it passes — so go under it and call the
    // function directly with a mismatched pair. The refusal lives in the
    // database exactly so that a future caller that does get it wrong, or
    // takes the id from a request body, is still refused.
    await expect(
      withUser(tenant.user_id, (trx) =>
        sql`
          SELECT tenant_id, user_id, membership_id
            FROM auth.provision_tenant(
              ${uniqueSlug('hijack')}, 'Hijacked', 'solo',
              ${null}, ${null}, ${other.user_id})
        `.execute(trx),
      ),
    ).rejects.toThrow(/only attach the authenticated user/i);
  });
});
