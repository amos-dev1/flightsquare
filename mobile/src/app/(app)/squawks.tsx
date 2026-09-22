import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { SquawkResponse } from '@flightsquare/shared';

import { Body, Button, Card, Notice, SectionHeading, Status } from '@/components/ui';
import { api, withAuth } from '@/lib/api';
import { color, space, type } from '@/theme';

/**
 * What is wrong with the fleet.
 *
 * Reading was the half that did not exist: a pilot could file a defect from
 * the phone and never see one, which makes the walk-around check — "has
 * anybody else found this?" — impossible in the place it is actually done.
 *
 * Grounding first, then everything else, because the ordering is the answer
 * to the question the screen gets opened with. Closing one is not here at
 * all: §1.5 puts every status change behind `maintenance: write`, which a
 * Pilot does not hold, and offering a button the server would refuse is
 * worse than not offering it.
 */
export default function Squawks() {
  const [squawks, setSquawks] = useState<SquawkResponse[] | null>(null);
  const [offline, setOffline] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setSquawks(await withAuth(() => api.listSquawks()));
      setOffline(false);
    } catch {
      // Same as the fleet screen: whatever was loaded last stays up. An
      // empty defect list is a dangerous thing to show by accident.
      setOffline(true);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const open = squawks?.filter((squawk) => squawk.status !== 'resolved') ?? [];
  // Grounding first, then most recently reported. §3.6's severity order is
  // advisory; what stops an aeroplane flying is the boolean.
  const sorted = [...open].sort((a, b) => {
    if (a.grounding !== b.grounding) return a.grounding ? -1 : 1;
    return b.reported_at.localeCompare(a.reported_at);
  });

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
      {offline ? <Notice>Offline. Showing the defects loaded last.</Notice> : null}

      {squawks !== null && sorted.length === 0 ? (
        <View style={styles.empty}>
          <SectionHeading>Nothing outstanding</SectionHeading>
          <Body muted>
            {/*
              §11: never infer airworthiness from the absence of a warning.
              This says what the list contains, not what the aeroplane is.
            */}
            No open defects have been reported. That is not the same as an
            aircraft being airworthy — the Fleet tab has the dispatch answer.
          </Body>
        </View>
      ) : null}

      {sorted.map((squawk) => (
        <Card key={squawk.id}>
          <View style={styles.headline}>
            <Text style={styles.registration}>{squawk.aircraft_registration}</Text>
            {squawk.grounding ? <Status label="Grounding" emphatic /> : null}
            {squawk.status === 'deferred' ? <Status label="Deferred" /> : null}
          </View>

          <Text style={styles.summary}>{squawk.summary}</Text>
          {squawk.details ? <Body muted>{squawk.details}</Body> : null}

          <Text style={styles.meta}>
            {squawk.reported_by_email ?? 'a member'} · {squawk.reported_at.slice(0, 10)}
          </Text>

          {squawk.deferrals.length > 0 ? (
            <Text style={styles.meta}>
              {/* A deferral lifts the grounding and leaves the defect open,
                  so saying which basis it was deferred under is the whole
                  content of the line. */}
              Deferred under {squawk.deferrals[0]!.basis}
              {squawk.deferrals[0]!.expires_on
                ? ` until ${squawk.deferrals[0]!.expires_on}`
                : ''}
            </Text>
          ) : null}
        </Card>
      ))}

      <View style={styles.action}>
        <Button
          label="Report a defect"
          onPress={() => router.push('/(app)/report-squawk')}
        />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: space.base, gap: space.md },
  empty: { gap: space.sm, paddingVertical: space.lg },
  headline: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  registration: { ...type.cardHeading, flex: 1 },
  summary: { ...type.body, marginTop: space.xs },
  meta: { ...type.supporting, color: color.secondary, marginTop: space.xs },
  action: { marginTop: space.sm },
});
