import { sql } from 'kysely';
import type { FastifyInstance } from 'fastify';

import { db } from '../../db/pool.js';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async () => {
    await sql`SELECT 1`.execute(db);
    return { status: 'ok', database: 'ok' };
  });
}
