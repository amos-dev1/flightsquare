import type { ColumnType, Generated } from 'kysely';

/**
 * A timestamptz column. The insert side accepts `undefined`, so this already
 * means "may be defaulted by the database" — do not wrap it in `Generated<>`,
 * which nests one ColumnType inside another and leaves the select side
 * resolving to the wrapper instead of to Date.
 */
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
  created_at: Timestamp;
  updated_at: Timestamp;
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
  created_at: Timestamp;
  updated_at: Timestamp;
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
  created_at: Timestamp;
  updated_at: Timestamp;
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
  created_at: Timestamp;
  updated_at: Timestamp;
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
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface RefreshTokensTable {
  id: Generated<string>;
  session_id: string;
  token_hash: string;
  expires_at: Timestamp;
  /** Set when exchanged. A second presentation after this is theft. */
  used_at: Timestamp | null;
  revoked_at: Timestamp | null;
  created_at: Timestamp;
}

export interface DeviceRegistrationsTable {
  id: Generated<string>;
  user_id: string;
  platform: 'ios' | 'android' | 'web';
  push_token: string;
  last_seen_at: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
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
  occurred_at: Timestamp;
}

export interface PlansTable {
  code: string;
  name: string;
  description: string | null;
  sort_order: Generated<number>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface PlanEntitlementsTable {
  plan_code: string;
  key: string;
  /** jsonb: boolean for a flag, number or "unlimited" for a quota, string for config. */
  value: unknown;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface TenantEntitlementOverridesTable {
  tenant_id: string;
  key: string;
  value: unknown;
  reason: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
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
  created_at: Timestamp;
  updated_at: Timestamp;
  deleted_at: ColumnType<Date | null, never, never>;
}

export interface RoleBundlePermissionsTable {
  tenant_id: string;
  role_bundle_id: string;
  resource: string;
  level: string;
  created_at: Timestamp;
}

export type AircraftStatus = 'active' | 'archived' | 'sold';
export type Ownership = 'owned' | 'leased' | 'leaseback' | 'club_owned';
export type MaintenanceMeter = 'hobbs' | 'tach' | 'airframe';

export interface AircraftTypesTable {
  code: string;
  manufacturer: string;
  model: string;
  category: string;
  engine_type: string;
  engine_count: Generated<number>;
  typical_seats: number | null;
  created_at: Timestamp;
}

export interface AerodromesTable {
  ident: string;
  icao_code: string | null;
  iata_code: string | null;
  name: string;
  municipality: string | null;
  region: string | null;
  country: string;
  latitude: string | null;
  longitude: string | null;
  elevation_ft: number | null;
  created_at: Timestamp;
}

export interface AircraftTable {
  id: Generated<string>;
  tenant_id: string;
  registration: string;
  type_code: string | null;
  serial_number: string | null;
  year_manufactured: number | null;
  home_base: string | null;
  /** §5.5: archiving is a status, and an archived aircraft keeps its history. */
  status: Generated<AircraftStatus>;
  ownership: Generated<Ownership>;

  // Derived from meter_readings by a trigger. `never` on the write side is
  // not decoration: app_role holds no UPDATE grant on these columns, so a
  // query that tried would fail at the database anyway (§3.4).
  airframe_hours: ColumnType<string | null, never, never>;
  hobbs: ColumnType<string | null, never, never>;
  tach: ColumnType<string | null, never, never>;
  engine_hours_since_overhaul: ColumnType<string | null, never, never>;
  cycles: ColumnType<number | null, never, never>;
  totals_updated_at: ColumnType<Date | null, never, never>;

  created_at: Timestamp;
  updated_at: Timestamp;
  deleted_at: ColumnType<Date | null, never, never>;
}

export interface AircraftConfigTable {
  aircraft_id: string;
  tenant_id: string;
  seats: number | null;
  maintenance_meter: Generated<MaintenanceMeter>;
  mel_reference: string | null;
  equipment: Generated<Record<string, unknown>>;
  performance: Generated<Record<string, unknown>>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface MeterReadingsTable {
  id: Generated<string>;
  tenant_id: string;
  aircraft_id: string;
  /** numeric arrives as a string; parsing it to a float would lose precision. */
  hobbs: string | null;
  tach: string | null;
  airframe_hours: string | null;
  cycles: number | null;
  /** When the reading was taken. The server orders by this, not by arrival. */
  recorded_at: Timestamp;
  received_at: Timestamp;
  source: Generated<'manual' | 'flight' | 'maintenance' | 'import'>;
  recorded_by: string | null;
  /** A correction points at the row it replaces; neither is ever deleted. */
  supersedes_id: string | null;
  note: string | null;
  created_at: Timestamp;
}

export interface Database {
  aircraft: AircraftTable;
  aircraft_config: AircraftConfigTable;
  aircraft_types: AircraftTypesTable;
  aerodromes: AerodromesTable;
  meter_readings: MeterReadingsTable;
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
