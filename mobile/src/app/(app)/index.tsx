import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { AircraftAvailabilityResponse, AircraftResponse } from '@flightsquare/shared';

import { Body, Button, Card, Meter, Notice, SectionHeading, Status } from '@/components/ui';
import { api, withAuth } from '@/lib/api';
import { pendingCount, sync } from '@/lib/sync';
import { color, space, type } from '@/theme';

export default function Fleet() {
  const [fleet, setFleet] = useState<AircraftResponse[] | null>(null);
  const [availability, setAvailability] = useState<AircraftAvailabilityResponse[]>([]);
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
      const [aircraft, dispatch] = await Promise.all([
        withAuth(() => api.listAircraft()),
        withAuth(() => api.availability()),
      ]);
      setFleet(aircraft);
      setAvailability(dispatch);
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
          {queue.pending} {queue.pending === 1 ? 'entry' : 'entries'} waiting to sync.
        </Notice>
      ) : null}

      {queue.failed > 0 ? (
        <Notice tone="error">
          {queue.failed} {queue.failed === 1 ? 'entry' : 'entries'} could not be saved. Open
          them on the web to fix the details.
        </Notice>
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
            </View>

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

const styles = StyleSheet.create({
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
