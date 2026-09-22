import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import type {
  FlightResponse,
  FlightSummaryResponse,
  MaintenanceItemResponse,
  MeResponse,
  ReservationResponse,
  SquawkResponse,
  StatementResponse,
  TenantResponse,
} from '@flightsquare/shared';

import { Body, Button, Card, Notice, SectionHeading } from '@/components/ui';
import { api, withAuth } from '@/lib/api';
import { formatBalance, formatMoney, routeOf } from '@/lib/format';
import { useQuota } from '@/lib/entitlements';
import { color, space, type } from '@/theme';

/**
 * The first screen after signing in.
 *
 * Its job is the question a pilot opens the app to answer on the way to the
 * field: is the aeroplane fit, what do I owe, what did I last fly, and what
 * have I got booked. Everything on it is a number the server worked out —
 * §8.2 is explicit that the client never computes anything that matters, and
 * on a screen made entirely of summaries that rule does most of the work.
 *
 * Eight small calls, each allowed to fail on its own. A club on the free
 * plan has no statement at all — `member_billing` is Pro and up, so
 * `/statement` answers 404 (§1.6) — and the balance simply is not there.
 * Absence, never an upsell: §8.3 keeps this app inside Apple's 3.1.3(f), so
 * nothing here carries a price or a link.
 */
