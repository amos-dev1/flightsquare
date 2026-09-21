import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { AircraftResponse } from '@flightsquare/shared';

import { Body, Button, Card, Field, Input, Notice, SectionHeading } from '@/components/ui';
import { api, withAuth } from '@/lib/api';
import { saveFlight } from '@/lib/sync';
import { color, space, type } from '@/theme';

/**
 * Display only. §8.2: the client never computes anything that matters — the
 * stored hours are a generated column on the server, and nothing here is
 * ever sent.
 */
function hoursBetween(start: string, end: string): string | null {
  if (!start || !end) return null;
  const from = Number(start);
  const to = Number(end);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
  return (to - from).toFixed(1);
}

const todayIso = () => new Date().toISOString().slice(0, 10);

export default function LogFlight() {
  const { aircraft: aircraftId } = useLocalSearchParams<{ aircraft: string }>();

  const [aircraft, setAircraft] = useState<AircraftResponse | null>(null);
  const [meters, setMeters] = useState({
    hobbs_start: '',
    hobbs_end: '',
    tach_start: '',
    tach_end: '',
  });
  const [fuelRemaining, setFuelRemaining] = useState('');
  const [fuelAdded, setFuelAdded] = useState('');
  const [fuelCost, setFuelCost] = useState('');
  const [showFuel, setShowFuel] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Prefill the "out" readings from what the aircraft is showing. Half the
    // numbers on this form are ones the pilot should not have to read off the
    // panel twice (§3.4: if it takes more than a minute, it does not happen).
    //
    // If there is no signal the fields simply start empty — the form still
    // works, which is the whole point of it being offline-first.
    void withAuth(() => api.getAircraft(aircraftId))
      .then((found) => {
        setAircraft(found);
        setMeters((current) => ({
          ...current,
          hobbs_start: current.hobbs_start || (found.hobbs ?? ''),
          tach_start: current.tach_start || (found.tach ?? ''),
        }));
      })
      .catch(() => undefined);
  }, [aircraftId]);

  const hobbsHours = hoursBetween(meters.hobbs_start, meters.hobbs_end);
  const tachHours = hoursBetween(meters.tach_start, meters.tach_end);

  // §8.2: a start that does not meet the last reading is flagged for an
  // admin, never rejected. Say so plainly rather than letting it look like an
  // error the pilot has to resolve before saving.
  const hobbsGap =
    aircraft?.hobbs != null &&
    meters.hobbs_start !== '' &&
    Number(meters.hobbs_start) !== Number(aircraft.hobbs);

  async function submit() {
    if (!meters.hobbs_end && !meters.tach_end) {
      setError('Enter the Hobbs or tach reading at shutdown.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await saveFlight({
        aircraft_id: aircraftId,
        flight_date: todayIso(),
        ...(meters.hobbs_start ? { hobbs_start: meters.hobbs_start } : {}),
        ...(meters.hobbs_end ? { hobbs_end: meters.hobbs_end } : {}),
        ...(meters.tach_start ? { tach_start: meters.tach_start } : {}),
        ...(meters.tach_end ? { tach_end: meters.tach_end } : {}),
        ...(fuelRemaining ? { fuel_remaining_after: fuelRemaining } : {}),
        ...(fuelAdded ? { fuel_added_qty: fuelAdded } : {}),
        // §3.7 rule 3: money is integer minor units. The form takes the
        // amount on the receipt; the conversion happens once, here.
        ...(fuelCost ? { fuel_added_cost_cents: Math.round(Number(fuelCost) * 100) } : {}),
      });
      router.back();
    } catch {
      setError('Could not save. Try again.');
    } finally {
      setBusy(false);
    }
  }

  const set = (key: keyof typeof meters) => (value: string) =>
    setMeters((current) => ({ ...current, [key]: value }));

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        {aircraft ? <Text style={styles.registration}>{aircraft.registration}</Text> : null}

        <Card style={styles.group}>
          {/*
            §11: Hobbs and tach are distinguished explicitly. They run at
            different rates by design, and the difference between them is real
            data about how the aircraft was flown.
          */}
          <SectionHeading>Hobbs</SectionHeading>
          <View style={styles.pair}>
            <View style={styles.half}>
              <Field label="Out">
                <Input
                  value={meters.hobbs_start}
                  onChangeText={set('hobbs_start')}
                  keyboardType="decimal-pad"
                />
              </Field>
            </View>
            <View style={styles.half}>
              <Field label="In">
                <Input
                  value={meters.hobbs_end}
                  onChangeText={set('hobbs_end')}
                  keyboardType="decimal-pad"
                  autoFocus
                />
              </Field>
            </View>
          </View>
          {hobbsHours ? <Body muted>{hobbsHours} Hobbs hours</Body> : null}

          <SectionHeading>Tach</SectionHeading>
          <View style={styles.pair}>
            <View style={styles.half}>
              <Field label="Out">
                <Input
                  value={meters.tach_start}
                  onChangeText={set('tach_start')}
                  keyboardType="decimal-pad"
                />
              </Field>
            </View>
            <View style={styles.half}>
              <Field label="In">
                <Input
                  value={meters.tach_end}
                  onChangeText={set('tach_end')}
                  keyboardType="decimal-pad"
                />
              </Field>
            </View>
          </View>
          {tachHours ? <Body muted>{tachHours} tach hours</Body> : null}

          {hobbsGap ? (
            <Notice>
              This does not match the last recorded Hobbs of {aircraft?.hobbs}. Save it anyway —
              the flight will be flagged for review.
            </Notice>
          ) : null}
        </Card>

        {/* Fuel behind one tap: most flights buy none. */}
        <Card style={styles.group}>
          {showFuel ? (
            <>
              <SectionHeading>Fuel</SectionHeading>
              <Field label="Remaining at shutdown" hint="What the next pilot walks out to.">
                <Input
                  value={fuelRemaining}
                  onChangeText={setFuelRemaining}
                  keyboardType="decimal-pad"
                />
              </Field>
              <View style={styles.pair}>
                <View style={styles.half}>
                  <Field label="Added" hint="Gallons">
                    <Input
                      value={fuelAdded}
                      onChangeText={setFuelAdded}
                      keyboardType="decimal-pad"
                    />
                  </Field>
                </View>
                <View style={styles.half}>
                  <Field label="Cost" hint="USD">
                    <Input value={fuelCost} onChangeText={setFuelCost} keyboardType="decimal-pad" />
                  </Field>
                </View>
              </View>
            </>
          ) : (
            <Button label="Add fuel" variant="secondary" onPress={() => setShowFuel(true)} />
          )}
        </Card>

        {error ? <Notice tone="error">{error}</Notice> : null}

        <Button label="Save flight" onPress={submit} busy={busy} />
        {/*
          Saying so plainly matters: §8.2 makes this work with no signal, and
          a pilot who does not believe it was saved will type it again later.
        */}
        <Body muted>Saved on this phone straight away, and synced when you have signal.</Body>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: color.surface },
  container: { padding: space.base, gap: space.base },
  registration: { ...type.pageTitle, color: color.brandBlack },
  group: { gap: space.md },
  pair: { flexDirection: 'row', gap: space.md },
  half: { flex: 1 },
});
