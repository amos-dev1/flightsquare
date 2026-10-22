import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import type {
  AircraftFlightStatsResponse,
  AttachFileRequest,
  AttachmentResponse,
  CreateFlightRequest,
  FlightResponse,
  FlightSummaryResponse,
} from '@flightsquare/shared';

import {
  ATTACHMENT_COLUMNS,
  assertUploadable,
  recordArrival,
  signAttachmentUpload,
  toAttachment,
} from '../../attachments/upload.js';
import { withIdempotency } from '../../db/idempotency.js';
import { ownMembership } from '../../db/membership.js';
import {
  ConflictError,
  foreignKeyViolation,
  InvalidRequestError,
  NotFoundError,
  PermissionError,
} from '../errors.js';
import type { Tx } from '../../db/context.js';

const decimal = { type: 'string', pattern: '^[0-9]{1,7}(\\.[0-9])?$' } as const;

const createSchema = {
  body: {
    type: 'object',
    required: ['aircraft_id', 'flight_date'],
    additionalProperties: false,
    properties: {
      // §8.2: the client generates ids, so an offline write can reference
      // itself before the server has heard of it. RLS still scopes the
      // insert, and the idempotency key still catches the retries.
      id: { type: 'string', format: 'uuid' },
      aircraft_id: { type: 'string', format: 'uuid' },
      flight_date: { type: 'string', format: 'date' },
      flown_by: { type: 'string', format: 'uuid' },
      departed_from: { type: 'string', maxLength: 16 },
      arrived_at: { type: 'string', maxLength: 16 },
      remarks: { type: 'string', maxLength: 2000 },
      category: { type: 'string', enum: ['personal', 'business', 'maintenance'] },

      // Decimal strings, not numbers. A tach reading is `numeric`, and a
      // float round-trip is how a maintenance countdown quietly drifts.
      hobbs_start: decimal,
      hobbs_end: decimal,
      tach_start: decimal,
      tach_end: decimal,

      fuel_remaining_before: decimal,
      fuel_remaining_after: decimal,
      fuel_added_qty: decimal,
      // §3.7 rule 3: integer minor units. Never a float, not even here —
      // and a price is money as much as a total is.
      fuel_price_cents: { type: 'integer', minimum: 0 },
      fuel_added_cost_cents: { type: 'integer', minimum: 0 },
      receipt_reference: { type: 'string', maxLength: 200 },

      recorded_at: { type: 'string', format: 'date-time' },

      // §3.4: a correction is a new flight replacing an old one. The rest of
      // this body is the corrected version; nothing is ever edited.
      supersedes_id: { type: 'string', format: 'uuid' },
      correction_reason: { type: 'string', minLength: 5, maxLength: 500 },
      logged_in_error: { type: 'boolean' },
    },
  },
} as const;

/**
 * The flight that replaced this one, and whether this caller may replace it.
 *
 * Both are correlated subqueries rather than joins, for the reason the fuel
 * and location figures on `/aircraft` are: a join would multiply the row set
 * and these are each one scalar about one flight.
 *
 * `correctable` is resolved here because §8.2 keeps the client out of
 * anything that matters and the rule needs a membership id and a query over
 * the aeroplane's other flights. The database refuses regardless (§8.1) —
 * this exists so the button and the refusal cannot disagree.
 */
const supersededBy = sql<string | null>`(
  SELECT s.id FROM flights s WHERE s.supersedes_id = flights.id
)`;

/*
  Photographs of the meters that arrived and were not put aside — on this
  flight, or on the one it corrects. Retyping a misread Hobbs is not a reason
  to photograph the same panel twice, and the photograph of it is already
  filed against the flight being replaced.
*/
const meterPhotos = sql<number>`(
  SELECT count(*)::int FROM attachments a
   WHERE a.kind = 'meter_photo'
     AND a.status = 'active'
     AND a.uploaded_at IS NOT NULL
     AND (a.flight_id = flights.id OR a.flight_id = flights.supersedes_id)
)`;

const correctable = sql<boolean>`(
  app.permission_level('aircraft') = 'write'
  OR (flights.flown_by = app.current_membership_id()
      AND NOT EXISTS (
        SELECT 1 FROM flights later
         WHERE later.aircraft_id = flights.aircraft_id
           AND later.id <> flights.id
           AND later.recorded_at > flights.recorded_at
           AND NOT later.logged_in_error
           AND NOT EXISTS (SELECT 1 FROM flights s WHERE s.supersedes_id = later.id)))
)`;

/**
 * True of a flight nothing newer has replaced.
 *
 * Every read that *adds up* has to apply this, or a correction counts twice —
 * the wrong hours and the right ones, which is worse than either alone. Reads
 * that *list* keep superseded rows and label them instead: the history is the
 * point, and hiding what was corrected is how a trail stops being one.
 */
