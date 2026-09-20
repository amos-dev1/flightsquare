import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';

import { config } from '../config.js';
import type { Database } from './schema.js';

const { Pool } = pg;

export const pool = new Pool({
  host: config.db.host,
  port: config.db.port,
  database: config.db.database,
  user: config.db.user,
  password: config.db.password,
  max: config.db.max,
});

export const db = new Kysely<Database>({
  dialect: new PostgresDialect({ pool }),
});

/**
 * Refuse to start as anything but the application role.
 *
 * §1.2 is absolute, and the failure it describes is silent: with BYPASSRLS
 * every query keeps returning rows, just more of them than it should, and
 * nothing in a test suite notices. Pointing the API at the owner's or a
 * superuser's credentials by accident — a copied DATABASE_URL, a staging
 * shortcut — is the realistic way that happens. Cheaper to crash at boot.
 */
export async function assertApplicationRole(): Promise<void> {
  const { rows } = await sql<{
    current_user: string;
    rolsuper: boolean;
    rolbypassrls: boolean;
  }>`
    SELECT current_user, r.rolsuper, r.rolbypassrls
      FROM pg_roles r
     WHERE r.rolname = current_user
  `.execute(db);

  const row = rows[0];
  if (!row) throw new Error('could not determine the current database role');

  if (row.rolsuper || row.rolbypassrls) {
    throw new Error(
      `the API connected as ${row.current_user}, which can bypass row-level ` +
        'security. Tenant isolation would not be enforced (§1.2).',
    );
  }
  if (row.current_user !== 'app_role') {
    throw new Error(
      `the API connected as ${row.current_user}, expected app_role (§9).`,
    );
  }
}

export async function closeDatabase(): Promise<void> {
  await db.destroy();
}
