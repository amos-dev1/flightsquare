import Link from 'next/link';
import { ChevronLeft, ChevronRight } from 'lucide-react';

import { apiFetch } from '@/lib/api';
import { Card, Empty, PageTitle, SectionHeading, Status } from '@/components/ui';
import { addDays, dayIn, dayLabel, startOfWeek, timeIn, todayIn } from '@/lib/time';
import type {
  AircraftAvailabilityResponse,
  AircraftResponse,
  BlackoutResponse,
  EntitlementsResponse,
  ReservationResponse,
  TenantResponse,
} from '@flightsquare/shared';

import { BlackoutForm, BookingForm, CancelBooking, ClearFlag, RemoveBlackout } from './client';

/**
 * The calendar (§3.3, V1_SCOPE M3).
 *
 * A week of day columns, because a week is the unit a club thinks in — "who
 * has it Saturday" — and a day view for when that is the question instead.
 *
 * No time grid. Per aircraft there can be no overlaps at all, because the
 * exclusion constraint forbids them, so an ordered list of the day's
 * bookings is complete information rather than a simplification. A grid
 * would spend a great deal of CSS to say the same thing, and say it worse on
 * a phone at a tiedown.
 */
export default async function SchedulePage({
  searchParams,
}: {
  searchParams: Promise<{ aircraft?: string; from?: string; view?: string }>;
}) {
  const params = await searchParams;

  const [tenant, fleet, entitlements] = await Promise.all([
    apiFetch<TenantResponse>('/tenant'),
    apiFetch<AircraftResponse[]>('/aircraft'),
    apiFetch<EntitlementsResponse>('/entitlements'),
  ]);

  const zone = tenant.timezone || 'UTC';
  const active = fleet.filter((aircraft) => aircraft.status !== 'archived');
  const canBook = entitlements.permissions.reservations === 'write';
  const administers = entitlements.permissions.aircraft === 'write';

  if (active.length === 0) {
    return (
      <div className="space-y-6">
        <PageTitle>Schedule</PageTitle>
        <Empty title="No aircraft to book">
          <Link href="/aircraft/new" className="underline decoration-1 underline-offset-2">
            Add an aircraft
          </Link>{' '}
          and it appears here.
        </Empty>
      </div>
    );
  }

  const view = params.view === 'day' ? 'day' : 'week';
  const anchor = params.from ?? todayIn(zone);
  const first = view === 'week' ? startOfWeek(anchor) : anchor;
  const span = view === 'week' ? 7 : 1;
  const days = Array.from({ length: span }, (_, index) => addDays(first, index));
  const selected = params.aircraft ?? '';

  // The window the calendar is showing, as instants. A calendar is always a
  // window; without one the API would happily return every booking a club
  // has ever made.
  const from = `${first}T00:00:00Z`;
  const to = `${addDays(first, span + 1)}T00:00:00Z`;
  const query = new URLSearchParams({ from, to });
  if (selected) query.set('aircraft_id', selected);

  /**
   * "My upcoming reservations" is a different question from the week on
   * screen, and a different one again from what this viewer may edit — an
   * admin may edit everybody's, which is not the same as having booked it.
   * So it is its own query, unbounded forward, filtered by the server.
   */
  const upcoming = new URLSearchParams({ mine: 'true', from: new Date().toISOString() });

  const [reservations, blackouts, availability, mine] = await Promise.all([
    apiFetch<ReservationResponse[]>(`/reservations?${query}`),
    apiFetch<BlackoutResponse[]>(`/blackouts?${query}`),
    apiFetch<AircraftAvailabilityResponse[]>('/availability'),
    apiFetch<ReservationResponse[]>(`/reservations?${upcoming}`),
  ]);
  const flagged = reservations.filter((r) => r.needs_review);
  const unavailable = availability.filter((a) => !a.available);

  const href = (next: Partial<{ from: string; view: string; aircraft: string }>) => {
    const search = new URLSearchParams();
    search.set('from', next.from ?? first);
    search.set('view', next.view ?? view);
    const aircraft = next.aircraft ?? selected;
    if (aircraft) search.set('aircraft', aircraft);
    return `/schedule?${search}`;
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <PageTitle>Schedule</PageTitle>
          <p className="mt-1 text-sm text-secondary">
            {dayLabel(first, zone)}
            {view === 'week' ? ` – ${dayLabel(addDays(first, 6), zone)}` : ''} ·{' '}
            {/* §11: name the zone where it matters. A club that books at its
                own field should never wonder which clock a time is on. */}
            times shown in {zone.replace(/_/g, ' ')}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Link href={href({ from: addDays(first, -span) })}>
            <span className="inline-flex h-11 items-center gap-1 rounded-lg border border-control px-3 text-sm font-semibold hover:bg-subtle">
              <ChevronLeft aria-hidden size={16} strokeWidth={2} />
              Previous
            </span>
          </Link>
          <Link href={href({ from: todayIn(zone) })}>
            <span className="inline-flex h-11 items-center rounded-lg border border-control px-3 text-sm font-semibold hover:bg-subtle">
              Today
            </span>
          </Link>
          <Link href={href({ from: addDays(first, span) })}>
            <span className="inline-flex h-11 items-center gap-1 rounded-lg border border-control px-3 text-sm font-semibold hover:bg-subtle">
              Next
              <ChevronRight aria-hidden size={16} strokeWidth={2} />
            </span>
          </Link>
        </div>
      </div>

      {/* Filters as links, so a calendar view is a URL somebody can send. */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
        <span className="flex items-center gap-2">
          <span className="font-semibold">View</span>
          <ViewLink href={href({ view: 'week' })} active={view === 'week'}>
            Week
          </ViewLink>
          <ViewLink href={href({ view: 'day' })} active={view === 'day'}>
            Day
          </ViewLink>
        </span>

        <span className="flex flex-wrap items-center gap-2">
          <span className="font-semibold">Aircraft</span>
          <ViewLink href={href({ aircraft: '' })} active={selected === ''}>
            All
          </ViewLink>
          {active.map((aircraft) => (
            <ViewLink
              key={aircraft.id}
              href={href({ aircraft: aircraft.id })}
              active={selected === aircraft.id}
            >
              {aircraft.registration}
            </ViewLink>
          ))}
        </span>
      </div>

      {/*
        §3.3: an aircraft that is out of service is said once, at the top,
        rather than inferred from an empty column.
      */}
      {unavailable.length > 0 ? (
        <Card className="space-y-2 p-5">
          {unavailable.map((aircraft) => (
            <div key={aircraft.aircraft_id} className="flex flex-wrap items-center gap-3">
              <Status kind="grounded" />
              <span className="text-sm font-semibold">{aircraft.registration}</span>
              <span className="text-sm text-secondary">
                {aircraft.grounding_reasons.join(' · ')}
              </span>
            </div>
          ))}
        </Card>
      ) : null}

      {/*
        The bookings a grounding caught. Never cancelled — somebody has to
        call those members, and only they know what else was arranged.
      */}
      {flagged.length > 0 ? (
        <section className="space-y-3">
          <SectionHeading>Needs a phone call</SectionHeading>
          <Card className="divide-y divide-line">
            {flagged.map((reservation) => (
              <div key={reservation.id} className="px-5 py-4">
                <p className="text-base font-semibold">
                  {reservation.aircraft_registration} ·{' '}
                  <time dateTime={reservation.starts_at} className="tabular">
                    {dayLabel(dayIn(reservation.starts_at, zone), zone)}{' '}
                    {timeIn(reservation.starts_at, zone)}
                  </time>
                </p>
                <p className="mt-0.5 text-sm text-secondary">
                  {reservation.booked_by_name ?? reservation.booked_by_email} ·{' '}
                  {reservation.review_reason}
                </p>
                {administers ? <ClearFlag id={reservation.id} /> : null}
              </div>
            ))}
          </Card>
        </section>
      ) : null}

      {mine.length > 0 ? (
        <section className="space-y-3">
          <SectionHeading>Yours, coming up</SectionHeading>
          <Card className="divide-y divide-line">
            {mine.slice(0, 10).map((reservation) => (
              <div
                key={reservation.id}
                className="flex flex-wrap items-center justify-between gap-4 px-5 py-3"
              >
                <span className="text-sm">
                  <span className="font-semibold">{reservation.aircraft_registration}</span>{' '}
                  <span className="tabular">
                    {dayLabel(dayIn(reservation.starts_at, zone), zone)}{' '}
                    {timeIn(reservation.starts_at, zone)}–{timeIn(reservation.ends_at, zone)}
                  </span>
                  {reservation.purpose ? ` · ${reservation.purpose}` : ''}
                </span>
                <CancelBooking id={reservation.id} label="Cancel" />
              </div>
            ))}
          </Card>
        </section>
      ) : null}

      {/*
        Seven columns on a desktop, one stacked list on a phone. The same
        markup either way — §11 asks for layouts that adapt rather than
        desktop screens that shrink.
      */}
      <section className="space-y-3">
        <SectionHeading>{view === 'week' ? 'This week' : 'This day'}</SectionHeading>
        <div
          className={`grid gap-3 ${view === 'week' ? 'sm:grid-cols-2 lg:grid-cols-7' : ''}`}
        >
          {days.map((day) => (
            <Day
              key={day}
              day={day}
              zone={zone}
              reservations={reservations.filter((r) => dayIn(r.starts_at, zone) === day)}
              blackouts={blackouts.filter((b) => dayIn(b.starts_at, zone) <= day && dayIn(b.ends_at, zone) >= day)}
              today={day === todayIn(zone)}
            />
          ))}
        </div>
      </section>

      {canBook ? (
        <section className="space-y-3">
          <SectionHeading>Book the aeroplane</SectionHeading>
          <BookingForm
            fleet={active}
            defaultAircraftId={selected || active[0]!.id}
            defaultDate={first}
            zoneLabel={`Local time at ${zone.replace(/_/g, ' ')}`}
          />
        </section>
      ) : null}

      {administers ? (
        <section className="space-y-3">
          <SectionHeading>Take it off the calendar</SectionHeading>
          <BlackoutForm
            fleet={active}
            defaultAircraftId={selected || active[0]!.id}
            defaultDate={first}
            zoneLabel={`Local time at ${zone.replace(/_/g, ' ')}`}
          />
          {blackouts.length > 0 ? (
            <Card className="divide-y divide-line">
              {blackouts.map((blackout) => (
                <div
                  key={blackout.id}
                  className="flex flex-wrap items-center justify-between gap-4 px-5 py-3"
                >
                  <span className="text-sm">
                    <span className="font-semibold">{blackout.aircraft_registration}</span>{' '}
                    {blackout.reason}{' '}
                    <span className="tabular text-secondary">
                      {dayLabel(dayIn(blackout.starts_at, zone), zone)} –{' '}
                      {dayLabel(dayIn(blackout.ends_at, zone), zone)}
                    </span>
                  </span>
                  <RemoveBlackout blackout={blackout} />
                </div>
              ))}
            </Card>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

function ViewLink({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? 'true' : undefined}
      className={`rounded-lg px-2 py-1 ${
        // §11: selection is weight and fill, never colour alone.
        active ? 'bg-brand-black font-semibold text-surface' : 'text-secondary hover:bg-subtle'
      }`}
    >
      {children}
    </Link>
  );
}

function Day({
  day,
  zone,
  reservations,
  blackouts,
  today,
}: {
  day: string;
  zone: string;
  reservations: ReservationResponse[];
  blackouts: BlackoutResponse[];
  today: boolean;
}) {
  return (
    <Card className={`p-3 ${today ? 'border-brand-black' : ''}`}>
      <p className="flex items-baseline gap-2 text-sm font-semibold">
        {dayLabel(day, zone)}
        {/* Today marked by weight and a border as well as the accent, so it
            survives being read without colour (§11). */}
        {today ? <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-accent" /> : null}
        {today ? <span className="sr-only">(today)</span> : null}
      </p>

      <div className="mt-2 space-y-2">
        {blackouts.map((blackout) => (
          <div key={blackout.id} className="rounded-lg border border-brand-black bg-subtle p-2">
            <p className="text-xs font-semibold">Unavailable</p>
            <p className="text-xs text-secondary">
              {blackout.aircraft_registration} · {blackout.reason}
            </p>
          </div>
        ))}

        {reservations.map((reservation) => (
          <div key={reservation.id} className="rounded-lg bg-subtle p-2">
            <p className="tabular text-xs font-semibold">
              {timeIn(reservation.starts_at, zone)}–{timeIn(reservation.ends_at, zone)}
            </p>
            <p className="text-xs">{reservation.aircraft_registration}</p>
            <p className="text-xs text-secondary">
              {reservation.booked_by_name ?? reservation.booked_by_email}
              {reservation.purpose ? ` · ${reservation.purpose}` : ''}
            </p>
          </div>
        ))}

        {reservations.length === 0 && blackouts.length === 0 ? (
          <p className="text-xs text-secondary">Free</p>
        ) : null}
      </div>
    </Card>
  );
}