export default function Dashboard() {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [tenant, setTenant] = useState<TenantResponse | null>(null);
  const [statement, setStatement] = useState<StatementResponse | null>(null);
  const [summary, setSummary] = useState<FlightSummaryResponse | null>(null);
  const [flights, setFlights] = useState<FlightResponse[]>([]);
  const [squawks, setSquawks] = useState<SquawkResponse[]>([]);
  const [items, setItems] = useState<MaintenanceItemResponse[]>([]);
  const [reservations, setReservations] = useState<ReservationResponse[]>([]);
  const [offline, setOffline] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const aircraftQuota = useQuota('aircraft.active');

  const load = useCallback(async () => {
    // Each one catches its own. A free tenant's missing statement must not
    // blank the greeting, and a maintenance module switched off by override
    // must not blank the fleet count.
    const optional = <T,>(promise: Promise<T>, fallback: T): Promise<T> =>
      promise.catch(() => fallback);

    try {
      const [profile, club, ledger, totals, mine, defects, due, booked] = await Promise.all([
        withAuth(() => api.me()),
        withAuth(() => api.tenant()),
        optional(withAuth(() => api.statement()), null),
        optional(withAuth(() => api.flightSummary()), null),
        optional(withAuth(() => api.listFlights({ mine: true })), []),
        optional(withAuth(() => api.listSquawks()), []),
        optional(withAuth(() => api.listMaintenanceItems()), []),
        optional(
          withAuth(() => api.listReservations({ mine: true, from: new Date().toISOString() })),
          [],
        ),
      ]);

      setMe(profile);
      setTenant(club);
      setStatement(ledger);
      setSummary(totals);
      setFlights(mine);
      setSquawks(defects);
      setItems(due);
      setReservations(booked);
      setOffline(false);
    } catch {
      // No signal. Whatever loaded last stays on screen — this is a field
      // app, and an empty dashboard would be a lie.
      setOffline(true);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const recent = flights.slice(0, 3);
  const upcoming = reservations.filter((r) => r.status !== 'cancelled').slice(0, 3);

  return (
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
      {offline ? <Notice>Offline. Showing what loaded last.</Notice> : null}

      {/* Greeting ---------------------------------------------------- */}
      <View style={styles.greeting}>
        <Text style={styles.hello}>
          {timeOfDay()}
          {me ? `, ${nameOf(me)}` : ''}
        </Text>
        {tenant ? <Text style={styles.club}>{tenant.name}</Text> : null}
      </View>

      {/* Balance ----------------------------------------------------- */}
      {statement ? (
        <Pressable
          onPress={() => router.push('/charges')}
          accessibilityRole="button"
          accessibilityLabel="Your balance"
        >
          <Card>
            <View style={styles.balanceRow}>
              <Feather name="dollar-sign" size={18} color={color.secondary} />
              <Text style={styles.balanceLabel}>Your balance</Text>
              <Feather name="chevron-right" size={18} color={color.secondary} />
            </View>
            <Text style={styles.balance}>
              {formatBalance(statement.balance_cents, statement.currency)}
            </Text>
          </Card>
        </Pressable>
      ) : null}

      {/* Three boxes ------------------------------------------------- */}
      <View style={styles.boxes}>
        <Box
          label="Aircraft"
          value={aircraftQuota?.current ?? null}
          onPress={() => router.push('/aircraft')}
        />
        <Box
          label="Issues"
          value={countIssues(squawks, items)}
          onPress={() => router.push('/maintenance')}
        />
        <Box
          label="Total hours"
          value={summary ? hoursOf(summary).value : null}
          // §11 and §3.4: which meter, said out loud. Inline with the
          // number so all three boxes are the same two lines.
          unit={summary ? hoursOf(summary).meter : undefined}
          onPress={() => router.push('/logs')}
        />
      </View>

      {/* Last three flights ------------------------------------------ */}
      <View style={styles.section}>
        <SectionHeading>Your last flights</SectionHeading>
        {recent.length === 0 ? (
          <Body muted>Nothing logged yet. The post-flight entry is on an aircraft.</Body>
        ) : (
          recent.map((flight) => (
            <Card key={flight.id}>
              <View style={styles.flightRow}>
                {/*
                  Route where there is one. Both fields are nullable free
                  text since 0014, and a flight with neither rendered as
                  "— → —", which is noise standing where the headline goes.
                  The aeroplane is the honest fallback: it is the one thing
                  every flight has.
                */}
                <Text style={styles.route}>{routeOf(flight)}</Text>
                {squawks.some((squawk) => squawk.found_on_flight_id === flight.id) ? (
                  // §3.6: a defect found on this flight. Stated, not implied
                  // by a colour, and it says nothing about airworthiness —
                  // the Maintenance tab holds that answer.
                  <Feather
                    name="flag"
                    size={16}
                    color={color.brandBlack}
                    accessibilityLabel="A defect was reported on this flight"
                  />
                ) : null}
              </View>
              <Text style={styles.flightMeta}>
                {flight.flight_date}
                {routeOf(flight) === flight.aircraft_registration
                  ? ''
                  : ` · ${flight.aircraft_registration}`}
                {flight.hobbs_hours ? ` · ${flight.hobbs_hours} hobbs` : ''}
              </Text>
              {statement ? (
                <Text style={styles.cost}>{costOf(statement, flight.id)}</Text>
              ) : null}
            </Card>
          ))
        )}
      </View>

      {/*
        Upcoming reservations.
        §1: scheduling is "unused, never unavailable" — no flag, no separate
        code path. A solo owner sees nothing here because nobody has booked
        anything, which is the same outcome as hiding it and arrived at the
        way the constitution requires.
      */}
      <View style={styles.section}>
        <SectionHeading>Coming up</SectionHeading>
        {upcoming.length === 0 ? (
          <Body muted>Nothing booked.</Body>
        ) : (
          upcoming.map((reservation) => (
            <Card key={reservation.id}>
              <Text style={styles.route}>{reservation.aircraft_registration}</Text>
              <Text style={styles.flightMeta}>
                {when(reservation.starts_at)} – {clock(reservation.ends_at)}
                {reservation.purpose ? ` · ${reservation.purpose}` : ''}
              </Text>
            </Card>
          ))
        )}
        <Button label="Schedule flight" onPress={() => router.push('/schedule')} />
      </View>
    </ScrollView>
  );
}

function Box({
  label,
  value,
  unit,
  onPress,
}: {
  label: string;
  value: number | string | null;
  unit?: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${value ?? 'not known'}`}
      style={({ pressed }) => [styles.box, pressed && styles.boxPressed]}
    >
      <Text style={styles.boxValue}>
        {value ?? '—'}
        {unit ? <Text style={styles.boxUnit}> {unit}</Text> : null}
      </Text>
      <Text style={styles.boxLabel}>{label}</Text>
    </Pressable>
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
 * The doc asks for both names, and whatever somebody typed is both names —
 * splitting and rejoining it would only be a chance to get it wrong. When
 * there is no name at all it falls back to the address, which every account
 * has. A real first/last split is a migration and a decision, not something
 * to improvise in a greeting.
 */
function nameOf(me: MeResponse): string {
  return me.name?.trim() || me.email.split('@')[0]!;
}

/**
 * Things wanting attention, which is not the same as things overdue.
 *
 * A maintenance item that is `overdue` with `ever_complied === false` was
 * seeded with the aeroplane and never confirmed — the aircraft screen is
 * careful about this and so is the digest. It belongs in the count, because
 * somebody should deal with it, and it does not make this screen say the
 * word "overdue" about an aeroplane. The Maintenance tab is where each group
 * gets its correct name.
 */
function countIssues(squawks: SquawkResponse[], items: MaintenanceItemResponse[]): number {
  const open = squawks.filter((squawk) => squawk.status !== 'resolved').length;
  const attention = items.filter(
    (item) => item.state === 'overdue' || item.state === 'due_soon',
  ).length;
  return open + attention;
}

/**
 * Which meter the hours are counted on, said out loud.
 *
 * §11 requires Hobbs and tach to be distinguished explicitly and §3.4 says
 * neither is derived from the other. Hobbs is what most clubs fly on; an
 * aeroplane with only a tach would otherwise show a silent zero.
 */
function hoursOf(summary: FlightSummaryResponse): { value: string; meter: string } {
  const hobbs = Number(summary.hobbs_hours);
  if (hobbs > 0) return { value: round(summary.hobbs_hours), meter: 'hobbs' };
  const tach = Number(summary.tach_hours);
  if (tach > 0) return { value: round(summary.tach_hours), meter: 'tach' };
  return { value: '0', meter: 'hobbs' };
}

function round(hours: string): string {
  return Number(hours).toFixed(1);
}

/**
 * What this flight cost this pilot.
 *
 * Summed across every line carrying the flight's id rather than the first
 * one found: a wet rate produces a charge *and* a fuel credit, and a
 * correction leaves both halves of a reversal on the statement (§3.7 rule
 * 2). Adding them is the only reading that survives either.
 */
function costOf(statement: StatementResponse, flightId: string): string {
  const lines = statement.lines.filter((line) => line.flight_id === flightId);
  if (lines.length === 0) return 'Not charged';
  const cents = lines.reduce((total, line) => total + line.amount_cents, 0);
  return formatMoney(cents, statement.currency);
}

function when(instant: string): string {
  return new Date(instant).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
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

const styles = StyleSheet.create({
  container: { padding: space.base, gap: space.md },
  greeting: { gap: space.xs },
  hello: { ...type.pageTitle },
  club: { ...type.body, color: color.secondary },
  balanceRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  balanceLabel: { ...type.supporting, color: color.secondary, flex: 1 },
  balance: { ...type.metric, marginTop: space.xs },
  boxes: { flexDirection: 'row', gap: space.sm },
  box: {
    flex: 1,
    minHeight: 96,
    justifyContent: 'center',
    paddingVertical: space.base,
    paddingHorizontal: space.md,
    borderWidth: 1,
    borderColor: color.line,
    borderRadius: 12,
    backgroundColor: color.surface,
  },
  boxPressed: { backgroundColor: color.subtle },
  boxValue: { ...type.metric },
  boxUnit: { ...type.supporting, color: color.secondary },
  boxLabel: { ...type.supporting, color: color.secondary, marginTop: space.xs },
  section: { gap: space.sm, marginTop: space.sm },
  flightRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  route: { ...type.cardHeading, flex: 1 },
  flightMeta: { ...type.supporting, color: color.secondary, marginTop: space.xs },
  cost: { ...type.bodySmall, marginTop: space.xs },
});
