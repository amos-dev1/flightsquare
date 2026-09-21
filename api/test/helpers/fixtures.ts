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
/**
 * Read the queue the way a sender will, which is to say not as the API.
 *
 * app_role holds no SELECT on `outbox` — the bodies carry live single-use
 * links — so a test that wants to follow one has to connect as somebody
 * else, exactly like the sender M8 will add.
 */
export async function readOutbox(
  toEmail: string,
): Promise<{ subject: string; body: string; kind: string }[]> {
  const pool = privilegedPool();
  try {
    const { rows } = await pool.query<{ subject: string; body: string; kind: string }>(
      `SELECT subject, body, kind FROM outbox WHERE to_email = $1 ORDER BY created_at`,
      [toEmail],
    );
    return rows;
  } finally {
    await pool.end();
  }
}

/**
 * Move a tenant onto another plan, the way an upgrade does.
 *
 * Out-of-band on purpose: `tenants.plan_code` is not writable by app_role
 * (070 asserts it), because a tenant that could set its own plan could set
 * its own quotas. Scheduling and member billing are both Pro-and-up, so any
 * test that exercises a second member has to start here.
 */
export async function setPlan(tenantId: string, planCode: string): Promise<void> {
  const pool = privilegedPool();
  try {
    await pool.query(`UPDATE tenants SET plan_code = $2 WHERE id = $1`, [tenantId, planCode]);
  } finally {
    await pool.end();
  }
}

/**
 * Put a second person in a club, out of band.
 *
 * Needed because §4.4 is now enforced by a trigger: a tenant keeps one
 * member who can manage members, so a suite that wants to demote its only
 * Admin has to give the club somebody else first. Which is also what a real
 * club looks like.
 */
export async function addTestMember(
  tenantId: string,
  label: string,
  roleCode: 'admin' | 'pilot' = 'admin',
): Promise<{ user_id: string; membership_id: string; email: string }> {
  const pool = privilegedPool();
  const email = uniqueEmail(label);
  try {
    const user = await pool.query<{ id: string }>(
      `INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id`,
      [email, label, 'scrypt$N=16384,r=8,p=1$c2FsdA==$aGFzaA=='],
    );
    const bundle = await pool.query<{ id: string }>(
      `SELECT id FROM role_bundles WHERE tenant_id = $1 AND code = $2`,
      [tenantId, roleCode],
    );
    const membership = await pool.query<{ id: string }>(
      `INSERT INTO memberships (tenant_id, user_id, status, joined_at, role_bundle_id)
       VALUES ($1, $2, 'active', now(), $3) RETURNING id`,
      [tenantId, user.rows[0]!.id, bundle.rows[0]!.id],
    );
    return { user_id: user.rows[0]!.id, membership_id: membership.rows[0]!.id, email };
  } finally {
    await pool.end();
  }
}

function privilegedPool(): pg.Pool {
  return new Pool({
    host: config.db.host,
    port: config.db.port,
    database: config.db.database,
    user: 'postgres',
    password: process.env.POSTGRES_PASSWORD ?? 'postgres',
    max: 1,
  });
}

