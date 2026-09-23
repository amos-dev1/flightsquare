import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ApiError, type FlightResponse, type StatementResponse } from '@flightsquare/shared';

import { Body, Card, Notice, SectionHeading } from '@/components/ui';
import { api, withAuth } from '@/lib/api';
import { formatMoney, routeOf } from '@/lib/format';
import { color, space, type } from '@/theme';

/**
 * One flight, read-only.
 *
 * Reached from the dashboard and the Logs list, and read-only on purpose:
 * §3.4 makes meter readings append-only, so a correction is a new row that
 * supersedes this one rather than an edit to it. There is no PATCH behind
 * this screen and there should not be one.
 *
 * Both meters in full — start, end and the hours between — because §3.4 says
 * they are recorded as read and neither is derived from the other, and §11
 * asks for Hobbs and tach to be told apart explicitly wherever they could be
 * confused. A flight with only one meter shows only that one; a dash where a
 * reading belongs would claim the panel said something it did not.
 */
export default function Flight() {
  const { id } = useLocalSearchParams<{ id: string }>();

  const [flight, setFlight] = useState<FlightResponse | null>(null);
  const [statement, setStatement] = useState<StatementResponse | null>(null);
  const [missing, setMissing] = useState(false);
  const [offline, setOffline] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const found = await withAuth(() => api.getFlight(id));
      setFlight(found);
      setMissing(false);
      setOffline(false);
    } catch (error) {
      // A 404 and no signal are different answers and get different words.
      // §6 does not distinguish a flight in another tenant from one that
      // never existed, and neither does this.
      if (error instanceof ApiError && error.status === 404) setMissing(true);
      else setOffline(true);
    }

    // Pro and up. On Free `/statement` answers 404 (§1.6) and the cost line
    // is simply absent — never a price, never a prompt (§8.3).
    try {
      setStatement(await withAuth(() => api.statement()));
    } catch {
      setStatement(null);
    }
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  if (missing) {
    return (
      <View style={styles.empty}>
        <SectionHeading>Flight not found</SectionHeading>
        <Body muted>It may have been recorded against another account.</Body>
      </View>
    );
  }

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
      {offline && !flight ? <Notice>Offline. This flight could not be loaded.</Notice> : null}
      {offline && flight ? <Notice>Offline. Showing what loaded last.</Notice> : null}

      {flight ? (
        <>
          <View style={styles.header}>
            <Text style={styles.route}>{routeOf(flight)}</Text>
            <Text style={styles.subtitle}>
              <Text style={styles.registration}>{flight.aircraft_registration}</Text>
              {` · ${flight.flight_date}`}
            </Text>
          </View>

          {flight.needs_review && flight.review_reason ? (
            /*
             * §8.2: a Hobbs start that does not match the last reading is a
             * flag for the admin, never a rejection — the gap is usually a
             * maintenance run or a flight nobody logged, and it is real
             * information either way.
             */
            <Notice>{flight.review_reason}</Notice>
          ) : null}

          <Card>
            <SectionHeading>Meters</SectionHeading>
            <Body muted>Recorded as read. Neither is worked out from the other.</Body>
            <View style={styles.meters}>
              <MeterRow
                name="Hobbs"
                start={flight.hobbs_start}
                end={flight.hobbs_end}
                hours={flight.hobbs_hours}
              />
              <MeterRow
                name="Tach"
                start={flight.tach_start}
                end={flight.tach_end}
                hours={flight.tach_hours}
              />
            </View>
          </Card>

          {flight.fuel_remaining_after || flight.fuel_added_qty ? (
            <Card>
              <SectionHeading>Fuel</SectionHeading>
              {/*
                §3.4 keeps these two apart and so does this card: what is in
                the tanks is aircraft state for the next pilot, and what was
                bought is a transaction that may reach the ledger.
              */}
              {flight.fuel_remaining_after ? (
                <Line
                  label="Remaining at shutdown"
                  value={`${flight.fuel_remaining_after} gal`}
                />
              ) : null}
              {flight.fuel_added_qty ? (
                <Line label="Added" value={`${flight.fuel_added_qty} gal`} />
              ) : null}
              {flight.fuel_added_cost_cents !== null ? (
                <Line
                  label="Cost"
                  value={formatMoney(flight.fuel_added_cost_cents, flight.currency ?? 'USD')}
                />
              ) : null}
            </Card>
          ) : null}

          <Card>
            <SectionHeading>Flight</SectionHeading>
            <Line label="Departed" value={flight.departed_from ?? 'Not recorded'} />
            <Line label="Arrived" value={flight.arrived_at ?? 'Not recorded'} />
            {/* The projection carries the address and no name, which is
                enough to say who had the aeroplane (§3.4: `flown_by` is the
                accountability record, not the seed of an experience log). */}
            <Line label="Flown by" value={flight.flown_by_email ?? 'Unknown pilot'} />
            {statement ? <Line label="Charged" value={costOf(statement, flight.id)} /> : null}
            {/* §8.2: when it happened and when the server heard differ,
                sometimes by days, and only the second is ever surprising. */}
            <Line label="Recorded" value={recorded(flight.recorded_at)} />
          </Card>

          {flight.remarks ? (
            <Card>
              <SectionHeading>Remarks</SectionHeading>
              <Body>{flight.remarks}</Body>
            </Card>
          ) : null}
        </>
      ) : null}
    </ScrollView>
  );
}

