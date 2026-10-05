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
 * Sign in all the way, which since 0039 means two steps.
 *
 * Every suite that used to post a password and get a token pair now gets a
 * challenge instead, because MFA is mandatory for everybody and a test user is
 * no exception — exempting one would be §1.3's branching on identity, wearing a
 * lab coat.
 *
 * So this does what a person does: posts the password, finds the code in the
 * outbox (as the privileged role, because `app_role` cannot read the bodies),
 * and spends it. The six digits are pulled out of the subject line, which is
 * where `mfaCodeEmail` puts them so a phone's notification shows the code
 * without opening anything.
 */
export async function signInFully(
  app: { inject: (opts: Record<string, unknown>) => Promise<{ statusCode: number; json: () => any }> },
  email: string,
  password: string,
  options: { rememberDevice?: boolean; deviceToken?: string } = {},
): Promise<{
  statusCode: number;
  body: {
    access_token?: string;
    refresh_token?: string;
    device_token?: string;
    memberships?: unknown[];
  };
}> {
  const first = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: {
      email,
      password,
      ...(options.deviceToken ? { device_token: options.deviceToken } : {}),
    },
  });

  // A trusted device, or a refusal. Either way there is no code to find.
  if (first.statusCode !== 200 || first.json().mfa_required !== true) {
    return { statusCode: first.statusCode, body: first.json() };
  }

  const code = await latestMfaCode(email);
  if (!code) throw new Error(`no MFA code was queued for ${email}`);

  const second = await app.inject({
    method: 'POST',
    url: '/auth/mfa',
    payload: {
      challenge_id: first.json().challenge_id,
      code,
      ...(options.rememberDevice ? { remember_device: true } : {}),
    },
  });
  return { statusCode: second.statusCode, body: second.json() };
}

/** The six digits from the newest code queued for an address. */
export async function latestMfaCode(email: string): Promise<string | null> {
  const pool = privilegedPool();
  try {
    const { rows } = await pool.query<{ subject: string }>(
      `SELECT subject FROM outbox
        WHERE to_email = $1 AND kind = 'mfa_code'
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
      [email],
    );
    return rows[0]?.subject.match(/(\d{6})/)?.[1] ?? null;
  } finally {
    await pool.end();
  }
}

/**
 * Read what the application is not allowed to write.
 *
 * `tenants.plan_code` and `tenants.status` carry no grant for app_role, and
 * `audit_log` is append-only, so a test that wants to check what a webhook
 * did has to look from outside — which is also the only honest way to check
 * it, since looking through the API would only prove the API agrees with
 * itself.
 */
export async function readTenantRow(
  tenantId: string,
): Promise<{ status: string; plan_code: string; billing_customer_id: string | null }> {
  const pool = privilegedPool();
  try {
    const { rows } = await pool.query<{
      status: string;
      plan_code: string;
      billing_customer_id: string | null;
    }>(`SELECT status, plan_code, billing_customer_id FROM tenants WHERE id = $1`, [tenantId]);
    return rows[0]!;
  } finally {
    await pool.end();
  }
}

export async function readAuditLog(
  tenantId: string,
): Promise<
  { action: string; resource: string; actor_user_id: string | null; before: unknown; after: unknown }[]
> {
  const pool = privilegedPool();
  try {
    const { rows } = await pool.query(
      `SELECT action, resource, actor_user_id, before, after
         FROM audit_log WHERE tenant_id = $1 ORDER BY occurred_at`,
      [tenantId],
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
 * The §1.4 chain's left-hand layer, written the way the control plane writes
 * it — out of band, because a tenant that could grant itself an override
 * would make the chain meaningless (0005 revokes the grant for exactly that).
 *
 * Used where the real limit is too large to exercise honestly: nobody is
 * going to upload a gibibyte to prove `storage.bytes` refuses at one.
 */
export async function setQuotaOverride(
  tenantId: string,
  key: string,
  value: number | 'unlimited',
): Promise<void> {
  const pool = privilegedPool();
  try {
    await pool.query(
      `INSERT INTO tenant_entitlement_overrides (tenant_id, key, value)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [tenantId, key, JSON.stringify(value)],
    );
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
    // Platform billing: both are append-only or unwritable to the app, so
    // like the ledger below they can only be cleaned out of band.
    await adminPool.query(`DELETE FROM billing_events WHERE tenant_id IN (${tenants})`, [
      `${TEST_PREFIX}%`,
    ]);
    await adminPool.query(`DELETE FROM subscriptions WHERE tenant_id IN (${tenants})`, [
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
    // Voids and notifications point at compliance records and memberships.
    for (const table of ['compliance_voids', 'notifications']) {
      await adminPool.query(`DELETE FROM ${table} WHERE tenant_id IN (${tenants})`, [
        `${TEST_PREFIX}%`,
      ]);
    }
    await adminPool.query(`DELETE FROM compliance_records WHERE tenant_id IN (${tenants})`, [
      `${TEST_PREFIX}%`,
    ]);
    // attachments point at squawks, completions and documents, and app_role
    // holds no DELETE on them by design (0020: a row naming an object somebody
    // has to go and clean up). They go before all three.
    await adminPool.query(`DELETE FROM attachments WHERE tenant_id IN (${tenants})`, [
      `${TEST_PREFIX}%`,
    ]);
    /*
      Documents point at aircraft and at each other (a renewal names what it
      replaced), so the self-reference is cleared before the rows are.
    */
    await adminPool.query(
      `UPDATE aircraft_documents SET supersedes_id = NULL WHERE tenant_id IN (${tenants})`,
      [`${TEST_PREFIX}%`],
    );
    await adminPool.query(`DELETE FROM aircraft_documents WHERE tenant_id IN (${tenants})`, [
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
    // Rules (0022), the edit log and the grounding events (0032) all point at
    // items, so they go first.
    for (const table of [
      'maintenance_item_rules',
      'maintenance_item_history',
      'maintenance_grounding_events',
    ]) {
      await adminPool.query(`DELETE FROM ${table} WHERE tenant_id IN (${tenants})`, [
        `${TEST_PREFIX}%`,
      ]);
    }
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
    // Trusted devices point at users, like auth_tokens do (0039).
    await adminPool.query(`DELETE FROM trusted_devices WHERE user_id IN (${users})`);
    await adminPool.query(`DELETE FROM auth_tokens WHERE user_id IN (${users})`);
    await adminPool.query(`DELETE FROM outbox WHERE to_email LIKE '%@vitest.test'`);
    await adminPool.query(`DELETE FROM users WHERE email LIKE '%@vitest.test'`);
    await adminPool.query(`DELETE FROM tenants WHERE slug LIKE $1`, [`${TEST_PREFIX}%`]);
  } finally {
    await adminPool.end();
  }
}
