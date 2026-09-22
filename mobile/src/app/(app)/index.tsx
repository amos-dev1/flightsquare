import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import type {
  AircraftAvailabilityResponse,
  AircraftResponse,
  MaintenanceItemResponse,
  SquawkResponse,
} from '@flightsquare/shared';

import { Body, Button, Card, Meter, Notice, SectionHeading, Status } from '@/components/ui';
import { api, withAuth } from '@/lib/api';
import { pendingCount, sync } from '@/lib/sync';
import { color, space, type } from '@/theme';

export default function Fleet() {
  const [fleet, setFleet] = useState<AircraftResponse[] | null>(null);
  const [availability, setAvailability] = useState<AircraftAvailabilityResponse[]>([]);
  const [items, setItems] = useState<MaintenanceItemResponse[]>([]);
  const [squawks, setSquawks] = useState<SquawkResponse[]>([]);
  const [queue, setQueue] = useState({ pending: 0, failed: 0 });
  const [offline, setOffline] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    // Flush first: a flight logged on the ramp should reach the server
    // before the meters are read back, or the list shows stale numbers.
    await sync().catch(() => undefined);
    setQueue(await pendingCount());
    try {
      // §3.3: dispatch state comes from the server's one resolved view, not
      // from anything worked out here. It is the question this screen is
      // opened to answer — whether it is worth driving to the airport.
      const [aircraft, dispatch, maintenance, defects] = await Promise.all([
        withAuth(() => api.listAircraft()),
        withAuth(() => api.availability()),
        // Every tier has maintenance tracking (§4.3), so this does not 404
        // for entitlement reasons — but a tenant override could turn it off,
        // and a fleet list is not worth failing over a count.
        withAuth(() => api.listMaintenanceItems()).catch(() => []),
        withAuth(() => api.listSquawks({ open: true })).catch(() => []),
      ]);
      setFleet(aircraft);
      setAvailability(dispatch);
      setItems(maintenance);
      setSquawks(defects);
      setOffline(false);
    } catch {
      // No signal. Whatever was loaded last stays on screen — this is a
      // field app, and an empty list would be a lie.
      setOffline(true);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const active = fleet?.filter((aircraft) => aircraft.status === 'active') ?? [];

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
      {offline ? <Notice>Offline. Showing the last known readings.</Notice> : null}

      {queue.pending > 0 ? (
        <Notice>
          {queue.pending} {queue.pending === 1 ? 'entry' : 'entries'} waiting to sync. They
          go on their own when there is a signal.
        </Notice>
      ) : null}

      {queue.failed > 0 ? (
        <View style={styles.queueNotice}>
          <Notice tone="error">
            {queue.failed} {queue.failed === 1 ? 'entry' : 'entries'} could not be saved.
          </Notice>
          {/*
            This used to say "open them on the web to fix the details", and
            there was no such screen on the web — so the entry sat in SQLite
            forever and the flight it held was gone. Now it goes somewhere.
          */}
          <Button
            label="See what is stuck"
            variant="secondary"
            onPress={() => router.push('/(app)/queue')}
          />
        </View>
      ) : null}

      {active.map((aircraft) => {
        const dispatch = availability.find((row) => row.aircraft_id === aircraft.id);
        return (
          <Card key={aircraft.id}>
            <View style={styles.row}>
              <View style={styles.identity}>
                {/* §11 reserves uppercase for registrations. */}
                <Text style={styles.registration}>{aircraft.registration}</Text>
                <Text style={styles.subtitle}>
                  {aircraft.type_code ?? 'Unknown type'}
                  {aircraft.home_base ? ` · ${aircraft.home_base}` : ''}
                </Text>
              </View>
              {/*
                Stated, never inferred. §11: do not read "Airworthy" out of the
                absence of a warning — so nothing is shown at all until the
                server has told us, and what it tells us is "available", which
                is a claim about the records rather than about the aeroplane.
              */}
              {dispatch ? (
                <Status
                  label={dispatch.available ? 'Available' : 'Grounded'}
                  emphatic={!dispatch.available}
                />
              ) : null}
            </View>

            {dispatch && !dispatch.available ? (
              <View style={styles.reasons}>
                {dispatch.grounding_reasons.map((reason) => (
                  <Text key={reason} style={styles.reason}>
                    {reason}
                  </Text>
                ))}
              </View>
            ) : null}

            {/* Hobbs and tach named explicitly, never implied by position. */}
            <View style={styles.meters}>
              <View>
                <Text style={styles.meterLabel}>Hobbs</Text>
                <Meter value={aircraft.hobbs} />
              </View>
              <View>
                <Text style={styles.meterLabel}>Tach</Text>
                <Meter value={aircraft.tach} />
              </View>
              <View>
                {/*
                  §3.4: what the last pilot left in the tanks. Aircraft
                  state, latest reading wins, and never arithmetic across
                  flights — pilots estimate, gauges lie, and somebody always
                  tops off without logging it. It tells the next person what
                  they are walking out to, and it grounds nothing.
                */}
                <Text style={styles.meterLabel}>Fuel</Text>
                <Meter value={aircraft.fuel_remaining} unit={aircraft.fuel_units === 'litres' ? 'L' : 'gal'} />
              </View>
            </View>

            {/*
              The two questions a walk-around asks that the dispatch line
              does not answer: what is coming due, and what has somebody
              already found. Both are counts — the detail is one tap away on
              its own tab, and this card is read standing up.
            */}
            <Text style={styles.attention}>
              {maintenanceLine(items, aircraft.id)} · {squawkLine(squawks, aircraft.id)}
            </Text>

            <Button
              label="Log flight"
              onPress={() => router.push(`/(app)/log-flight?aircraft=${aircraft.id}`)}
            />
            <View style={styles.secondary}>
              <Button
                label="Report a defect"
                variant="secondary"
                onPress={() => router.push(`/(app)/report-squawk?aircraft=${aircraft.id}`)}
              />
            </View>
          </Card>
        );
      })}

      {fleet !== null && active.length === 0 ? (
        <View style={styles.empty}>
          <SectionHeading>No aircraft yet</SectionHeading>
          <Body muted>Add one on the web to start tracking hours.</Body>
        </View>
      ) : null}
    </ScrollView>
  );
}

