import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { assertApplicationRole, closeDatabase, db } from '../src/db/pool.js';
import { withSession, withTenant, withUser } from '../src/db/context.js';
import { cleanupTestTenants, provisionTestTenant } from './helpers/fixtures.js';

/**
 * §6.1 items 5 and 6, exercised through the layer the application actually
 * uses. The SQL suite proves the policies; this proves that withTenant()
 * reaches them — a helper that quietly forgot to set context would pass
 * every test in db/tests and leak everything in production.
 */
describe('session context', () => {
  let alpha: Awaited<ReturnType<typeof provisionTestTenant>>;
  let bravo: Awaited<ReturnType<typeof provisionTestTenant>>;

  beforeAll(async () => {
    await cleanupTestTenants();
    alpha = await provisionTestTenant('alpha');
    bravo = await provisionTestTenant('bravo');
  });

  afterAll(async () => {
    await cleanupTestTenants();
    await closeDatabase();
  });

  it('refuses to run as a role that can bypass RLS', async () => {
    await expect(assertApplicationRole()).resolves.toBeUndefined();
  });

  it('sees only its own tenant', async () => {
    const rows = await withTenant(
      { tenantId: alpha.tenant_id, userId: alpha.user_id },
      (trx) => trx.selectFrom('tenants').select(['id', 'slug']).execute(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(alpha.tenant_id);
  });

  it('cannot reach another tenant, even by id', async () => {
    const rows = await withTenant(
      { tenantId: alpha.tenant_id, userId: alpha.user_id },
      (trx) =>
        trx
          .selectFrom('memberships')
          .select('id')
          .where('tenant_id', '=', bravo.tenant_id)
          .execute(),
    );
    expect(rows).toEqual([]);
  });

  it('returns nothing at all when context is missing', async () => {
    const rows = await withSession({}, (trx) =>
      trx.selectFrom('memberships').select('id').execute(),
    );
    expect(rows).toEqual([]);
  });

  it('refuses a write carrying another tenant id', async () => {
    // A real bundle from our own tenant: the row is otherwise valid, so what
    // rejects it is the policy rather than a column constraint.
    const bundle = await withTenant(
      { tenantId: alpha.tenant_id, userId: alpha.user_id },
      (trx) =>
        trx
          .selectFrom('role_bundles')
          .select('id')
          .where('code', '=', 'admin')
          .executeTakeFirstOrThrow(),
    );

    await expect(
      withTenant({ tenantId: alpha.tenant_id, userId: alpha.user_id }, (trx) =>
        trx
          .insertInto('memberships')
          .values({
            tenant_id: bravo.tenant_id,
            user_id: alpha.user_id,
            status: 'active',
            role_bundle_id: bundle.id,
          })
          .execute(),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('drops context when the transaction ends', async () => {
    await withTenant({ tenantId: alpha.tenant_id, userId: alpha.user_id }, async (trx) => {
      const rows = await trx.selectFrom('tenants').select('id').execute();
      expect(rows).toHaveLength(1);
    });

    // A fresh checkout from the same pool must start blind. If SET LOCAL were
    // a plain SET, this is where the leak would show.
    const { rows } = await sql<{ tenant: string | null }>`
      SELECT current_setting('app.tenant_id', true) AS tenant
    `.execute(db);

    // Note the value: '' rather than NULL. Once any transaction on a
    // connection has set a custom GUC, unsetting it leaves an empty string
    // behind, not an absent setting — for the whole life of that connection.
    // This is exactly why the policy accessors wrap current_setting in
    // NULLIF: ''::uuid raises, so without it every pooled connection would
    // start throwing on its *second* request. That failure cannot be
    // reproduced with a fresh connection, which is to say it only happens in
    // production.
    expect(rows[0]?.tenant ?? '').toBe('');

    // What actually matters: no context means no rows, not an error.
    const leaked = await withSession({}, (trx) =>
      trx.selectFrom('tenants').select('id').execute(),
    );
    expect(leaked).toEqual([]);
  });

  it('lets an authenticated user read their own row before picking a tenant', async () => {
    const rows = await withUser(alpha.user_id, (trx) =>
      trx.selectFrom('users').select(['id', 'email']).execute(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(alpha.user_id);
  });
});
