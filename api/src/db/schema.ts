import type { ColumnType, Generated } from 'kysely';

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;

export type TenantStatus = 'trial' | 'active' | 'past_due' | 'suspended' | 'closed';
export type TenantArchetype = 'solo' | 'partnership' | 'club';
export type UserStatus = 'active' | 'locked' | 'closed';
export type MembershipStatus = 'invited' | 'active' | 'suspended' | 'removed';

export interface TenantsTable {
  id: Generated<string>;
  slug: string;
  name: string;
  host: string | null;
  status: Generated<TenantStatus>;
  /**
   * §3.1: descriptive only. Never read at runtime to decide behaviour —
   * that is §1.3 in a better disguise.
   */
  archetype: Generated<TenantArchetype>;
  plan_code: Generated<string>;
  billing_customer_id: string | null;
  branding: Generated<Record<string, unknown>>;
  legal_hold: Generated<boolean>;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
  /** Control-plane marker, not an application verb. app_role cannot write it. */
  deleted_at: ColumnType<Date | null, never, never>;
}

export interface UsersTable {
  id: Generated<string>;
  email: string;
  password_hash: string | null;
  mfa_enabled: Generated<boolean>;
  mfa_secret: string | null;
  status: Generated<UserStatus>;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
  deleted_at: ColumnType<Date | null, never, never>;
}

export interface MembershipsTable {
  id: Generated<string>;
  tenant_id: string;
  user_id: string;
  /** NOT NULL: a membership without a bundle would hold no permissions. */
  role_bundle_id: string;
  status: Generated<MembershipStatus>;
  invited_at: Timestamp | null;
  joined_at: Timestamp | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
  deleted_at: ColumnType<Date | null, never, never>;
}

export interface InvitesTable {
  id: Generated<string>;
  tenant_id: string;
  email: string;
  token_hash: string;
  invited_by: string | null;
  expires_at: Timestamp;
  accepted_at: Timestamp | null;
  accepted_by: string | null;
  revoked_at: Timestamp | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
  deleted_at: ColumnType<Date | null, never, never>;
}

export type SessionType = 'user' | 'impersonation';

export interface SessionsTable {
  id: Generated<string>;
  user_id: string;
  /** §10: only 'user' is written today; the discriminator ships anyway. */
  session_type: Generated<SessionType>;
  acting_admin_user_id: string | null;
  /** Not `tenant_id`: a session belongs to a user and *selects* a tenant. */
  selected_tenant_id: string | null;
  access_token_hash: string;
  access_expires_at: Timestamp;
  expires_at: Timestamp;
  revoked_at: Timestamp | null;
  last_used_at: Timestamp | null;
  client: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface RefreshTokensTable {
  id: Generated<string>;
  session_id: string;
  token_hash: string;
  expires_at: Timestamp;
  /** Set when exchanged. A second presentation after this is theft. */
  used_at: Timestamp | null;
  revoked_at: Timestamp | null;
  created_at: Generated<Timestamp>;
}

export interface DeviceRegistrationsTable {
  id: Generated<string>;
  user_id: string;
  platform: 'ios' | 'android' | 'web';
  push_token: string;
  last_seen_at: Timestamp | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface AuditLogTable {
  id: Generated<string>;
  tenant_id: string;
  actor_user_id: string | null;
  acting_admin_user_id: string | null;
  resource: string;
  resource_id: string | null;
  action: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  occurred_at: Generated<Timestamp>;
}

export interface PlansTable {
  code: string;
  name: string;
  description: string | null;
  sort_order: Generated<number>;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface PlanEntitlementsTable {
  plan_code: string;
  key: string;
  /** jsonb: boolean for a flag, number or "unlimited" for a quota, string for config. */
  value: unknown;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface TenantEntitlementOverridesTable {
  tenant_id: string;
  key: string;
  value: unknown;
  reason: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface TenantUsageTable {
  tenant_id: string;
  quota_key: string;
  /** Maintained by triggers. app_role holds no write grant here on purpose. */
  current_value: ColumnType<string, never, never>;
  updated_at: ColumnType<Date, never, never>;
}

export interface RoleBundlesTable {
  id: Generated<string>;
  tenant_id: string;
  code: string;
  name: string;
  is_default: Generated<boolean>;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
  deleted_at: ColumnType<Date | null, never, never>;
}

export interface RoleBundlePermissionsTable {
  tenant_id: string;
  role_bundle_id: string;
  resource: string;
  level: string;
  created_at: Generated<Timestamp>;
}

export interface Database {
  plans: PlansTable;
  plan_entitlements: PlanEntitlementsTable;
  tenant_entitlement_overrides: TenantEntitlementOverridesTable;
  tenant_usage: TenantUsageTable;
  role_bundles: RoleBundlesTable;
  role_bundle_permissions: RoleBundlePermissionsTable;
  tenants: TenantsTable;
  users: UsersTable;
  memberships: MembershipsTable;
  invites: InvitesTable;
  sessions: SessionsTable;
  refresh_tokens: RefreshTokensTable;
  device_registrations: DeviceRegistrationsTable;
  audit_log: AuditLogTable;
}