const stands = sql<boolean>`NOT EXISTS (
  SELECT 1 FROM flights s WHERE s.supersedes_id = flights.id
)`;

function selectFlights(trx: Tx) {
  return trx
    .selectFrom('flights')
    .innerJoin('aircraft', 'aircraft.id', 'flights.aircraft_id')
    .leftJoin('flight_meters', 'flight_meters.flight_id', 'flights.id')
    .leftJoin('flight_fuel', 'flight_fuel.flight_id', 'flights.id')
    .leftJoin('memberships', 'memberships.id', 'flights.flown_by')
    .leftJoin('users', 'users.id', 'memberships.user_id')
    .select([
      'flights.id',
      'flights.aircraft_id',
      'aircraft.registration as aircraft_registration',
      'flights.flown_by',
      'users.email as flown_by_email',
      'users.name as flown_by_name',
      'flights.flight_date',
      'flights.departed_from',
      'flights.arrived_at',
      'flights.remarks',
      'flights.category',
      'flights.needs_review',
      'flights.review_reason',
      'flights.recorded_at',
      'flights.supersedes_id',
      'flights.correction_reason',
      'flights.logged_in_error',
      'flight_meters.hobbs_start',
      'flight_meters.hobbs_end',
      'flight_meters.hobbs_hours',
      'flight_meters.tach_start',
      'flight_meters.tach_end',
      'flight_meters.tach_hours',
      'flight_fuel.fuel_remaining_before',
      'flight_fuel.fuel_remaining_after',
      'flight_fuel.fuel_added_qty',
      'flight_fuel.fuel_added_cost_cents',
      'flight_fuel.fuel_price_cents',
      'flight_fuel.currency',
      supersededBy.as('superseded_by'),
      correctable.as('correctable'),
      'flights.meter_photos_requested',
      meterPhotos.as('meter_photos'),
    ]);
}

type FlightRow = Awaited<ReturnType<ReturnType<typeof selectFlights>['execute']>>[number];

function toResponse(row: FlightRow): FlightResponse {
  const { meter_photos_requested: requested, ...rest } = row;
  return {
    ...rest,
    /*
      Asked for when it was logged, and still has none. A flight said to have
      been logged in error claims nothing happened, so there was nothing to
      photograph; one since replaced is answered by its correction.
    */
    meter_photo_missing:
      requested && row.meter_photos === 0 && !row.logged_in_error && row.superseded_by === null,
    // The column is a CHECK-constrained text, so the database has already
    // refused anything outside the set.
    category: row.category as FlightResponse['category'],
    recorded_at: row.recorded_at.toISOString(),
  };
}

/**
 * What the fuel cost, in total.
 *
 * A pilot reads a price off the pump and a quantity off the truck; the total
 * is arithmetic, and §8.2 keeps a client out of arithmetic that turns into
 * money. A total sent directly still wins — somebody copying a receipt knows
 * the number better than a multiplication does — and a price with nothing to
 * multiply by buys nothing, so it stays null.
 */
function fuelCostCents(body: CreateFlightRequest): number | null {
  if (body.fuel_added_cost_cents !== undefined) return body.fuel_added_cost_cents;
  if (body.fuel_price_cents === undefined || body.fuel_added_qty === undefined) return null;
  const quantity = Number(body.fuel_added_qty);
  if (!Number.isFinite(quantity)) return null;
  return Math.round(body.fuel_price_cents * quantity);
}

/** The trigger's SQLSTATEs, and the constraint a second correction trips. */
const PG_NOT_YOURS = 'FS403';
const PG_NO_SUCH_FLIGHT = 'FS404';

/**
 * Turn the database's refusals into sentences.
 *
 * §1.1 puts the correction rule in a trigger rather than in this handler —
 * "a rule that only exists in a handler is a rule the next handler will not
 * have" — so what is left here is saying what happened. Unmapped, each of
 * these is a 500 for a request that was answered correctly.
 */
async function correctionRefusals<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const code = (error as { code?: unknown }).code;

    /*
      Both halves of the rule arrive as 403 rather than one of them as 409.
      The reading is the same either way — for *this* flight the caller would
      need `aircraft: write`, which is what the body says — and the UI never
      gets here, because `correctable` on the row already told it. A
      `ConflictError` would carry the trigger's prettier sentence and a code
      §1.6 reserves for a different question.
    */
    if (code === PG_NOT_YOURS) throw new PermissionError('aircraft', 'write');

    // §6: a flight in another tenant and one that never existed get the same
    // answer, because the difference is cross-tenant existence.
    if (code === PG_NO_SUCH_FLIGHT) throw new NotFoundError();

    if ((error as { constraint?: unknown }).constraint === 'flights_superseded_once') {
      throw new ConflictError('that flight has already been corrected');
    }
    // A correction naming a flight RLS never showed the caller. Same answer.
    if (foreignKeyViolation(error) === 'flights_supersedes_fkey') throw new NotFoundError();
    // An admin logging for somebody (0044) who is not a member of this account.
    // RLS hides another tenant's memberships, so this is also the answer for
    // one of those — it never says the person exists elsewhere (§6).
    if (foreignKeyViolation(error) === 'flights_flown_by_fkey') {
      throw new InvalidRequestError('that person is not a member of this account');
    }

    throw error;
  }
}

