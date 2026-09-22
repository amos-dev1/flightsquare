import { sql } from 'kysely';

import { db } from './pool.js';
import { withUser } from './context.js';
import type { MembershipStatus, TenantArchetype, TenantStatus } from './schema.js';

/**
 * The §2.1 permitted list — the only queries that run with no tenant context,
 * because each one provably cannot have it yet. Everything else in the API
 * goes through withTenant().
 *
 * There are eleven, which `db/tests/030` asserts as a closed list. Adding a
 * twelfth is an architectural decision requiring review, and the first
 * question is always whether the caller could have set tenant context and
 * simply didn't. M7 is the worked example of the answer being yes: a billing
 * webhook looks like it needs a door of its own, and does not — it resolves
 * its tenant through `tenant_for_billing_customer` below and then runs in
 * ordinary tenant context like everything else.
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

/**
 * Issue a single-use token and enqueue the email carrying it — or do neither,
 * and tell us nothing either way.
 *
 * `void` is the contract, not an oversight. Whether the address belongs to an
 * account is decided inside the function and never crosses back, so the
 * endpoint above cannot branch on it and is therefore not an oracle for
 * "does this person have a FlightSquare account". The caller's reply is the
 * same sentence in both cases.
 */
export async function requestEmailToken(input: {
  email: string;
  kind: 'email_verification' | 'password_reset';
  tokenHash: string;
  expiresAt: Date;
  subject: string;
  body: string;
}): Promise<void> {
  await sql`
    SELECT auth.request_email_token(
      ${input.email}, ${input.kind}, ${input.tokenHash},
      ${input.expiresAt}, ${input.subject}, ${input.body})
  `.execute(db);
}

/**
 * Spend one, once. Returns the user it belonged to, or null for a token that
 * is unknown, already spent, expired, or of the wrong kind.
 */
export async function consumeAuthToken(
  kind: 'email_verification' | 'password_reset',
  tokenHash: string,
): Promise<string | null> {
  const { rows } = await sql<{ user_id: string | null }>`
    SELECT auth.consume_auth_token(${kind}, ${tokenHash}) AS user_id
  `.execute(db);
  return rows[0]?.user_id ?? null;
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

// ---------------------------------------------------------------------------
// Entries 8 and 9 — session resolution and refresh rotation.
//
// Both run before any context exists, which is exactly why they are on the
// list: an expired access token cannot tell you whose session to set.
// ---------------------------------------------------------------------------

export interface ResolvedSessionRow {
  session_id: string;
  user_id: string;
  user_status: string;
  session_type: 'user' | 'impersonation';
  acting_admin_user_id: string | null;
  selected_tenant_id: string | null;
  /** NULL when no tenant is selected, or when the tenant is gone. */
  tenant_status: TenantStatus | null;
  /** NULL when no tenant is selected, or when the membership is gone. */
  membership_status: MembershipStatus | null;
}

export async function resolveSessionToken(
  tokenHash: string,
): Promise<ResolvedSessionRow | null> {
  const { rows } = await sql<ResolvedSessionRow>`
    SELECT session_id, user_id, user_status, session_type, acting_admin_user_id,
           selected_tenant_id, tenant_status, membership_status
      FROM auth.resolve_session_token(${tokenHash})
  `.execute(db);
  return rows[0] ?? null;
}

export interface ConsumedRefreshToken {
  session_id: string;
  user_id: string;
  selected_tenant_id: string | null;
  /** The presented token had already been exchanged. Its session is now dead. */
  reuse_detected: boolean;
}

export async function consumeRefreshToken(
  tokenHash: string,
): Promise<ConsumedRefreshToken | null> {
  const { rows } = await sql<ConsumedRefreshToken>`
    SELECT session_id, user_id, selected_tenant_id, reuse_detected
      FROM auth.consume_refresh_token(${tokenHash})
  `.execute(db);
  return rows[0] ?? null;
}
