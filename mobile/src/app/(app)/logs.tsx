import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import type {
  AircraftResponse,
  FlightResponse,
  FlightSummaryResponse,
} from '@flightsquare/shared';

import { Body, Card, Choice, Notice, SectionHeading } from '@/components/ui';
import { api, withAuth } from '@/lib/api';
import { routeOf } from '@/lib/format';
import { usePermission } from '@/lib/entitlements';
import { color, space, type } from '@/theme';

/**
 * Flight logs, by aeroplane.
 *
 * An admin sees everyone's flights on the aircraft; anybody else sees their
 * own. **That is presentation, not a control.** §4.4 gives every member
 * `flights` at scope `all` deliberately — who flew what is how a club
 * reconciles its meters and its money — so the whole list is still reachable
 * through the API. Nothing here should be read as a restriction; making it
 * one is a change to the permission model.
 *
 * The statistics come from the server (§8.2). Adding up the rows on the
 * device would be wrong past 200 flights, which is where the list caps, and
 * wrong in the direction nobody notices.
 */
export default function Logs() {
  const [fleet, setFleet] = useState<AircraftResponse[] | null>(null);
  const [aircraftId, setAircraftId] = useState<string | null>(null);
  const [flights, setFlights] = useState<FlightResponse[]>([]);
  const [summary, setSummary] = useState<FlightSummaryResponse | null>(null);
  const [offline, setOffline] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // The same test scheduling already calls `administers`.
  const administers = usePermission('aircraft') === 'write';

  const load = useCallback(
    async (selected: string | null) => {
      try {
        const aircraft = await withAuth(() => api.listAircraft());
        setFleet(aircraft);

        const chosen = selected ?? aircraft.find((a) => a.status === 'active')?.id ?? null;
        setAircraftId(chosen);

        const query = {
          ...(chosen ? { aircraftId: chosen } : {}),
          ...(administers ? {} : { mine: true }),
        };

        const [rows, totals] = await Promise.all([
          withAuth(() => api.listFlights(query)),
          withAuth(() => api.flightSummary(query)),
        ]);

        setFlights(rows);
        setSummary(totals);
        setOffline(false);
      } catch {
        setOffline(true);
      }
    },
    [administers],
  );

  useFocusEffect(
    useCallback(() => {
      void load(aircraftId);
    }, [load, aircraftId]),
  );

  const active = fleet?.filter((aircraft) => aircraft.status !== 'archived') ?? [];

  return (
    <ScrollView
      contentContainerStyle={styles.container}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true);
            void load(aircraftId).finally(() => setRefreshing(false));
          }}
        />
      }
    >
      {offline ? <Notice>Offline. Showing the logs loaded last.</Notice> : null}

      {active.length > 1 ? (
        <Choice
          options={active.map((aircraft) => ({
            value: aircraft.id,
            label: aircraft.registration,
          }))}
          value={aircraftId ?? active[0]!.id}
          onChange={(id) => {
            setAircraftId(id);
            void load(id);
          }}
        />
      ) : null}

      {summary ? (
        <Card>
          <SectionHeading>
            {administers ? 'Everyone' : 'Your flights'}
            {active.length === 1 && active[0] ? ` · ${active[0].registration}` : ''}
          </SectionHeading>
          <View style={styles.stats}>
            <Stat label="Flights" value={String(summary.flights)} />
            {/* §11 and §3.4: which meter, said out loud, and neither derived
                from the other. */}
            <Stat label="Hobbs" value={round(summary.hobbs_hours)} unit="hrs" />
            <Stat label="Tach" value={round(summary.tach_hours)} unit="hrs" />
          </View>
          {summary.first_flight_date ? (
            <Text style={styles.range}>
              {summary.first_flight_date} to {summary.last_flight_date}
            </Text>
          ) : null}
        </Card>
      ) : null}

      {flights.length === 0 ? (
        <View style={styles.empty}>
          <SectionHeading>Nothing logged</SectionHeading>
          <Body muted>
            {administers
              ? 'No flights have been logged against this aircraft.'
              : 'You have not logged a flight on this aircraft.'}
          </Body>
        </View>
      ) : (
        flights.map((flight) => (
          // The same gesture as the dashboard's widget, on the screen its
          // "View all" leads to — a row that opens there and not here would
          // read as two different kinds of thing.
          <Pressable
            key={flight.id}
            onPress={() => router.push({ pathname: '/flight', params: { id: flight.id } })}
            accessibilityRole="button"
            accessibilityLabel={`Flight on ${flight.flight_date}, ${routeOf(flight)}`}
            style={({ pressed }) => [pressed && styles.pressed]}
          >
            <Card>
              <View style={styles.row}>
                <Text style={styles.route}>{routeOf(flight)}</Text>
                <Text style={styles.date}>{flight.flight_date}</Text>
              </View>
              <Text style={styles.meta}>
                {/* The projection carries the address and no name, which is
                    enough to say who had the aeroplane. */}
                {administers ? `${flight.flown_by_email ?? 'Unknown pilot'} · ` : ''}
                {flight.aircraft_registration}
              </Text>
              <Text style={styles.meters}>
                {flight.hobbs_hours ? `${flight.hobbs_hours} hobbs` : 'no hobbs'}
                {flight.tach_hours ? ` · ${flight.tach_hours} tach` : ''}
              </Text>
              {flight.needs_review && flight.review_reason ? (
                // §8.2: a meter gap is a flag for a person, never a rejection,
                // and it is usually a maintenance run or an unlogged flight.
                <Text style={styles.review}>{flight.review_reason}</Text>
              ) : null}
            </Card>
          </Pressable>
        ))
      )}
    </ScrollView>
  );
}

function Stat({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>
        {value}
        {unit ? <Text style={styles.statUnit}> {unit}</Text> : null}
      </Text>
    </View>
  );
}

function round(hours: string): string {
  return Number(hours).toFixed(1);
}

const styles = StyleSheet.create({
  container: { padding: space.base, gap: space.md },
  stats: { flexDirection: 'row', gap: space.xl, marginTop: space.md },
  stat: { gap: space.xs },
  statLabel: { ...type.supporting, color: color.secondary },
  statValue: { ...type.sectionHeading },
  statUnit: { ...type.supporting, color: color.secondary },
  range: { ...type.supporting, color: color.secondary, marginTop: space.md },
  empty: { gap: space.sm, paddingVertical: space.lg },
  row: { flexDirection: 'row', alignItems: 'baseline', gap: space.sm },
  route: { ...type.cardHeading, flex: 1 },
  date: { ...type.supporting, color: color.secondary },
  meta: { ...type.supporting, color: color.secondary, marginTop: space.xs },
  meters: { ...type.bodySmall, marginTop: space.xs, fontVariant: ['tabular-nums'] },
  pressed: { opacity: 0.7 },
  review: { ...type.supporting, marginTop: space.xs },
});