export async function cleanupTestTenants(): Promise<void> {
  const adminPool = privilegedPool();
  try {
    // Foreign keys, in order. sessions → users and audit_log → tenants both
    // point inward, so the leaves go first; refresh_tokens follows its
    // session by ON DELETE CASCADE.
    const tenants = `SELECT id FROM tenants WHERE slug LIKE $1`;
    const users = `SELECT id FROM users WHERE email LIKE '%@vitest.test'`;

    await adminPool.query(`DELETE FROM audit_log WHERE tenant_id IN (${tenants})`, [
      `${TEST_PREFIX}%`,
    ]);
    await adminPool.query(`DELETE FROM sessions WHERE user_id IN (${users})`);
    await adminPool.query(`DELETE FROM device_registrations WHERE user_id IN (${users})`);
    await adminPool.query(`DELETE FROM invites WHERE tenant_id IN (${tenants})`, [
      `${TEST_PREFIX}%`,
    ]);
    // The ledger leads everything: charges and credits point at flights,
    // and every one of these tables is append-only to the application — so
    // teardown is out-of-band by design rather than by omission.
    for (const table of [
      'flight_charges',
      'fuel_credits',
      'ledger_adjustments',
      'member_aircraft_rates',
      'aircraft_rates',
    ]) {
      await adminPool.query(`DELETE FROM ${table} WHERE tenant_id IN (${tenants})`, [
        `${TEST_PREFIX}%`,
      ]);
    }
    // Scheduling leads: its lines point at reservations and blackouts, and
    // those point at memberships and aircraft.
    await adminPool.query(
      `DELETE FROM reservation_resources WHERE tenant_id IN (${tenants})`,
      [`${TEST_PREFIX}%`],
    );
    await adminPool.query(`DELETE FROM reservations WHERE tenant_id IN (${tenants})`, [
      `${TEST_PREFIX}%`,
    ]);
    await adminPool.query(`DELETE FROM blackouts WHERE tenant_id IN (${tenants})`, [
      `${TEST_PREFIX}%`,
    ]);
    await adminPool.query(
      `DELETE FROM member_aircraft_authorizations WHERE tenant_id IN (${tenants})`,
      [`${TEST_PREFIX}%`],
    );
    // Maintenance leads, because squawks point at flights and at work
    // orders, and compliance records point at items and orders. app_role
    // could not do any of this — compliance_records holds SELECT and INSERT
    // and nothing else — which is the design working rather than a gap.
    await adminPool.query(`DELETE FROM compliance_records WHERE tenant_id IN (${tenants})`, [
      `${TEST_PREFIX}%`,
    ]);
    await adminPool.query(`DELETE FROM squawk_deferrals WHERE tenant_id IN (${tenants})`, [
      `${TEST_PREFIX}%`,
    ]);
    await adminPool.query(`DELETE FROM squawks WHERE tenant_id IN (${tenants})`, [
      `${TEST_PREFIX}%`,
    ]);
    await adminPool.query(`DELETE FROM work_orders WHERE tenant_id IN (${tenants})`, [
      `${TEST_PREFIX}%`,
    ]);
    await adminPool.query(`DELETE FROM maintenance_items WHERE tenant_id IN (${tenants})`, [
      `${TEST_PREFIX}%`,
    ]);
    // flights own flight_meters and flight_fuel by cascade, but meter_readings
    // point back at flights, so those go first.
    await adminPool.query(`DELETE FROM meter_readings WHERE tenant_id IN (${tenants})`, [
      `${TEST_PREFIX}%`,
    ]);
    await adminPool.query(`DELETE FROM flights WHERE tenant_id IN (${tenants})`, [
      `${TEST_PREFIX}%`,
    ]);
    await adminPool.query(`DELETE FROM idempotency_keys WHERE tenant_id IN (${tenants})`, [
      `${TEST_PREFIX}%`,
    ]);
    await adminPool.query(`DELETE FROM meter_readings WHERE tenant_id IN (${tenants})`, [
      `${TEST_PREFIX}%`,
    ]);
    await adminPool.query(`DELETE FROM aircraft_config WHERE tenant_id IN (${tenants})`, [
      `${TEST_PREFIX}%`,
    ]);
    await adminPool.query(`DELETE FROM aircraft WHERE tenant_id IN (${tenants})`, [
      `${TEST_PREFIX}%`,
    ]);
    await adminPool.query(`DELETE FROM memberships WHERE tenant_id IN (${tenants})`, [
      `${TEST_PREFIX}%`,
    ]);
    // role_bundles is referenced by memberships and by its own permission
    // rows, so it goes after both.
    await adminPool.query(
      `DELETE FROM role_bundle_permissions WHERE tenant_id IN (${tenants})`,
      [`${TEST_PREFIX}%`],
    );
    await adminPool.query(`DELETE FROM role_bundles WHERE tenant_id IN (${tenants})`, [
      `${TEST_PREFIX}%`,
    ]);
    await adminPool.query(`DELETE FROM tenant_usage WHERE tenant_id IN (${tenants})`, [
      `${TEST_PREFIX}%`,
    ]);
    await adminPool.query(
      `DELETE FROM tenant_entitlement_overrides WHERE tenant_id IN (${tenants})`,
      [`${TEST_PREFIX}%`],
    );
    // auth_tokens point at users; the outbox points at nothing and is keyed
    // by address, so it is cleared by the same pattern.
    await adminPool.query(`DELETE FROM auth_tokens WHERE user_id IN (${users})`);
    await adminPool.query(`DELETE FROM outbox WHERE to_email LIKE '%@vitest.test'`);
    await adminPool.query(`DELETE FROM users WHERE email LIKE '%@vitest.test'`);
    await adminPool.query(`DELETE FROM tenants WHERE slug LIKE $1`, [`${TEST_PREFIX}%`]);
  } finally {
    await adminPool.end();
  }
}
