import type { FastifyInstance } from 'fastify';

/**
 * Liveness, and deliberately nothing more.
 *
 * **It does not touch the database.** It used to run `SELECT 1`, which turns a
 * database blip into a dead service: App Runner's health check (10s interval,
 * 5 unhealthy strikes) would fail, the instance would be replaced, the
 * replacement would fail the same check against the same database, and the
 * deployment would roll back — all while the fault was in RDS and nothing was
 * wrong with the process.
 *
 * What this answers is "is this process up and serving HTTP", which is the only
 * question a load balancer can act on. Whether the database is reachable is a
 * real question with a different audience and a different remedy, and it
 * belongs in an alarm on RDS rather than in the signal that decides whether to
 * kill this container.
 *
 * Unauthenticated: the health checker has no credentials and cannot be given
 * any. It returns no information about the deployment beyond the fact that it
 * is answering.
 */
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async () => ({ status: 'ok' }));
}
