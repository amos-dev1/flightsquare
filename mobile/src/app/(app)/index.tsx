import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import type {
  AircraftResponse,
  FlightResponse,
  FlightSummaryResponse,
  MaintenanceItemResponse,
  MeResponse,
  MembershipSummaryResponse,
  ReservationResponse,
  SquawkResponse,
  StatementResponse,
  TenantResponse,
} from '@flightsquare/shared';

import { Body, Button, SectionHeading } from '@/components/ui';
import { Sheet } from '@/components/sheet';
import { api, withAuth } from '@/lib/api';
import { readSession } from '@/lib/auth';
import { useEntitlements, useMoreThanOnePilot } from '@/lib/entitlements';
import { formatMoney, routeOf } from '@/lib/format';
import { SELECTED_AIRCRAFT, readPref, writePref } from '@/lib/prefs';
import { color, radius, space, type } from '@/theme';

/**
 * The first screen after signing in.
 *
 * Its job is the question a pilot opens the app to answer on the way to the
 * field: what do I owe, what is the aeroplane sitting at, what is wrong with
 * it, and what have I got booked. Everything on it is a number the server
 * worked out — §8.2 is explicit that the client never computes anything that
 * matters, and on a screen made entirely of summaries that rule does most of
 * the work.
 *
 * **Two scopes on one screen, and they do not mix.** The aircraft card and
 * its issue count follow whichever aeroplane is selected; the balance, the
 * bookings, the recent flights and the logged time are the account's and the
 * person's and do not change when the selection does. Mixing them would make
 * a balance look like it belonged to an aeroplane.
 *
 * Every call is allowed to fail on its own. A club on the free plan has no
 * statement at all — `member_billing` is Pro and up, so `/statement` answers
 * 404 (§1.6) — and the balance is simply absent. Absence, never an upsell:
 * §8.3 keeps this app inside Apple's 3.1.3(f), so nothing here carries a
 * price or a link.
 */