/**
 * One meter's three numbers.
 *
 * Absent when the aeroplane does not have it: §11 asks that nothing claim a
 * reading that was never taken, and an aircraft with a tach and no Hobbs is
 * ordinary rather than incomplete.
 */
function MeterRow({
  name,
  start,
  end,
  hours,
}: {
  name: string;
  start: string | null;
  end: string | null;
  hours: string | null;
}) {
  if (!start && !end && !hours) {
    return (
      <View style={styles.meter}>
        <Text style={styles.meterName}>{name}</Text>
        <Text style={styles.meterAbsent}>Not fitted, or not read</Text>
      </View>
    );
  }

  return (
    <View style={styles.meter}>
      <Text style={styles.meterName}>{name}</Text>
      <View style={styles.meterNumbers}>
        <Reading label="Out" value={start} />
        <Reading label="In" value={end} />
        <Reading label="Hours" value={hours} emphatic />
      </View>
    </View>
  );
}

function Reading({
  label,
  value,
  emphatic,
}: {
  label: string;
  value: string | null;
  emphatic?: boolean;
}) {
  return (
    <View style={styles.reading}>
      <Text style={styles.readingLabel}>{label}</Text>
      <Text style={[styles.readingValue, emphatic && styles.readingEmphatic]}>
        {value ?? '—'}
      </Text>
    </View>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.line}>
      <Text style={styles.lineLabel}>{label}</Text>
      <Text style={styles.lineValue}>{value}</Text>
    </View>
  );
}

/**
 * What this flight cost this pilot.
 *
 * Summed across every line carrying the flight's id: a wet rate produces a
 * charge *and* a fuel credit, and a correction leaves both halves of a
 * reversal on the statement (§3.7 rule 2). Adding them is the only reading
 * that survives either.
 */
function costOf(statement: StatementResponse, flightId: string): string {
  const lines = statement.lines.filter((line) => line.flight_id === flightId);
  if (lines.length === 0) return 'Not charged';
  const cents = lines.reduce((total, line) => total + line.amount_cents, 0);
  return formatMoney(cents, statement.currency);
}

function recorded(instant: string): string {
  return new Date(instant).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

const styles = StyleSheet.create({
  container: { padding: space.base, gap: space.md },
  empty: { padding: space.base, gap: space.sm },
  header: { gap: space.xs },
  route: { ...type.pageTitle },
  subtitle: { ...type.body, color: color.secondary },
  // §11: uppercase is for registrations and aviation abbreviations.
  registration: { textTransform: 'uppercase' },

  meters: { gap: space.base, marginTop: space.base },
  meter: { gap: space.sm },
  meterName: { ...type.label },
  meterAbsent: { ...type.bodySmall, color: color.secondary },
  meterNumbers: { flexDirection: 'row', gap: space.xl },
  reading: { gap: space.xs },
  readingLabel: { ...type.supporting, color: color.secondary },
  // Tabular, so 1202.9 and 1200.4 line up by digit rather than by shape.
  readingValue: { ...type.body, fontVariant: ['tabular-nums'] },
  readingEmphatic: { ...type.cardHeading, fontVariant: ['tabular-nums'] },

  line: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: space.md,
    marginTop: space.md,
  },
  lineLabel: { ...type.supporting, color: color.secondary, flex: 1 },
  lineValue: { ...type.bodySmall, flexShrink: 1, textAlign: 'right' },
});