export async function flightRoutes(app: FastifyInstance): Promise<void> {
  app.get<{
    Querystring: {
      aircraft_id?: string;
      needs_review?: string;
      mine?: string;
      standing?: string;
      limit?: number;
    };
  }>(
    '/flights',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            // At most 200 either way; this only asks for fewer.
            limit: { type: 'integer', minimum: 1, maximum: 200 },
          },
        },
      },
      config: { requiresTenant: true, permission: ['flights', 'read'] },
    },
    async (request) => {
      const rows = await request.withTenant(async (trx) => {
        let query = selectFlights(trx);
        if (request.query.aircraft_id) {
          query = query.where('flights.aircraft_id', '=', request.query.aircraft_id);
        }
        if (request.query.needs_review === 'true') {
          /*
            A corrected flight leaves the queue without anything being
            written. The flag stays true on the row — it is a true statement
            about what was logged at the time, and being replaced says more
            than being cleared — and this is the read that stops asking about
            it. The dormant `UPDATE (needs_review)` grant is still unused.
          */
          query = query.where('flights.needs_review', '=', true).where(stands);
        }
        /**
         * `mine=true` — a filter, not a permission.
         *
         * A club's flights are shared by design: `flights` carries scope
         * `all` for everyone (§4.4), because who flew what is how a club
         * reconciles its meters and its money. What a pilot usually *wants*
         * is their own, and the same distinction the calendar draws
         * (`/reservations?mine=true`) applies here for the same reason —
         * "show me mine" is a question about the screen, not about access.
         *
         * `/flights/export.csv` is own-only by construction rather than by
         * this flag, and stays that way: it is the §3.4 logbook export, and
         * transcribing somebody else's flights into your logbook is not a
         * thing to make easy.
         */
        if (request.query.mine === 'true') {
          query = query.where(
            'flights.flown_by',
            '=',
            await ownMembership(trx, request.ctx!.userId),
          );
        }
        /*
          `standing=true` — only the entries that count: not replaced by a
          correction, and not taken back as logged in error. A glance at
          "the last few flights" wants what happened, where the full list
          keeps both halves of every correction on purpose (§3.4).
        */
        if (request.query.standing === 'true') {
          query = query.where(stands).where('flights.logged_in_error', '=', false);
        }
        return query
          .orderBy('flights.flight_date', 'desc')
          .orderBy('flights.recorded_at', 'desc')
          .limit(request.query.limit ?? 200)
          .execute();
      });
      return rows.map(toResponse);
    },
  );

  /**
   * The same set of flights, added up.
   *
   * This exists because the alternative was the client doing it, and §8.2 is
   * explicit that the client never computes anything that matters — a
   * headline number on a dashboard matters. Adding up `/flights` on a phone
   * would also be silently wrong past 200 rows, which is where that endpoint
   * caps, and wrong in the direction nobody notices.
   *
   * **Both meters, never one derived from the other** (§3.4). They run at
   * different rates by design and the difference between them is real data
   * about how the aeroplane was flown, so a caller that wants "hours" has to
   * say which — and §11 requires the answer to say so too.
   *
   * Same filters as the list and the same gate, because it is the same
   * question asked differently. What it is *not* is a pilot's logbook total:
   * §3.4 draws that line at experience totals, and the filters here are the
   * aeroplane and the member, for utilisation and for reconciliation.
   */
  app.get<{ Querystring: { aircraft_id?: string; mine?: string } }>(
    '/flights/summary',
    { config: { requiresTenant: true, permission: ['flights', 'read'] } },
    async (request) => {
      return request.withTenant(async (trx) => {
        let query = trx
          .selectFrom('flights')
          .leftJoin('flight_meters', 'flight_meters.flight_id', 'flights.id')
          .select(({ fn }) => [
            fn.countAll<string>().as('flights'),
            // coalesce so an empty set is a zero rather than a null: "no
            // hours yet" and "we could not tell you" are different answers
            // and only one of them belongs on a dashboard.
            sql<string>`coalesce(sum(flight_meters.hobbs_hours), 0)`.as('hobbs_hours'),
            sql<string>`coalesce(sum(flight_meters.tach_hours), 0)`.as('tach_hours'),
            fn.min<string | null>('flights.flight_date').as('first_flight_date'),
            fn.max<string | null>('flights.flight_date').as('last_flight_date'),
          ])
          /*
            The one read where supersession is not cosmetic. This sums
            `hobbs_hours` and counts rows, so a corrected flight would add
            the right figure on top of the wrong one and the dashboard would
            show hours nobody flew — in the direction nobody checks.
          */
          .where(stands);

        if (request.query.aircraft_id) {
          query = query.where('flights.aircraft_id', '=', request.query.aircraft_id);
        }
        if (request.query.mine === 'true') {
          query = query.where(
            'flights.flown_by',
            '=',
            await ownMembership(trx, request.ctx!.userId),
          );
        }

        const row = await query.executeTakeFirstOrThrow();

        return {
          flights: Number(row.flights),
          hobbs_hours: row.hobbs_hours,
          tach_hours: row.tach_hours,
          first_flight_date: row.first_flight_date,
          last_flight_date: row.last_flight_date,
        } satisfies FlightSummaryResponse;
      });
    },
  );

  /**
   * How one aeroplane is being used: this year so far, a month on average,
   * and what it burns an hour.
   *
   * Its own endpoint rather than more fields on `/flights/summary`, because
   * these answers only make sense for one aeroplane — a fleet's fuel burn per
   * hour is an average of different engines, which is a number about nothing.
   *
   * §8.2 for the same reason the summary exists: a figure on a dashboard
   * matters, and the client never computes one.
   *
   * "This year" and "the last twelve months" are measured from the
   * aeroplane's own today, as the maintenance countdowns are — aircraft
   * timezone, then tenant, then UTC — so a flight logged late on 31 December
   * in California does not land in the wrong year.
   */
  app.get<{ Params: { id: string } }>(
    '/aircraft/:id/flight-stats',
    { config: { requiresTenant: true, permission: ['flights', 'read'] } },
    async (request) => {
      const id = request.params.id;
      /*
        The aeroplane's own today and the flights that count, shared by both
        queries below so the chart and the figures beside it cannot disagree
        about which flights there were.
      */
      const scope = sql`
          plane AS (
            SELECT a.id,
                   coalesce(c.fuel_units, 'gallons') AS fuel_units,
                   (now() AT TIME ZONE coalesce(a.timezone, t.timezone, 'UTC'))::date AS today
              FROM public.aircraft a
              LEFT JOIN public.aircraft_config c ON c.aircraft_id = a.id
              LEFT JOIN public.tenants t ON t.id = a.tenant_id
             WHERE a.id = ${id}
          ),
          standing AS (
            -- The flights that count: not superseded by a correction, and not
            -- taken back as logged in error (which carries no meters anyway).
            SELECT f.flight_date,
                   m.hobbs_hours, m.tach_hours,
                   fu.fuel_remaining_before, fu.fuel_remaining_after, fu.fuel_added_qty
              FROM public.flights f
              LEFT JOIN public.flight_meters m ON m.flight_id = f.id
              LEFT JOIN public.flight_fuel fu ON fu.flight_id = f.id
             WHERE f.aircraft_id = ${id}
               AND NOT f.logged_in_error
               AND NOT EXISTS (SELECT 1 FROM public.flights s WHERE s.supersedes_id = f.id)
          )
      `;
      const { row, months } = await request.withTenant(async (trx) => {
        const result = await sql<{
          as_of: string;
          fuel_units: string;
          ytd_flights: string;
          ytd_hobbs: string;
          ytd_tach: string;
          window_start: string | null;
          window_days: number;
          window_hobbs: string;
          window_tach: string;
          burn_hobbs: string | null;
          burn_tach: string | null;
          burn_flights: string;
        }>`
          WITH ${scope},
          bounds AS (
            -- Twelve months back, or the first flight if that is later: an
            -- aeroplane added in June has not flown zero hours in January.
            -- No flights at all is no window, not a year of nothing: greatest()
            -- skips a NULL, so it is said explicitly.
            SELECT p.today,
                   CASE WHEN f.first_flight IS NULL THEN NULL
                        ELSE greatest((p.today - interval '1 year')::date + 1, f.first_flight)
                   END AS window_start
              FROM plane p,
                   (SELECT min(flight_date) AS first_flight FROM standing) f
          ),
          windowed AS (
            SELECT s.* FROM standing s, bounds b
             WHERE s.flight_date BETWEEN b.window_start AND b.today
          ),
          burnable AS (
            -- A flight's own start-up and shut-down readings, and nothing
            -- across flights (§3.4). Fuel added on the same entry could have
            -- gone in before the flight or after it, so that entry says
            -- nothing about burn; and a shut-down reading above the start-up
            -- one is a top-off nobody logged, not negative fuel.
            SELECT * FROM windowed
             WHERE fuel_remaining_before IS NOT NULL
               AND fuel_remaining_after IS NOT NULL
               AND coalesce(fuel_added_qty, 0) = 0
               AND fuel_remaining_before >= fuel_remaining_after
          )
          SELECT p.today::text AS as_of,
                 p.fuel_units,
                 (SELECT count(*) FROM standing s
                   WHERE s.flight_date >= date_trunc('year', p.today)
                     AND s.flight_date <= p.today) AS ytd_flights,
                 (SELECT coalesce(sum(hobbs_hours), 0) FROM standing s
                   WHERE s.flight_date >= date_trunc('year', p.today)
                     AND s.flight_date <= p.today) AS ytd_hobbs,
                 (SELECT coalesce(sum(tach_hours), 0) FROM standing s
                   WHERE s.flight_date >= date_trunc('year', p.today)
                     AND s.flight_date <= p.today) AS ytd_tach,
                 b.window_start::text AS window_start,
                 coalesce(p.today - b.window_start + 1, 0) AS window_days,
                 (SELECT coalesce(sum(hobbs_hours), 0) FROM windowed) AS window_hobbs,
                 (SELECT coalesce(sum(tach_hours), 0) FROM windowed) AS window_tach,
                 (SELECT round(sum(fuel_remaining_before - fuel_remaining_after)
                               / nullif(sum(hobbs_hours), 0), 1)
                    FROM burnable WHERE hobbs_hours > 0) AS burn_hobbs,
                 (SELECT round(sum(fuel_remaining_before - fuel_remaining_after)
                               / nullif(sum(tach_hours), 0), 1)
                    FROM burnable WHERE tach_hours > 0) AS burn_tach,
                 (SELECT count(*) FROM burnable) AS burn_flights
            FROM plane p, bounds b
        `.execute(trx);

        /*
          Hours flown in each of the last twelve calendar months, this one
          included and so far. generate_series makes the empty months rows
          rather than gaps — a month nobody flew is a zero on the chart, not a
          month that is missing from it.
        */
        const monthly = await sql<{
          month: string;
          flights: string;
          hobbs_hours: string;
          tach_hours: string;
        }>`
          WITH ${scope},
          months AS (
            SELECT generate_series(
                     date_trunc('month', p.today) - interval '11 months',
                     date_trunc('month', p.today),
                     interval '1 month'
                   )::date AS month,
                   p.today
              FROM plane p
          )
          SELECT to_char(m.month, 'YYYY-MM') AS month,
                 count(s.flight_date) AS flights,
                 coalesce(sum(s.hobbs_hours), 0) AS hobbs_hours,
                 coalesce(sum(s.tach_hours), 0) AS tach_hours
            FROM months m
            LEFT JOIN standing s
              ON s.flight_date >= m.month
             AND s.flight_date < (m.month + interval '1 month')::date
             AND s.flight_date <= m.today
           GROUP BY m.month
           ORDER BY m.month
        `.execute(trx);

        return { row: result.rows[0], months: monthly.rows };
      });
      // RLS has already hidden another tenant's aeroplane; §6 makes that a
      // plain "not found" rather than anything that admits it exists.
      if (!row) throw new NotFoundError();

      const days = Number(row.window_days);
      // Four weeks, because a month's average from a fortnight of flying is
      // the fortnight doubled and presented as a fact.
      const enoughHistory = days >= 28;
      const perMonth = (hours: string) =>
        enoughHistory ? ((Number(hours) * 30.4375) / days).toFixed(1) : null;
      const burnFlights = Number(row.burn_flights);
      const enoughBurn = burnFlights >= 3;

      return {
        as_of: row.as_of,
        year_to_date: {
          flights: Number(row.ytd_flights),
          hobbs_hours: row.ytd_hobbs,
          tach_hours: row.ytd_tach,
        },
        monthly_hours: months.map((month) => ({
          month: month.month,
          flights: Number(month.flights),
          hobbs_hours: month.hobbs_hours,
          tach_hours: month.tach_hours,
        })),
        monthly_average: {
          window_start: row.window_start,
          days,
          hobbs_hours: perMonth(row.window_hobbs),
          tach_hours: perMonth(row.window_tach),
        },
        fuel_burn: {
          units: row.fuel_units === 'litres' ? 'litres' : 'gallons',
          per_hobbs_hour: enoughBurn ? row.burn_hobbs : null,
          per_tach_hour: enoughBurn ? row.burn_tach : null,
          flights: burnFlights,
        },
      } satisfies AircraftFlightStatsResponse;
    },
  );

  // ---------------------------------------------------------------------------
  // Meter photographs (0042) — the fourth attachment owner.
  //
  // The same three steps every upload uses (§3.8), behind a door of their own
  // gated on `flights` rather than on the squawk door's `squawks`: the
  // photograph belongs to the flight, and whoever may log one may illustrate
  // it. The squawk door refuses flight-owned rows, so the two cannot be mixed.
  //
  // The flight is written first and the upload names it, which is why a flight
  // can exist without its photograph — offline, or with an upload that failed —
  // and why that is shown as `meter_photo_missing` rather than refused.
  // ---------------------------------------------------------------------------

  app.post<{ Params: { id: string }; Body: AttachFileRequest }>(
    '/flights/:id/attachments',
    {
      schema: {
        body: {
          type: 'object',
          required: ['content_type', 'byte_size'],
          additionalProperties: false,
          properties: {
            // §8.2: the device names it, so the offline queue can refer to it.
            id: { type: 'string', format: 'uuid' },
            kind: { type: 'string', enum: ['meter_photo'] },
            content_type: { type: 'string', maxLength: 100 },
            byte_size: { type: 'integer', minimum: 1 },
          },
        },
      },
      config: { requiresTenant: true, permission: ['flights', 'write'] },
    },
    async (request, reply) => {
      const body = request.body;
      assertUploadable(body.content_type, body.byte_size);

      const { entitlements } = await request.loadGates();

      const created = await request.withTenant((trx) =>
        signAttachmentUpload(trx, {
          tenantId: request.ctx!.tenantId!,
          userId: request.ctx!.userId,
          quota: entitlements.quota('storage.bytes'),
          owner: { flight_id: request.params.id },
          kind: 'meter_photo',
          ...(body.id ? { id: body.id } : {}),
          contentType: body.content_type,
          byteSize: body.byte_size,
        }),
      );

      return reply.status(201).send({
        id: created.id,
        squawk_id: null,
        compliance_record_id: null,
        aircraft_document_id: null,
        flight_id: request.params.id,
        kind: 'meter_photo',
        status: 'active',
        content_type: body.content_type,
        byte_size: body.byte_size,
        uploaded: false,
        upload_url: created.uploadUrl,
      } satisfies AttachmentResponse);
    },
  );

  /**
   * The upload landed. Matched against the flight in the `WHERE`, as the
   * documents door does, so a mismatched pair is a 404 and nothing else.
   */
  app.post<{ Params: { id: string; attachmentId: string } }>(
    '/flights/:id/attachments/:attachmentId/complete',
    { config: { requiresTenant: true, permission: ['flights', 'write'] } },
    async (request) => {
      const row = await request.withTenant((trx) =>
        trx
          .selectFrom('attachments')
          .select(ATTACHMENT_COLUMNS)
          .where('id', '=', request.params.attachmentId)
          .where('flight_id', '=', request.params.id)
          .executeTakeFirst(),
      );
      if (!row) throw new NotFoundError();

      const size = await recordArrival(row.storage_key);

      await request.withTenant((trx) =>
        trx
          .updateTable('attachments')
          .set({ byte_size: size, uploaded_at: new Date() })
          .where('id', '=', request.params.attachmentId)
          .execute(),
      );

      return toAttachment({ ...row, byte_size: size, uploaded_at: new Date() });
    },
  );

  /**
   * The photographs of one flight, with the files signed for this response.
   *
   * Read on `flights: read`, which both bundles hold: who flew what is shared
   * by design (§4.4), and the panel photograph is the evidence for the
   * figures every member is billed and maintained against. A correction lists
   * the photographs of the flight it replaced as well, for the reason
   * `meterPhotos` counts them.
   */
  app.get<{ Params: { id: string } }>(
    '/flights/:id/attachments',
    { config: { requiresTenant: true, permission: ['flights', 'read'] } },
    async (request) => {
      const rows = await request.withTenant(async (trx) => {
        const flight = await trx
          .selectFrom('flights')
          .select(['id', 'supersedes_id'])
          .where('id', '=', request.params.id)
          .executeTakeFirst();
        if (!flight) throw new NotFoundError();

        return trx
          .selectFrom('attachments')
          .select(ATTACHMENT_COLUMNS)
          .where('flight_id', 'in', [
            flight.id,
            ...(flight.supersedes_id ? [flight.supersedes_id] : []),
          ])
          .where('status', '=', 'active')
          .where('uploaded_at', 'is not', null)
          .orderBy('created_at')
          .execute();
      });

      return Promise.all(rows.map(toAttachment)) satisfies Promise<AttachmentResponse[]>;
    },
  );

  /**
   * One flight, in full.
   *
   * The list projection already carries every column a detail view needs —
   * both meters start, end and hours, the fuel, the remarks, the review flag
   * — so this is the same `selectFlights` narrowed to an id rather than a
   * second, wider shape that could drift from it.
   *
   * Registered after `/flights/summary` and `/flights/export.csv` and it does
   * not shadow them: find-my-way matches a static segment ahead of a
   * parameter whatever order they were added in.
   *
   * A flight in another tenant is a 404 and not a 403 — §6 keeps errors from
   * leaking cross-tenant existence, and RLS has already made it invisible, so
   * there is nothing here to get wrong: the row simply is not returned.
   */
  app.get<{ Params: { id: string } }>(
    '/flights/:id',
    { config: { requiresTenant: true, permission: ['flights', 'read'] } },
    async (request) => {
      const row = await request.withTenant((trx) =>
        selectFlights(trx).where('flights.id', '=', request.params.id).executeTakeFirst(),
      );
      if (!row) throw new NotFoundError();
      return toResponse(row);
    },
  );

  /**
   * The post-flight entry. §3.4 calls it the most important screen in the
   * product: if it takes more than a minute at the tiedown, people skip it,
   * the meters go stale, and every number in the app quietly becomes wrong.
   *
   * Deliberately **not** quota-checked. §4.2: never cap flights, on any tier.
   * A tenant that hit a cap would stop logging and the damage would be to the
   * data rather than to the experience.
   */
  app.post<{ Body: CreateFlightRequest }>(
    '/flights',
    {
      schema: createSchema,
      config: { requiresTenant: true, permission: ['flights', 'write'] },
    },
    async (request, reply) => {
      const key = request.headers['idempotency-key'];
      if (typeof key !== 'string' || key.length < 8) {
        // §8.2 asks every write to carry one, and this is the write that most
        // needs it: it is made offline, retried, and advances the meters.
        return reply.status(400).send({
          error: 'invalid_request',
          detail: 'an Idempotency-Key header of at least 8 characters is required',
        });
      }

      const body = request.body;

      /*
        A flight that advanced no meter is not a flight this product records:
        advancing the meters is what a flight record is *for*. The database
        says so too, but a CHECK violation surfacing as a 500 tells the person
        at the tiedown nothing about what to fix.

        The one exception is a correction saying the flight never happened.
        That carries no meters by definition — and writing one would be the
        app recording a reading nobody took.
      */
      if (!body.logged_in_error && body.hobbs_end === undefined && body.tach_end === undefined) {
        return reply.status(400).send({
          error: 'invalid_request',
          detail: 'a flight needs an ending Hobbs or tach reading',
        });
      }

      // Both halves are checked in the database too (`flights_*_check`), so
      // these only exist to answer in a sentence rather than a constraint name.
      if (body.supersedes_id === undefined && (body.correction_reason || body.logged_in_error)) {
        return reply.status(400).send({
          error: 'invalid_request',
          detail: 'say which flight is being corrected',
        });
      }
      if (body.supersedes_id !== undefined && !body.correction_reason?.trim()) {
        return reply.status(400).send({
          error: 'invalid_request',
          detail: 'a correction needs a reason, and it stays on the record',
        });
      }

      const ctx = { tenantId: request.ctx!.tenantId!, userId: request.ctx!.userId };

      const outcome = await correctionRefusals(() => withIdempotency<FlightResponse>(
        ctx,
        key,
        'POST /flights',
        body,
        async (trx) => {
          const aircraft = await trx
            .selectFrom('aircraft')
            .select('id')
            .where('id', '=', body.aircraft_id)
            .executeTakeFirst();
          if (!aircraft) throw new NotFoundError();

          /*
            Who flew it does not change because somebody fixed the figures. A
            correction that names nobody keeps the pilot of the flight it
            replaces — without this an admin correcting a member's Hobbs moved
            the flight, and its charge, onto the admin. Here rather than in the
            clients because builds already shipped send no `flown_by` (§8.1).
            A superseded flight RLS cannot see reads as none, and the
            correction trigger answers that as "no such flight".
          */
          const flownBy =
            body.flown_by ??
            (body.supersedes_id
              ? (
                  await trx
                    .selectFrom('flights')
                    .select('flown_by')
                    .where('id', '=', body.supersedes_id)
                    .executeTakeFirst()
                )?.flown_by
              : undefined) ??
            (await ownMembership(trx, ctx.userId));

          const flight = await trx
            .insertInto('flights')
            .values({
              ...(body.id ? { id: body.id } : {}),
              tenant_id: ctx.tenantId,
              aircraft_id: body.aircraft_id,
              flown_by: flownBy,
              flight_date: body.flight_date,
              departed_from: body.departed_from ?? null,
              arrived_at: body.arrived_at ?? null,
              remarks: body.remarks ?? null,
              category: body.category ?? null,
              // §8.2: the client says when the flight ended; the server
              // records when it heard about it. They differ, sometimes by days.
              recorded_at: body.recorded_at ? new Date(body.recorded_at) : new Date(),
              created_by: ctx.userId,
              // §3.4: a correction is this row replacing another, and a
              // trigger decides whether this caller may make it.
              ...(body.supersedes_id ? { supersedes_id: body.supersedes_id } : {}),
              ...(body.correction_reason ? { correction_reason: body.correction_reason } : {}),
              ...(body.logged_in_error ? { logged_in_error: true } : {}),
            })
            .returning('id')
            .executeTakeFirstOrThrow();

          // Inserting these is what advances the meters — a trigger turns
          // them into a meter_reading, so the core loop cannot be skipped by
          // a caller that forgets.
          //
          // Skipped for a flight said not to have happened: no row here means
          // no reading, no charge and no hours, which is the whole content of
          // the claim. The aeroplane's totals fall back on their own, because
          // the superseded flight's reading has stopped counting.
          if (!body.logged_in_error) {
            await trx
              .insertInto('flight_meters')
              .values({
                flight_id: flight.id,
                tenant_id: ctx.tenantId,
                hobbs_start: body.hobbs_start ?? null,
                hobbs_end: body.hobbs_end ?? null,
                tach_start: body.tach_start ?? null,
                tach_end: body.tach_end ?? null,
              })
              .execute();
          }

          const cost = fuelCostCents(body);
          const hasFuel =
            !body.logged_in_error &&
            body.fuel_remaining_before !== undefined ||
            body.fuel_remaining_after !== undefined ||
            body.fuel_added_qty !== undefined ||
            body.fuel_price_cents !== undefined ||
            cost !== null;

          if (hasFuel) {
            await trx
              .insertInto('flight_fuel')
              .values({
                flight_id: flight.id,
                tenant_id: ctx.tenantId,
                fuel_remaining_before: body.fuel_remaining_before ?? null,
                fuel_remaining_after: body.fuel_remaining_after ?? null,
                fuel_added_qty: body.fuel_added_qty ?? null,
                fuel_price_cents: body.fuel_price_cents ?? null,
                fuel_added_cost_cents: cost,
                receipt_reference: body.receipt_reference ?? null,
              })
              .execute();
          }

          const rows = await selectFlights(trx).where('flights.id', '=', flight.id).execute();
          return { status: 201, body: toResponse(rows[0]!) };
        },
      ));

      // A replay returns 200 with the original body rather than 201: the
      // flight was created once, and saying so twice would be a lie.
      return reply.status(outcome.replayed ? 200 : outcome.status).send(outcome.body);
    },
  );

  /**
   * §3.4: a CSV of a member's **own** flight rows, so they can transcribe
   * into their real logbook. That is the whole extent of the pilot-logbook
   * story — an export, not a feature — and every request past this line gets
   * declined until it is a deliberate decision rather than a drift.
   */
  app.get(
    '/flights/export.csv',
    { config: { requiresTenant: true, permission: ['flights', 'read'] } },
    async (request, reply) => {
      const rows = await request.withTenant(async (trx) => {
        // Own rows by construction rather than by permission: open decision 3
        // has not settled how the model expresses "own only", and this
        // endpoint does not need it to.
        const membership = await ownMembership(trx, request.ctx!.userId);
        /*
          Corrected and logged-in-error flights are left out. This is the
          whole of §3.4's pilot-logbook story — rows somebody transcribes into
          the logbook they actually keep — and a line that was wrong, or a
          flight that never happened, is not something to copy onto paper. The
          trail of what was corrected lives in the app, where it belongs.
        */
        return selectFlights(trx)
          .where('flights.flown_by', '=', membership)
          .where('flights.logged_in_error', '=', false)
          .where(stands)
          .orderBy('flights.flight_date', 'asc')
          .execute();
      });

      const header = [
        'date', 'aircraft', 'from', 'to',
        'hobbs_start', 'hobbs_end', 'hobbs_hours',
        'tach_start', 'tach_end', 'tach_hours', 'remarks',
      ];

      const lines = [
        header.join(','),
        ...rows.map((row) =>
          [
            row.flight_date,
            row.aircraft_registration,
            row.departed_from ?? '',
            row.arrived_at ?? '',
            row.hobbs_start ?? '',
            row.hobbs_end ?? '',
            row.hobbs_hours ?? '',
            row.tach_start ?? '',
            row.tach_end ?? '',
            row.tach_hours ?? '',
            row.remarks ?? '',
          ]
            .map(csvField)
            .join(','),
        ),
      ];

      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', 'attachment; filename="flights.csv"')
        .send(`${lines.join('\n')}\n`);
    },
  );
}

/** RFC 4180: quote anything containing a comma, quote or newline. */
function csvField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}
