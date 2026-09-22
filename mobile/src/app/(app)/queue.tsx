import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { QueuedWrite } from '@flightsquare/shared';

import { Body, Button, Card, Notice, SectionHeading, Status } from '@/components/ui';
import { discard, queued, retry, sync } from '@/lib/sync';
import { color, space, type } from '@/theme';

/**
 * What has not reached the server yet, and what gave up trying.
 *
 * This screen exists because the alternative was a dead end. A write that
 * hits a 4xx is parked as `failed` — correctly, since a 4xx will not become a
 * 2xx by being sent again — and until now that was the end of it: no retry,
 * no way to read the error, no way to remove it. The Fleet screen said "open
 * them on the web to fix the details", and there is no such screen on the
 * web. The row sat in SQLite forever and the flight it held was gone.
 *
 * A flight that cannot be retried is a meter reading nothing else in the
 * system has (§3.4), which is why discarding one asks first.
 */
export default function Queue() {
  const [entries, setEntries] = useState<QueuedWrite[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    setEntries(await queued());
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const pending = entries?.filter((entry) => entry.state === 'pending') ?? [];
  const failed = entries?.filter((entry) => entry.state === 'failed') ?? [];

  return (
    <ScrollView
      contentContainerStyle={styles.container}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true);
            void sync()
              .catch(() => undefined)
              .then(load)
              .finally(() => setRefreshing(false));
          }}
        />
      }
    >
      {note ? <Notice>{note}</Notice> : null}

      {entries !== null && entries.length === 0 ? (
        <View style={styles.empty}>
          <SectionHeading>Everything is saved</SectionHeading>
          <Body muted>Nothing is waiting to reach FlightSquare.</Body>
        </View>
      ) : null}

      {pending.length > 0 ? (
        <>
          <SectionHeading>Waiting</SectionHeading>
          <Body muted>
            These will send the next time this phone has a signal. Nothing
            needs doing.
          </Body>
          {pending.map((entry) => (
            <Card key={entry.id}>
              <Summary entry={entry} />
            </Card>
          ))}
        </>
      ) : null}

      {failed.length > 0 ? (
        <>
          <SectionHeading>Not accepted</SectionHeading>
          <Body muted>
            FlightSquare refused these, so retrying on its own would not help.
            The reason is below each one — usually something the web can fix
            first, like an aircraft that was archived.
          </Body>
          {failed.map((entry) => (
            <Card key={entry.id}>
              <Summary entry={entry} />
              {entry.lastError ? <Text style={styles.error}>{entry.lastError}</Text> : null}

              <View style={styles.actions}>
                <Button
                  label="Try again"
                  variant="secondary"
                  onPress={() => {
                    void retry(entry.id)
                      .then(() => sync().catch(() => undefined))
                      .then(load)
                      .then(() => setNote('Sent again. If it is gone, it went.'));
                  }}
                />
                <Button
                  label="Discard"
                  variant="secondary"
                  onPress={() => {
                    // §11: a destructive action is worded plainly and
                    // confirmed. This one loses a meter reading.
                    Alert.alert(
                      'Discard this entry?',
                      entry.kind === 'flight'
                        ? 'The flight and its meter readings will be gone from this phone, and nothing else has them.'
                        : 'The defect report will be gone from this phone, and nobody will have seen it.',
                      [
                        { text: 'Keep it', style: 'cancel' },
                        {
                          text: 'Discard',
                          style: 'destructive',
                          onPress: () => {
                            void discard(entry.id)
                              .then(load)
                              .then(() => setNote('Discarded.'));
                          },
                        },
                      ],
                    );
                  }}
                />
              </View>
            </Card>
          ))}
        </>
      ) : null}
    </ScrollView>
  );
}

function Summary({ entry }: { entry: QueuedWrite }) {
  return (
    <>
      <View style={styles.headline}>
        <Text style={styles.kind}>
          {entry.kind === 'flight' ? 'Flight' : 'Defect report'}
        </Text>
        {entry.attempts > 0 ? (
          <Status label={`${entry.attempts} ${entry.attempts === 1 ? 'try' : 'tries'}`} />
        ) : null}
      </View>

      <Text style={styles.detail}>
        {entry.kind === 'flight'
          ? describeFlight(entry.payload)
          : entry.payload.summary}
      </Text>
      <Text style={styles.meta}>
        {/* Recorded-at, not queued-at. §8.2: they are frequently different,
            sometimes by days, and the first is the one that happened. */}
        {entry.recordedAt.slice(0, 16).replace('T', ' ')}
      </Text>
    </>
  );
}

function describeFlight(payload: { flight_date: string; hobbs_start?: string; hobbs_end?: string }): string {
  const meters =
    payload.hobbs_start && payload.hobbs_end
      ? ` · hobbs ${payload.hobbs_start} → ${payload.hobbs_end}`
      : '';
  return `${payload.flight_date}${meters}`;
}

const styles = StyleSheet.create({
  container: { padding: space.base, gap: space.md },
  empty: { gap: space.sm, paddingVertical: space.lg },
  headline: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  kind: { ...type.cardHeading, flex: 1 },
  detail: { ...type.body, marginTop: space.xs },
  meta: { ...type.supporting, color: color.secondary, marginTop: space.xs },
  error: { ...type.bodySmall, marginTop: space.sm },
  actions: { flexDirection: 'row', gap: space.sm, marginTop: space.md },
});
