import { randomBytes } from 'node:crypto';

import pg from 'pg';

import { config } from '../../src/config.js';
import { provisionTenantForNewUser } from '../../src/db/auth.js';
import type { ProvisionedTenant } from '../../src/db/auth.js';

const { Pool } = pg;

/**
 * Every tenant this suite creates is prefixed, so cleanup can find them and
 * a half-finished run never poisons the next one.
 */
export const TEST_PREFIX = 'vitest-';

export function uniqueSlug(label: string): string {
  return `${TEST_PREFIX}${label}-${randomBytes(4).toString('hex')}`;
}

export function uniqueEmail(label: string): string {
  return `${label}-${randomBytes(4).toString('hex')}@vitest.test`;
}

export async function provisionTestTenant(label: string): Promise<
  ProvisionedTenant & { slug: string; email: string }
> {
  const slug = uniqueSlug(label);
  const email = uniqueEmail(label);
  const provisioned = await provisionTenantForNewUser({
    slug,
    name: `Test ${label}`,
    archetype: 'club',
    email,
    passwordHash: 'scrypt$N=16384,r=8,p=1$c2FsdA==$aGFzaA==',
  });
  return { ...provisioned, slug, email };
}

/**
 * Teardown runs as the superuser, which is the only role that can remove
 * these rows at all: app_role holds no DELETE grant, and deleted_at is a
 * control-plane marker it cannot write either. That is the design working,
 * not a gap — it just means test cleanup is out-of-band, exactly like the
 * SQL suite's fixtures.
 */
export async function cleanupTestTenants(): Promise<void> {
  const adminPool = new Pool({
    host: config.db.host,
    port: config.db.port,
    database: config.db.database,
    user: 'postgres',
    password: process.env.POSTGRES_PASSWORD ?? 'postgres',
    max: 1,
  });
  try {
    await adminPool.query(
      `DELETE FROM memberships WHERE tenant_id IN
         (SELECT id FROM tenants WHERE slug LIKE $1)`,
      [`${TEST_PREFIX}%`],
    );
    await adminPool.query(
      `DELETE FROM users WHERE email LIKE '%@vitest.test'`,
    );
    await adminPool.query(`DELETE FROM tenants WHERE slug LIKE $1`, [`${TEST_PREFIX}%`]);
  } finally {
    await adminPool.end();
  }
}
