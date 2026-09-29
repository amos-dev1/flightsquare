import { sql } from 'kysely';

import { NotFoundError } from '../errors.js';
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

  /**
   * One aerodrome, by the identifier somebody typed.
   *
   * The search below can answer this, but it answers it by returning up to a
   * hundred rows that start with the same letters — and what a form wants,
   * the moment an identifier has been entered into it, is that one row or
   * nothing. Since the import this table holds seventy thousand rows, and
   * the difference between a keyed lookup and a prefix scan stopped being
   * theoretical.
   *
   * A miss is a 404 and not an error the caller should show: 0014 dropped
   * the foreign key precisely because "a list that incomplete refuses almost
   * every true answer", so an identifier this does not know is still a
   * perfectly good place to have flown to.
   */
  app.get<{ Params: { ident: string } }>(
    '/reference/aerodromes/:ident',
    { config: { requiresSession: true } },
    async (request) => {
      const row = await app.db
        .selectFrom('aerodromes')
        .select(['ident', 'name', 'municipality', 'region', 'country'])
        .where('ident', '=', request.params.ident.trim().toUpperCase())
        .executeTakeFirst();

      if (!row) throw new NotFoundError();
      return row satisfies AerodromeResponse;
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
        /**
         * Written to match the indexes 0019 added, which at seventy thousand
         * rows is the difference between a lookup and a scan of the lot.
         *
         * `lower(ident) LIKE …` rather than `ident ILIKE …`: the planner will
         * not use an expression index on `lower(ident)` for an ILIKE, and
         * proved it — that predicate alone was a sequential scan until it was
         * written this way. The two substring searches keep ILIKE, which GIN
         * trigram indexes do serve.
         */
        const prefix = `${q.toLowerCase().replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
        query = query.where((eb) =>
          eb.or([
            eb(eb.fn('lower', ['ident']), 'like', prefix),
            eb('name', 'ilike', `%${q}%`),
            eb('municipality', 'ilike', `%${q}%`),
          ]),
        );
      }

      /**
       * What was typed, first.
       *
       * Alphabetical order was fine at twenty rows and is wrong at seventy
       * thousand: searching "KPA" matched Kirkpatrick Airport and Akpaka and
       * Brakpan on their names, and "8IL2" sorts above "KPAO", so the field
       * somebody actually typed came fourth. Exact identifier, then
       * identifier prefix, then everything else alphabetically.
       */
      const rows = await (q
        ? query
            .orderBy(sql`lower(ident) = ${q.toLowerCase()}`, 'desc')
            .orderBy(sql`lower(ident) LIKE ${`${q.toLowerCase()}%`}`, 'desc')
        : query
      )
        .orderBy('ident')
        .limit(100)
        .execute();
      return rows satisfies AerodromeResponse[];
    },
  );
}
