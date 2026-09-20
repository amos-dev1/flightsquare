import type { FastifyInstance } from 'fastify';
import type { AerodromeResponse, AircraftTypeResponse } from '@flightsquare/shared';

/**
 * Global reference data (§2.2): shared, read-only, never customer data.
 *
 * Session-scoped but not tenant-scoped — an ICAO type designator is the same
 * for everyone, so there is no tenant to be in. They stay behind a session
 * only to keep the surface small, not because the contents are sensitive.
 */
export async function referenceRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { q?: string } }>(
    '/reference/aircraft-types',
    { config: { requiresSession: true } },
    async (request) => {
      const q = request.query.q?.trim();
      let query = app.db
        .selectFrom('aircraft_types')
        .select([
          'code',
          'manufacturer',
          'model',
          'category',
          'engine_type',
          'engine_count',
          'typical_seats',
        ]);

      if (q) {
        // ILIKE on reference data, not on a tenant table: §2's rule against
        // caller-supplied predicates is about the definer functions, where a
        // pattern turns a lookup into an enumeration oracle. There is nothing
        // to enumerate here.
        query = query.where((eb) =>
          eb.or([
            eb('code', 'ilike', `${q}%`),
            eb('manufacturer', 'ilike', `%${q}%`),
            eb('model', 'ilike', `%${q}%`),
          ]),
        );
      }

      const rows = await query.orderBy('manufacturer').orderBy('model').limit(100).execute();
      return rows satisfies AircraftTypeResponse[];
    },
  );

  app.get<{ Querystring: { q?: string } }>(
    '/reference/aerodromes',
    { config: { requiresSession: true } },
    async (request) => {
      const q = request.query.q?.trim();
      let query = app.db
        .selectFrom('aerodromes')
        .select(['ident', 'name', 'municipality', 'region', 'country']);

      if (q) {
        query = query.where((eb) =>
          eb.or([
            eb('ident', 'ilike', `${q}%`),
            eb('name', 'ilike', `%${q}%`),
            eb('municipality', 'ilike', `%${q}%`),
          ]),
        );
      }

      const rows = await query.orderBy('ident').limit(100).execute();
      return rows satisfies AerodromeResponse[];
    },
  );
}