/**
 * What is coming due, in a sentence.
 *
 * "Not recorded" is kept apart from "overdue" on purpose, the way every
 * other screen keeps them apart: an interval seeded with the aeroplane that
 * nobody has confirmed is not overdue, it is unknown, and §11 forbids
 * asserting the stronger thing.
 */
function maintenanceLine(items: MaintenanceItemResponse[], aircraftId: string): string {
  const mine = items.filter((item) => item.aircraft_id === aircraftId);
  const overdue = mine.filter((item) => item.state === 'overdue' && item.ever_complied).length;
  const unrecorded = mine.filter((item) => item.state === 'overdue' && !item.ever_complied).length;
  const soon = mine.filter((item) => item.state === 'due_soon').length;

  const parts: string[] = [];
  if (overdue > 0) parts.push(`${overdue} overdue`);
  if (unrecorded > 0) parts.push(`${unrecorded} not recorded`);
  if (soon > 0) parts.push(`${soon} due soon`);
  return parts.length > 0 ? `Maintenance: ${parts.join(', ')}` : 'Maintenance: nothing due';
}

function squawkLine(squawks: SquawkResponse[], aircraftId: string): string {
  const mine = squawks.filter((squawk) => squawk.aircraft_id === aircraftId);
  if (mine.length === 0) return 'no open squawks';
  const grounding = mine.filter((squawk) => squawk.grounding).length;
  return grounding > 0
    ? `${mine.length} open, ${grounding} grounding`
    : `${mine.length} open`;
}

const styles = StyleSheet.create({
  queueNotice: { gap: space.sm },
  attention: { ...type.supporting, color: color.secondary, marginTop: space.sm },
  container: { padding: space.base, gap: space.base },
  row: { flexDirection: 'row', alignItems: 'center' },
  identity: { flex: 1, gap: space.xs },
  registration: { ...type.cardHeading, color: color.brandBlack },
  subtitle: { ...type.bodySmall, color: color.secondary },
  meters: { flexDirection: 'row', gap: space.xl, marginVertical: space.base },
  meterLabel: { ...type.supporting, color: color.secondary },
  reasons: { gap: space.xs, marginTop: space.md },
  reason: { ...type.bodySmall, color: color.brandBlack },
  secondary: { marginTop: space.sm },
  empty: { gap: space.sm, paddingVertical: space.xl, alignItems: 'center' },
});