export default function Dashboard() {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [tenant, setTenant] = useState<TenantResponse | null>(null);
  const [memberships, setMemberships] = useState<MembershipSummaryResponse[]>([]);
  const [statement, setStatement] = useState<StatementResponse | null>(null);
  const [fleet, setFleet] = useState<AircraftResponse[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [summary, setSummary] = useState<FlightSummaryResponse | null>(null);
  const [flights, setFlights] = useState<FlightResponse[]>([]);
  const [squawks, setSquawks] = useState<SquawkResponse[]>([]);
  const [items, setItems] = useState<MaintenanceItemResponse[]>([]);
  const [reservations, setReservations] = useState<ReservationResponse[]>([]);
  const [picking, setPicking] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [offline, setOffline] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  /**
   * The provider fetches once at launch. That is right for a plan, and not
   * quite right for the member count, which decides whether this screen
   * leads with a calendar — so a pull-to-refresh here picks up a second
   * pilot having been invited rather than waiting for the next launch.
   */
  const { refresh: refreshEntitlements } = useEntitlements();

  const load = useCallback(async () => {
    // Each one catches its own. A free tenant's missing statement must not
    // blank the greeting, and a maintenance module switched off by override
    // must not blank the fleet.
    const optional = <T,>(promise: Promise<T>, fallback: T): Promise<T> =>
      promise.catch(() => fallback);

    try {
      const [profile, club, clubs, ledger, aircraft, totals, mine, defects, due, booked] =
        await Promise.all([
          withAuth(() => api.me()),
          withAuth(() => api.tenant()),
          optional(withAuth(() => api.memberships()), []),
          optional(withAuth(() => api.statement()), null),
          optional(withAuth(() => api.listAircraft()), []),
          optional(withAuth(() => api.flightSummary({ mine: true })), null),
          optional(withAuth(() => api.listFlights({ mine: true })), []),
          optional(withAuth(() => api.listSquawks()), []),
          optional(withAuth(() => api.listMaintenanceItems()), []),
          optional(
            withAuth(() => api.listReservations({ mine: true, from: new Date().toISOString() })),
            [],
          ),
        ]);

      void refreshEntitlements();

      setMe(profile);
      setTenant(club);
      setMemberships(clubs);
      setStatement(ledger);
      setFleet(aircraft);
      setSummary(totals);
      setFlights(mine);
      setSquawks(defects);
      setItems(due);
      setReservations(booked);
      setOffline(false);

      /**
       * Restore the selection, and check it against what came back.
       *
       * An aeroplane can be archived, sold, or moved out of reach by a
       * permission change between one launch and the next. A remembered id
       * is therefore a suggestion: if it is not in the list the server just
       * returned, the first active aeroplane takes its place rather than the
       * card rendering empty over an id nobody can resolve.
       */
      const session = await readSession();
      const usable = aircraft.filter((one) => one.status === 'active');
      const remembered =
        session?.tenantId && profile.id
          ? await readPref(profile.id, session.tenantId, SELECTED_AIRCRAFT)
          : null;

      setSelectedId((current) => {
        const wanted = current ?? remembered;
        if (wanted && usable.some((one) => one.id === wanted)) return wanted;
        return usable[0]?.id ?? null;
      });
    } catch {
      // No signal. Whatever loaded last stays on screen — this is a field
      // app, and an empty dashboard would be a lie.
      setOffline(true);
    } finally {
      setLoaded(true);
    }
  }, [refreshEntitlements]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  async function select(id: string) {
    setSelectedId(id);
    setPicking(false);
    const session = await readSession();
    if (me?.id && session?.tenantId) {
      await writePref(me.id, session.tenantId, SELECTED_AIRCRAFT, id);
    }
  }

  const usable = fleet.filter((one) => one.status === 'active');
  const selected = usable.find((one) => one.id === selectedId) ?? null;

  // Aircraft-scoped, so it moves with the selection and nothing else does.
  const issues = useMemo(
    () => (selected ? countIssues(selected.id, squawks, items) : 0),
    [selected, squawks, items],
  );

  const upcoming = reservations.filter((r) => r.status !== 'cancelled').slice(0, 3);
  // Nobody to share with means no calendar to lead with (§4.3).
  const shared = useMoreThanOnePilot();
  const recent = flights.slice(0, 3);
  const balance = statement ? describeBalance(statement) : null;

  return (
    <>
      <ScrollView
        contentContainerStyle={styles.container}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              void load().finally(() => setRefreshing(false));
            }}
          />
        }
      >
        {offline ? (
          <View style={styles.offline}>
            <Feather name="wifi-off" size={16} color={color.secondary} />
            <Text style={styles.offlineText}>Offline. Showing what loaded last.</Text>
          </View>
        ) : null}

        {/* 2 — Greeting ------------------------------------------------ */}
        <View style={styles.greeting}>
          <Text style={styles.hello}>{timeOfDay()},</Text>
          <Text style={styles.name}>{firstNameOf(me)}</Text>
          <ClubLine tenant={tenant} memberships={memberships} />
        </View>

        {/* 3 — Balance ------------------------------------------------- */}
        {balance ? (
          <Pressable
            onPress={() => router.push('/charges')}
            accessibilityRole="button"
            accessibilityLabel={`Your balance, ${balance.amount}, ${balance.wording}`}
            style={({ pressed }) => [styles.card, styles.balance, pressed && styles.pressed]}
          >
            <View style={styles.balanceLeft}>
              <Text style={styles.quiet}>Your balance</Text>
              <Text style={styles.balanceAmount}>{balance.amount}</Text>
            </View>
            <View style={styles.balanceRule} />
            <View style={styles.balanceRight}>
              <Text style={styles.quiet}>{balance.wording}</Text>
              <Feather name="chevron-right" size={18} color={color.secondary} />
            </View>
          </Pressable>
        ) : null}

        {/* 4 & 5 — Your aircraft --------------------------------------- */}
        <SectionRow
          heading="Your aircraft"
          action={usable.length > 1 ? `View all (${usable.length})` : undefined}
          onPress={() => router.push('/aircraft')}
        />

        {selected ? (
          <View style={styles.card}>
            {/* Identity row — tapping it opens the picker, when there is
                more than one thing to pick. */}
            <Pressable
              onPress={usable.length > 1 ? () => setPicking(true) : undefined}
              disabled={usable.length <= 1}
              accessibilityRole={usable.length > 1 ? 'button' : undefined}
              accessibilityLabel={
                usable.length > 1 ? `${selected.registration}. Change aircraft` : undefined
              }
              style={({ pressed }) => [styles.identity, pressed && styles.pressed]}
            >
              <Thumbnail />
              <View style={styles.identityText}>
                <Text style={styles.registration}>{selected.registration}</Text>
                <Text style={styles.model}>{modelOf(selected)}</Text>
              </View>
              {usable.length > 1 ? (
                <Feather name="chevron-down" size={22} color={color.navy} />
              ) : null}
            </Pressable>

            <View style={styles.rule} />

            {/*
              §3.4 and §11: Hobbs and tach are recorded as read, run at
              different rates by design, and neither is derived from the
              other — so they sit side by side, each named, each with its
              unit, and a missing one says so rather than showing a zero.
            */}
            <View style={styles.readings}>
              <Reading label="Hobbs" value={hours(selected.hobbs)} />
              <View style={styles.readingRule} />
              <Reading label="Tach" value={hours(selected.tach)} />
            </View>

            <View style={styles.rule} />

            <View style={styles.readings}>
              <Reading
                /* There is no telemetry here. The only recorded location in
                   the schema is the arrival a pilot typed, so the label says
                   which it is rather than implying the aeroplane is tracked. */
                label="Location · last arrival"
                value={selected.last_location}
                icon="map-pin"
              />
              <View style={styles.readingRule} />
              <Reading
                /* Not "estimated": nothing records whether the tanks were
                   dipped or eyeballed, so the honest claim is who said it
                   and when, which is what "last reported" means. */
                label="Fuel · last reported"
                value={fuel(selected)}
                icon="droplet"
              />
            </View>

            <View style={styles.rule} />

            <RecordedAt aircraft={selected} />

            <View style={styles.rule} />

            {/*
              §11 §11: a count is a count. It is never read as airworthiness,
              and nothing here says "available" or "grounded" — the
              Maintenance screen is where each item gets its correct name,
              and the booking path asks `aircraft_availability` (§3.3).
            */}
            <Pressable
              onPress={() => router.push('/maintenance')}
              accessibilityRole="button"
              accessibilityLabel={`${issues} open ${issues === 1 ? 'issue' : 'issues'}. Review`}
              style={({ pressed }) => [styles.issues, pressed && styles.pressed]}
            >
              <Feather
                name={issues > 0 ? 'alert-triangle' : 'check'}
                size={20}
                color={color.navy}
              />
              <Text style={styles.issueCount}>
                {issues === 0 ? 'No open issues' : `${issues} open ${issues === 1 ? 'issue' : 'issues'}`}
              </Text>
              <Text style={styles.link}>Review</Text>
              <Feather name="chevron-right" size={18} color={color.tealText} />
            </Pressable>
          </View>
        ) : loaded ? (
          <EmptyFleet />
        ) : null}

        {/*
          6 — Actions.

          Two when somebody shares the aeroplane, one when nobody does. A
          solo owner has nothing to book around, so "Log flight" stops being
          the secondary action and becomes the only one — which is also the
          one §3.4 calls the most important screen in the product.
        */}
        {selected ? (
          <View style={styles.actions}>
            {shared ? (
              <View style={styles.action}>
                <Button
                  label="Schedule flight"
                  onPress={() =>
                    router.push({ pathname: '/schedule', params: { aircraft: selected.id } })
                  }
                />
              </View>
            ) : null}
            <View style={styles.action}>
              <Button
                label="Log flight"
                variant={shared ? 'secondary' : 'primary'}
                onPress={() =>
                  router.push({ pathname: '/log-flight', params: { aircraft: selected.id } })
                }
              />
            </View>
          </View>
        ) : null}

        {/*
          7 — Upcoming flights.

          §4.3: scheduling is *unused* for a tenant with one pilot, never
          switched off. There is nobody to share with, so there is nothing
          here to show and nothing to link to — and the section is absent
          rather than sitting empty, which is what "the UI doesn't lead with
          it" means. Invite a second member and it is back, bookings and all.
        */}
        {shared ? (
          <>
            <SectionRow
              heading="Upcoming flights"
              action="View schedule"
              onPress={() => router.push('/schedule')}
            />
            {upcoming.length === 0 ? (
              <View style={[styles.card, styles.emptyRow]}>
                <Feather name="calendar" size={20} color={color.secondary} />
                <Text style={styles.quietBody}>No upcoming flights</Text>
              </View>
            ) : (
              <View style={styles.list}>
                {upcoming.map((reservation, index) => (
                  <View key={reservation.id}>
                    {index > 0 ? <View style={styles.rule} /> : null}
                    <Pressable
                      onPress={() =>
                        router.push({ pathname: '/reservation', params: { id: reservation.id } })
                      }
                      accessibilityRole="button"
                      accessibilityLabel={`Booking, ${reservation.aircraft_registration}, ${when(
                        reservation.starts_at,
                      )}`}
                      style={({ pressed }) => [styles.listRow, pressed && styles.pressed]}
                    >
                      <View style={styles.listMain}>
                        <Text style={styles.rowTitle}>{reservation.aircraft_registration}</Text>
                        <Text style={styles.rowMeta}>
                          {when(reservation.starts_at)} – {clock(reservation.ends_at)}
                          {reservation.purpose ? ` · ${reservation.purpose}` : ''}
                        </Text>
                        {reservation.needs_review ? (
                          /* §3.3: the club flagged this one for somebody to
                             ring. Said here rather than only inside, because
                             the point of a flag is being seen without
                             opening anything. */
                          <Text style={styles.rowMeta}>Needs review</Text>
                        ) : null}
                      </View>
                      <Feather name="chevron-right" size={18} color={color.secondary} />
                    </Pressable>
                  </View>
                ))}
              </View>
            )}
          </>
        ) : null}

        {/* 8 — Recent flights ------------------------------------------ */}
        <SectionRow
          heading="Recent flights"
          action="View all"
          onPress={() => router.push('/logs')}
        />
        {recent.length === 0 ? (
          <View style={[styles.card, styles.emptyRow]}>
            <Feather name="book-open" size={20} color={color.secondary} />
            <Text style={styles.quietBody}>Nothing logged yet</Text>
          </View>
        ) : (
          <View style={styles.list}>
            {recent.map((flight, index) => (
              <View key={flight.id}>
                {index > 0 ? <View style={styles.rule} /> : null}
                <Pressable
                  onPress={() => router.push({ pathname: '/flight', params: { id: flight.id } })}
                  accessibilityRole="button"
                  accessibilityLabel={`Flight on ${flight.flight_date}, ${routeOf(flight)}`}
                  style={({ pressed }) => [styles.listRow, pressed && styles.pressed]}
                >
                  <View style={styles.listMain}>
                    <Text style={styles.rowTitle}>{routeOf(flight)}</Text>
                    <Text style={styles.rowMeta}>
                      {shortDate(flight.flight_date)} · {flight.aircraft_registration}
                    </Text>
                    {/* Both meters, each named. Neither is derived from the
                        other, so the one that is missing is said out loud. */}
                    <Text style={styles.rowMeta}>{metersOf(flight)}</Text>
                  </View>
                  {statement ? (
                    <Text style={styles.rowAmount}>{costOf(statement, flight.id)}</Text>
                  ) : null}
                  <Feather name="chevron-right" size={18} color={color.secondary} />
                </Pressable>
              </View>
            ))}
          </View>
        )}

        {/* 9 — Personal logged time ------------------------------------ */}
        {summary ? (
          <Text style={styles.footnote}>
            Your logged time · {loggedTime(summary)}
          </Text>
        ) : null}
      </ScrollView>

      {/* The selector, over everything, when there is a choice to make. */}
      <AircraftSheet
        visible={picking}
        aircraft={usable}
        selectedId={selectedId}
        onSelect={(id) => void select(id)}
        onClose={() => setPicking(false)}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function SectionRow({
  heading,
  action,
  onPress,
}: {
  heading: string;
  action?: string;
  onPress: () => void;
}) {
  return (
    <View style={styles.sectionRow}>
      <SectionHeading>{heading}</SectionHeading>
      {action ? (
        <Pressable
          onPress={onPress}
          accessibilityRole="button"
          accessibilityLabel={`${action}, ${heading}`}
          hitSlop={space.sm}
          style={({ pressed }) => [styles.sectionAction, pressed && styles.pressed]}
        >
          <Text style={styles.link}>{action}</Text>
          <Feather name="chevron-right" size={16} color={color.tealText} />
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * The club, and a way to change it only when there is another one.
 *
 * §3.1: one human, many memberships. Switching reuses the picker sign-in
 * already uses and the `selectTenant` call behind it — this is the existing
 * behaviour reached from a second place, not a second way of doing it.
 */
function ClubLine({
  tenant,
  memberships,
}: {
  tenant: TenantResponse | null;
  memberships: MembershipSummaryResponse[];
}) {
  if (!tenant) return null;

  if (memberships.length <= 1) {
    return <Text style={styles.club}>{tenant.name}</Text>;
  }

  return (
    <Pressable
      onPress={() =>
        router.push({
          pathname: '/choose-tenant',
          params: {
            memberships: JSON.stringify(
              memberships.map((one) => ({
                tenant_id: one.tenant_id,
                tenant_name: one.tenant_name,
              })),
            ),
          },
        })
      }
      accessibilityRole="button"
      accessibilityLabel={`${tenant.name}. Switch club`}
      hitSlop={space.sm}
      style={({ pressed }) => [styles.clubRow, pressed && styles.pressed]}
    >
      <Text style={styles.club}>{tenant.name}</Text>
      <Feather name="chevron-down" size={18} color={color.secondary} />
    </Pressable>
  );
}

/**
 * A placeholder, not a photograph.
 *
 * Nothing in the schema stores an aircraft image — `aircraft_documents` holds
 * the airworthiness certificate, the registration, insurance and weight and
 * balance, and none of those is a picture of the aeroplane. So this is a
 * marked space rather than stock imagery standing in for a real one, and §11
 * is explicit that the official logo is never used as an aircraft icon.
 */
function Thumbnail() {
  return (
    <View style={styles.thumb} accessibilityElementsHidden importantForAccessibility="no">
      <Feather name="image" size={20} color={color.secondary} />
    </View>
  );
}

function Reading({
  label,
  value,
  icon,
}: {
  label: string;
  value: string | null;
  icon?: 'map-pin' | 'droplet';
}) {
  return (
    <View style={styles.reading}>
      {/*
        Nothing here is capped to a line count. §11 §13 asks for readable
        text at accessibility sizes, and a truncated meter reading — "1,21…"
        — is worse than one that wraps onto a second line. The column is
        flexible, so it grows.
      */}
      <Text style={styles.quiet}>{label}</Text>
      <View style={styles.readingValue}>
        {icon && value ? <Feather name={icon} size={16} color={color.secondary} /> : null}
        <Text style={value ? styles.readingNumber : styles.readingAbsent}>
          {/* §11: "Not recorded" rather than a zero. They are different
              answers and only one of them is true. */}
          {value ?? 'Not recorded'}
        </Text>
      </View>
    </View>
  );
}

/**
 * When these readings were taken.
 *
 * One line when the meters, the fuel and the location all land in the same
 * displayed minute, which is what happens when they came off the same
 * flight. Otherwise each is dated where it stands — a single "last recorded"
 * over three readings from three different days would be a claim about two
 * of them that nothing supports.
 */
function RecordedAt({ aircraft }: { aircraft: AircraftResponse }) {
  const stamps = [
    { label: 'Meters', at: aircraft.totals_updated_at },
    { label: 'Fuel', at: aircraft.fuel_remaining_at },
    { label: 'Location', at: aircraft.last_location_at },
  ].filter((one): one is { label: string; at: string } => one.at !== null);

  if (stamps.length === 0) {
    return (
      <View style={styles.recordedList}>
        <Text style={styles.recorded}>Nothing recorded yet</Text>
      </View>
    );
  }

  const rendered = stamps.map((one) => recordedAt(one.at));
  const agree = rendered.every((text) => text === rendered[0]);

  return (
    <View style={styles.recordedList}>
      {agree ? (
        <Text style={styles.recorded}>Last recorded · {rendered[0]}</Text>
      ) : (
        stamps.map((one, index) => (
          <Text key={one.label} style={styles.recorded}>
            {one.label} · {rendered[index]}
          </Text>
        ))
      )}
    </View>
  );
}

function EmptyFleet() {
  return (
    <View style={[styles.card, styles.empty]}>
      <SectionHeading>No aircraft yet</SectionHeading>
      <Body muted>
        Add one and its meters, maintenance schedule and bookings all hang off
        it.
      </Body>
      <Button label="Add aircraft" onPress={() => router.push('/aircraft')} />
    </View>
  );
}

/**
 * The selector.
 *
 * Search appears once a fleet is long enough to scroll past, which is the
 * point at which scanning stops being faster than typing.
 */
function AircraftSheet({
  visible,
  aircraft,
  selectedId,
  onSelect,
  onClose,
}: {
  visible: boolean;
  aircraft: AircraftResponse[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const searchable = aircraft.length > 6;

  const shown = query.trim()
    ? aircraft.filter((one) =>
        `${one.registration} ${one.type_code ?? ''}`
          .toLowerCase()
          .includes(query.trim().toLowerCase()),
      )
    : aircraft;

  return (
    <Sheet visible={visible} title="Choose aircraft" onClose={onClose}>
      {searchable ? (
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Registration or type"
          placeholderTextColor={color.secondary}
          autoCapitalize="characters"
          autoCorrect={false}
          style={styles.search}
          accessibilityLabel="Search aircraft"
        />
      ) : null}

      {shown.length === 0 ? (
        <Body muted>Nothing matches that.</Body>
      ) : (
        shown.map((one) => {
          const chosen = one.id === selectedId;
          return (
            <Pressable
              key={one.id}
              onPress={() => onSelect(one.id)}
              accessibilityRole="radio"
              accessibilityState={{ selected: chosen }}
              style={({ pressed }) => [
                styles.option,
                chosen && styles.optionChosen,
                pressed && styles.pressed,
              ]}
            >
              <Thumbnail />
              <View style={styles.identityText}>
                <Text style={styles.optionRegistration}>{one.registration}</Text>
                <Text style={styles.model}>{modelOf(one)}</Text>
                <Text style={styles.quiet}>
                  {one.last_location
                    ? `Last at ${one.last_location}`
                    : 'No arrival recorded'}
                </Text>
              </View>
              {/* A mark as well as the fill, so selection is never colour
                  alone (§11 §13). */}
              {chosen ? <Feather name="check" size={20} color={color.tealText} /> : null}
            </Pressable>
          );
        })
      )}
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// The small decisions
// ---------------------------------------------------------------------------

function timeOfDay(now: Date = new Date()): string {
  const hour = now.getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/**
 * `users.name` is one nullable field, not a first and a last.
 *
 * The greeting wants the short form, so this takes the first word of whatever
 * somebody typed rather than pretending the column is structured. With no
 * name at all it falls back to the address, which every account has. A real
 * first/last split is a migration and a decision, not something to improvise
 * in a greeting.
 */
function firstNameOf(me: MeResponse | null): string {
  if (!me) return '';
  const name = me.name?.trim();
  if (name) return name.split(/\s+/)[0]!;
  return me.email.split('@')[0]!;
}

/** The ICAO type designator is what the schema holds; there is no model name. */
function modelOf(aircraft: AircraftResponse): string {
  return aircraft.type_code ?? 'Type not recorded';
}

/** §11: tabular hours with the unit named, or an honest absence. */
function hours(value: string | null): string | null {
  if (value === null) return null;
  return `${Number(value).toLocaleString(undefined, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })} h`;
}

/**
 * What is in the tanks, in the units this aeroplane is configured in.
 *
 * Never a percentage: that would need a capacity every aircraft has and some
 * do not, and §3.4 is explicit that fuel is a reading rather than a
 * calculation.
 */
function fuel(aircraft: AircraftResponse): string | null {
  if (aircraft.fuel_remaining === null) return null;
  const unit = aircraft.fuel_units === 'litres' ? 'L' : 'US gal';
  return `${Number(aircraft.fuel_remaining).toLocaleString(undefined, {
    maximumFractionDigits: 1,
  })} ${unit}`;
}

/**
 * Things wanting attention on this aeroplane, which is not the same as things
 * overdue.
 *
 * A maintenance item that is `overdue` with `ever_complied === false` was
 * seeded with the aeroplane and never confirmed — it belongs in the count,
 * because somebody should deal with it, and it does not let this screen say
 * the word "overdue" about an aeroplane. The Maintenance tab is where each
 * group gets its correct name.
 */
function countIssues(
  aircraftId: string,
  squawks: SquawkResponse[],
  items: MaintenanceItemResponse[],
): number {
  const open = squawks.filter(
    (squawk) => squawk.aircraft_id === aircraftId && squawk.status !== 'resolved',
  ).length;
  const attention = items.filter(
    (item) =>
      item.aircraft_id === aircraftId &&
      (item.state === 'overdue' || item.state === 'due_soon'),
  ).length;
  return open + attention;
}

/** §11: never a bare sign. The wording carries it. */
function describeBalance(statement: StatementResponse): { amount: string; wording: string } {
  const cents = statement.balance_cents;
  const amount = formatMoney(Math.abs(cents), statement.currency);
  if (cents === 0) return { amount, wording: 'Settled up' };
  return { amount, wording: cents > 0 ? 'Amount owed' : 'In credit' };
}

function metersOf(flight: FlightResponse): string {
  const read: string[] = [];
  if (flight.hobbs_hours) read.push(`${flight.hobbs_hours} Hobbs`);
  if (flight.tach_hours) read.push(`${flight.tach_hours} Tach`);
  return read.length > 0 ? read.join(' · ') : 'No meters recorded';
}

/**
 * The pilot's own hours on this account.
 *
 * Which meter is named, because §3.4 says neither is derived from the other
 * and a bare "13.9 h" would not say which one it counted. This is hours flown
 * here and nothing more — not a logbook, not currency, and not experience
 * (§3.4 draws that line and this stays on the near side of it).
 */
function loggedTime(summary: FlightSummaryResponse): string {
  const hobbs = Number(summary.hobbs_hours);
  if (hobbs > 0) return `${hobbs.toFixed(1)} h (Hobbs)`;
  const tach = Number(summary.tach_hours);
  if (tach > 0) return `${tach.toFixed(1)} h (Tach)`;
  return 'nothing logged yet';
}

function costOf(statement: StatementResponse, flightId: string): string {
  const lines = statement.lines.filter((line) => line.flight_id === flightId);
  if (lines.length === 0) return '—';
  const cents = lines.reduce((total, line) => total + line.amount_cents, 0);
  return formatMoney(cents, statement.currency);
}

/** §11: the zone is named, because "4:30 PM" alone is ambiguous by design. */
function recordedAt(instant: string): string {
  return new Date(instant).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

function shortDate(date: string): string {
  // A plain date, not an instant: parsed as UTC and formatted as UTC, so it
  // does not slide a day backwards west of Greenwich.
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

/**
 * A booking's start.
 *
 * The year appears only when it is not this one: "Sat, 5 Jun" sitting under
 * "Sun, 27 Sep" read as though the list were out of order, when in fact the
 * first was a year further out.
 */
function when(instant: string): string {
  const date = new Date(instant);
  return date.toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(date.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }),
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function clock(instant: string): string {
  return new Date(instant).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  container: { padding: space.base, paddingBottom: space.xxl, gap: space.md },

  offline: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  offlineText: { ...type.supporting, color: color.secondary },

  card: {
    backgroundColor: color.surface,
    borderColor: color.line,
    borderWidth: 1,
    borderRadius: radius.card,
  },
  pressed: { opacity: 0.7 },
  rule: { height: 1, backgroundColor: color.line },
  link: { ...type.button, color: color.tealText },
  quiet: { ...type.supporting, color: color.secondary },
  quietBody: { ...type.body, color: color.secondary },

  // 2 — greeting
  greeting: { gap: 2 },
  hello: { ...type.body, color: color.secondary },
  name: { ...type.pageTitle, fontSize: 32, lineHeight: 38 },
  club: { ...type.body, color: color.secondary },
  clubRow: { flexDirection: 'row', alignItems: 'center', gap: space.xs },

  // 3 — balance
  balance: { flexDirection: 'row', alignItems: 'center', padding: space.base },
  balanceLeft: { flex: 1, gap: space.xs },
  balanceAmount: { ...type.metric, fontVariant: ['tabular-nums'] },
  balanceRule: { width: 1, alignSelf: 'stretch', backgroundColor: color.line },
  balanceRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingLeft: space.base,
  },

  // 4 — section headers
  sectionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: space.sm,
  },
  sectionAction: { flexDirection: 'row', alignItems: 'center', gap: space.xs, paddingVertical: space.xs },

  // 5 — aircraft card
  identity: { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.base },
  identityText: { flex: 1, gap: 2, flexShrink: 1 },
  registration: { ...type.sectionHeading, textTransform: 'uppercase' },
  model: { ...type.body, color: color.secondary },
  thumb: {
    width: 72,
    height: 54,
    borderRadius: 8,
    backgroundColor: color.mist,
    alignItems: 'center',
    justifyContent: 'center',
  },

  readings: { flexDirection: 'row', paddingVertical: space.md, paddingHorizontal: space.base },
  reading: { flex: 1, gap: space.xs },
  readingRule: { width: 1, backgroundColor: color.line, marginHorizontal: space.base },
  readingValue: { flexDirection: 'row', alignItems: 'center', gap: space.xs, flexWrap: 'wrap' },
  readingNumber: { ...type.cardHeading, fontSize: 18, fontVariant: ['tabular-nums'] },
  readingAbsent: { ...type.body, color: color.secondary },

  recorded: { ...type.supporting, color: color.secondary },
  recordedList: { gap: 2, paddingHorizontal: space.base, paddingVertical: space.md },

  issues: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    padding: space.base,
    minHeight: 56,
  },
  issueCount: { ...type.cardHeading, flex: 1 },

  empty: { padding: space.base, gap: space.md },
  emptyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.base,
    minHeight: 60,
  },

  // 6 — actions
  actions: { flexDirection: 'row', gap: space.md },
  action: { flex: 1 },

  // 7 & 8 — lists
  list: {
    backgroundColor: color.surface,
    borderColor: color.line,
    borderWidth: 1,
    borderRadius: radius.card,
    overflow: 'hidden',
  },
  listRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.base,
  },
  listMain: { flex: 1, gap: 2 },
  rowTitle: { ...type.cardHeading },
  rowMeta: { ...type.supporting, color: color.secondary },
  rowAmount: { ...type.cardHeading, fontVariant: ['tabular-nums'] },

  // 9 — footnote
  footnote: { ...type.supporting, color: color.secondary, marginTop: space.xs },

  // the sheet
  search: {
    minHeight: 44,
    paddingVertical: space.sm,
    borderWidth: 1,
    borderColor: color.control,
    borderRadius: radius.control,
    paddingHorizontal: space.md,
    backgroundColor: color.surface,
    ...type.input,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.md,
    borderWidth: 1,
    borderColor: color.line,
    borderRadius: radius.card,
    minHeight: 72,
  },
  optionChosen: { borderColor: color.teal, backgroundColor: color.selected },
  optionRegistration: { ...type.cardHeading, textTransform: 'uppercase' },
});
