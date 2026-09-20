import { sql } from 'kysely';

import { db } from './pool.js';
import { withUser } from './context.js';
import type { MembershipStatus, TenantArchetype, TenantStatus } from './schema.js';

/**
 * The §2.1 permitted list — the only queries that run with no tenant context,
 * because each one provably cannot have it yet. Everything else in the API
 * goes through withTenant().
 *
 * Adding an eighth is an architectural decision requiring review. The first
 * question is always whether the caller could have set tenant context and
 * simply didn't.
 */

export interface TenantRouting {
  tenant_id: string;
  status: TenantStatus;
  plan_code: string;
}

/** Request routing, before session. */
export async function resolveTenantByHost(host: string): Promise<TenantRouting | null> {
  const { rows } = await sql<TenantRouting>`
    SELECT tenant_id, status, plan_code FROM auth.resolve_tenant_by_host(${host})
  `.execute(db);
  return rows[0] ?? null;
}

export interface TenantBranding {
  tenant_id: string;
  status: TenantStatus;
  name: string;
  branding: Record<string, unknown>;
}

/** Login page, invite acceptance. */
export async function resolveTenantBySlug(slug: string): Promise<TenantBranding | null> {
  const { rows } = await sql<TenantBranding>`
    SELECT tenant_id, status, name, branding FROM auth.resolve_tenant_by_slug(${slug})
  `.execute(db);
  return rows[0] ?? null;
}

export interface Credential {
  user_id: string;
  password_hash: string | null;
  mfa_enabled: boolean;
  status: string;
}

/**
 * Credential check.
 *
 * The caller must take the same time whether or not a row comes back, and
 * must answer the client identically either way. This function is an
 * account-existence oracle if the code above it lets it be.
 */
export async function findUserByEmail(email: string): Promise<Credential | null> {
  const { rows } = await sql<Credential>`
    SELECT user_id, password_hash, mfa_enabled, status
      FROM auth.find_user_by_email(${email})
  `.execute(db);
  return rows[0] ?? null;
}

export interface MembershipSummary {
  tenant_id: string;
  tenant_name: string;
  tenant_status: TenantStatus;
  membership_status: MembershipStatus;
}

/** Post-auth tenant picker. Spans tenants, for one user, by design (§3.1). */
export async function listMembershipsForUser(userId: string): Promise<MembershipSummary[]> {
  const { rows } = await sql<MembershipSummary>`
    SELECT tenant_id, tenant_name, tenant_status, membership_status
      FROM auth.list_memberships_for_user(${userId})
  `.execute(db);
  return [...rows];
}

export interface ResolvedInvite {
  invite_id: string;
  tenant_id: string;
  email: string;
  expires_at: Date;
  tenant_name: string;
  tenant_slug: string;
}

/**
 * Invite acceptance, pre-membership. Single use: an accepted, revoked or
 * expired invite resolves to nothing. Consuming it — marking accepted_at and
 * creating the membership — happens afterwards under withTenant() on the
 * tenant_id this returned.
 */
export async function resolveInviteToken(tokenHash: string): Promise<ResolvedInvite | null> {
  const { rows } = await sql<ResolvedInvite>`
    SELECT invite_id, tenant_id, email, expires_at, tenant_name, tenant_slug
      FROM auth.resolve_invite_token(${tokenHash})
  `.execute(db);
  return rows[0] ?? null;
}

/** Billing-provider webhooks. Platform billing (§3.7), never member billing. */
export async function tenantForBillingCustomer(customerId: string): Promise<string | null> {
  const { rows } = await sql<{ tenant_id: string }>`
    SELECT tenant_id FROM auth.tenant_for_billing_customer(${customerId})
  `.execute(db);
  return rows[0]?.tenant_id ?? null;
}

export interface ProvisionedTenant {
  tenant_id: string;
  user_id: string;
  membership_id: string;
}

export interface NewTenantInput {
  slug: string;
  name: string;
  archetype: TenantArchetype;
  email: string;
  passwordHash: string;
}

/**
 * Signup — the seventh function, and the only write on the list. The tenant
 * does not exist yet, so there is no context to have set.
 *
 * A duplicate slug and a duplicate email both surface as a unique violation,
 * and the route answers both with one generic message. Anything else turns
 * signup into an account-existence oracle.
 */
export async function provisionTenantForNewUser(
  input: NewTenantInput,
): Promise<ProvisionedTenant> {
  const { rows } = await sql<ProvisionedTenant>`
    SELECT tenant_id, user_id, membership_id
      FROM auth.provision_tenant(
        ${input.slug}, ${input.name}, ${input.archetype},
        ${input.email}, ${input.passwordHash}, ${null})
  `.execute(db);
  const row = rows[0];
  if (!row) throw new Error('provision_tenant returned no row');
  return row;
}

/**
 * An already-authenticated person starting a second tenant — one human, one
 * login, many memberships (§3.1).
 *
 * This runs inside a session transaction because the function refuses any
 * user id that does not match app.current_user_id(). That check lives in the
 * database precisely so it holds whether or not this layer remembers to pass
 * the right id.
 */
export async function provisionTenantForExistingUser(
  userId: string,
  input: Pick<NewTenantInput, 'slug' | 'name' | 'archetype'>,
): Promise<ProvisionedTenant> {
  return withUser(userId, async (trx) => {
    const { rows } = await sql<ProvisionedTenant>`
      SELECT tenant_id, user_id, membership_id
        FROM auth.provision_tenant(
          ${input.slug}, ${input.name}, ${input.archetype},
          ${null}, ${null}, ${userId})
    `.execute(trx);
    const row = rows[0];
    if (!row) throw new Error('provision_tenant returned no row');
    return row;
  });
}
