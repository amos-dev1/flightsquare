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

export interface Database {
  tenants: TenantsTable;
  users: UsersTable;
  memberships: MembershipsTable;
  invites: InvitesTable;
}
