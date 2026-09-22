import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';

import { config } from '../config.js';

/**
 * The one query in the product that crosses tenants without being the
 * control plane.
 *
 * §1.1 has a background job set context explicitly per tenant and loop, and
 * a loop needs a list. Producing one is cross-tenant by definition, so the
 * capability is a role of its own rather than a borrowed credential:
 * `scheduler_role` may read `tenants.id`, filtered by policy to accounts
 * that are actually running, and may read nothing else in the database.
 *
 * It is deliberately not the connection anything else uses. The moment this
 * pool could also read a maintenance item, the isolation argument would rest
 * on this file remembering not to.
 */
export function schedulerDatabase(): Kysely<{ tenants: { id: string } }> {
  return new Kysely({
    dialect: new PostgresDialect({
      pool: new pg.Pool({
        host: config.db.host,
        port: config.db.port,
        database: config.db.database,
        user: config.scheduler.user,
        password: config.scheduler.password,
        max: 1,
      }),
    }),
  });
}

export async function assertSchedulerRole(
  db: Kysely<{ tenants: { id: string } }>,
): Promise<void> {
  const { rows } = await sql<{
    current_user: string;
    rolsuper: boolean;
    rolbypassrls: boolean;
  }>`
    SELECT current_user, r.rolsuper, r.rolbypassrls
      FROM pg_roles r WHERE r.rolname = current_user
  `.execute(db);

  const row = rows[0];
  if (!row) throw new Error('could not determine the current database role');
  if (row.rolsuper || row.rolbypassrls) {
    throw new Error(
      `the sweep connected as ${row.current_user}, which can bypass ` +
        'row-level security (§1.2).',
    );
  }
  if (row.current_user !== 'scheduler_role') {
    throw new Error(
      `the sweep connected as ${row.current_user}, expected scheduler_role.`,
    );
  }
}

/** Every tenant worth sweeping, as ids and nothing else. */
export async function tenantsToSweep(
  db: Kysely<{ tenants: { id: string } }>,
): Promise<string[]> {
  const rows = await db.selectFrom('tenants').select('id').orderBy('id').execute();
  return rows.map((row) => row.id);
}
