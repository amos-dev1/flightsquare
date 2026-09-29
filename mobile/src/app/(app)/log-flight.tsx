import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import type { AircraftResponse, FlightCategory } from '@flightsquare/shared';

import { Body, Button, Card, Choice, Field, Input, Notice, SectionHeading } from '@/components/ui';
import { api, messageFor, withAuth } from '@/lib/api';
import { saveFlight, saveSquawk } from '@/lib/sync';
import { color, radius, space, type } from '@/theme';

/**
 * The post-flight entry.
 *
 * §3.4 calls this the most important screen in the product and says to
 * optimise it over everything else: "if it takes more than a minute, people
 * skip it, the meters go stale, and every number in the app quietly becomes
 * wrong." Everything below is either prefilled from what the aeroplane
 * already knows or is one tap.
 *
 * What it asks for that it did not: where the flight went, what was in the
 * tanks before as well as after, what the fuel cost per gallon, whether
 * anything is wrong with the aeroplane, what the flight was for, and any
 * remarks. Fuel is no longer behind a button — an aeroplane is handed on with
 * a fuel state whether or not somebody bought any, and the next pilot reads
 * that number before they read anything else here.
 *
 * §8.2: nothing is computed here that matters. The hours are a generated
 * column, the fuel total is multiplied on the server, and the meter gap is
 * the server's to flag.
 */
function hoursBetween(start: string, end: string): string | null {
  if (!start || !end) return null;
  const from = Number(start);
  const to = Number(end);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
  return (to - from).toFixed(1);
}

const todayIso = () => new Date().toISOString().slice(0, 10);

const CATEGORIES: { value: FlightCategory; label: string }[] = [
  { value: 'personal', label: 'Personal' },
  { value: 'business', label: 'Business' },
  { value: 'maintenance', label: 'Maintenance' },
];

export default function LogFlight() {
  const { aircraft: aircraftId } = useLocalSearchParams<{ aircraft: string }>();

  const [aircraft, setAircraft] = useState<AircraftResponse | null>(null);
  const [meters, setMeters] = useState({
    hobbs_start: '',
    hobbs_end: '',
    tach_start: '',
    tach_end: '',
  });

  /**
   * Both prefilled from where the aeroplane last arrived, because that is
   * where it is now. The pilot overwrites the leg that was not local, which
   * is one field rather than two.
   *
   * Free text and not capped: 0014 dropped the aerodrome key precisely
   * because "a list that incomplete refuses almost every true answer", and a
   * grass strip with a name rather than an identifier is a true answer.
   * Uppercased, because an identifier is (§11 reserves uppercase for exactly
   * this).
   */
  const [departedFrom, setDepartedFrom] = useState('');
  const [arrivedAt, setArrivedAt] = useState('');

  const [fuelBefore, setFuelBefore] = useState('');
  const [fuelAfter, setFuelAfter] = useState('');
  const [fuelAdded, setFuelAdded] = useState('');
  const [fuelPrice, setFuelPrice] = useState('');

  const [category, setCategory] = useState<FlightCategory>('personal');
  const [remarks, setRemarks] = useState('');

  const [squawking, setSquawking] = useState(false);
  const [squawkSummary, setSquawkSummary] = useState('');
  const [squawkDetails, setSquawkDetails] = useState('');
  const [squawkGrounds, setSquawkGrounds] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Prefill from what the aeroplane is showing. Half the numbers on this
    // form are ones the pilot should not have to read off the panel twice.
    void withAuth(() => api.getAircraft(aircraftId))
      .then((found) => {
        setAircraft(found);
        setMeters((current) => ({
          ...current,
          hobbs_start: current.hobbs_start || (found.hobbs ?? ''),
          tach_start: current.tach_start || (found.tach ?? ''),
        }));
        // Where it last landed is where this flight starts from.
        const here = found.last_location ?? found.home_base;
        if (here) {
          setDepartedFrom((current) => current || here);
          setArrivedAt((current) => current || here);
        }
        // §3.4: fuel is state, latest reading wins. Suggested, not asserted —
        // where the pilot corrects it, the difference is fuel somebody added
        // without logging it, which is information rather than an error.
        if (found.fuel_remaining) {
          setFuelBefore((current) => current || found.fuel_remaining!);
        }
      })
      .catch(() => undefined);
  }, [aircraftId]);

  const hobbsHours = hoursBetween(meters.hobbs_start, meters.hobbs_end);
  const tachHours = hoursBetween(meters.tach_start, meters.tach_end);
  const unit = aircraft?.fuel_units === 'litres' ? 'L' : 'gal';

  // §8.2: a start that does not meet the last reading is flagged for an
  // admin, never rejected. Said plainly rather than looking like an error the
  // pilot has to resolve before saving.
  const hobbsGap =
    aircraft?.hobbs != null &&
    meters.hobbs_start !== '' &&
    Number(meters.hobbs_start) !== Number(aircraft.hobbs);

  async function submit() {
    if (!meters.hobbs_end && !meters.tach_end) {
      setError('Enter the Hobbs or tach reading at shutdown.');
      return;
    }
    if (!fuelAfter.trim()) {
      setError('Enter the fuel remaining at shutdown — the next pilot reads it.');
      return;
    }
    if (squawking && !squawkSummary.trim()) {
      setError('Say what is wrong, or remove the squawk.');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const flightId = await saveFlight({
        aircraft_id: aircraftId,
        flight_date: todayIso(),
        category,
        ...(meters.hobbs_start ? { hobbs_start: meters.hobbs_start } : {}),
        ...(meters.hobbs_end ? { hobbs_end: meters.hobbs_end } : {}),
        ...(meters.tach_start ? { tach_start: meters.tach_start } : {}),
        ...(meters.tach_end ? { tach_end: meters.tach_end } : {}),
        ...(departedFrom.trim() ? { departed_from: departedFrom.trim() } : {}),
        ...(arrivedAt.trim() ? { arrived_at: arrivedAt.trim() } : {}),
        ...(fuelBefore.trim() ? { fuel_remaining_before: fuelBefore.trim() } : {}),
        fuel_remaining_after: fuelAfter.trim(),
        ...(fuelAdded.trim() ? { fuel_added_qty: fuelAdded.trim() } : {}),
        // §3.7 rule 3: integer minor units. The form takes the price on the
        // pump; the server multiplies it by the quantity, because a total is
        // money and §8.2 keeps that off the client.
        ...(fuelPrice.trim()
          ? { fuel_price_cents: Math.round(Number(fuelPrice) * 100) }
          : {}),
        ...(remarks.trim() ? { remarks: remarks.trim() } : {}),
      });

      if (squawking && squawkSummary.trim()) {
        /**
         * Queued separately and named against the flight it was found on.
         *
         * Two writes rather than one because they are two records with
         * different lives — §3.6 makes the squawk log something read back
         * after an accident, and it must not depend on the flight's write
         * succeeding. The id is the device's (§8.2), so the link holds even
         * when neither has reached the server.
         */
        await saveSquawk({
          aircraft_id: aircraftId,
          summary: squawkSummary.trim(),
          ...(squawkDetails.trim() ? { details: squawkDetails.trim() } : {}),
          // The pilot's judgement, not inferred from the words they used.
          ...(squawkGrounds ? { severity: 'grounding' as const, grounding: true } : {}),
          found_on_flight_id: flightId,
        });
      }

      router.back();
    } catch (caught) {
      setError(messageFor(caught));
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

        {/* Meters ------------------------------------------------------ */}
        <Card style={styles.group}>
          {/*
            §11 and §3.4: Hobbs and tach are distinguished explicitly. They
            run at different rates by design, and the difference between them
            is real data about how the aircraft was flown.
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

        {/* Route ------------------------------------------------------- */}
        <Card style={styles.group}>
          <SectionHeading>Route</SectionHeading>
          <View style={styles.pair}>
            <View style={styles.half}>
              <Field label="From">
                <Input
                  value={departedFrom}
                  onChangeText={(text) => setDepartedFrom(text.toUpperCase())}
                  placeholder="KPAO"
                  autoCapitalize="characters"
                  autoCorrect={false}
                  maxLength={16}
                />
              </Field>
            </View>
            <View style={styles.half}>
              <Field label="To">
                <Input
                  value={arrivedAt}
                  onChangeText={(text) => setArrivedAt(text.toUpperCase())}
                  placeholder="KHAF"
                  autoCapitalize="characters"
                  autoCorrect={false}
                  maxLength={16}
                />
              </Field>
            </View>
          </View>
        </Card>

        {/* Fuel -------------------------------------------------------- */}
        <Card style={styles.group}>
          <SectionHeading>Fuel</SectionHeading>
          {/*
            §3.4: two different things, and they must not be one field.
            Remaining is aircraft *state* — the next pilot walks out to it.
            Added is a *transaction*, and on a wet rate it credits the pilot
            back (§3.7).
          */}
          <View style={styles.pair}>
            <View style={styles.half}>
              <Field label="Before" hint={`${unit} at start-up`}>
                <Input
                  value={fuelBefore}
                  onChangeText={setFuelBefore}
                  keyboardType="decimal-pad"
                />
              </Field>
            </View>
            <View style={styles.half}>
              <Field label="After" required hint={`${unit} at shutdown`}>
                <Input
                  value={fuelAfter}
                  onChangeText={setFuelAfter}
                  keyboardType="decimal-pad"
                />
              </Field>
            </View>
          </View>

          <View style={styles.pair}>
            <View style={styles.half}>
              <Field label="Added" hint={unit}>
                <Input
                  value={fuelAdded}
                  onChangeText={setFuelAdded}
                  keyboardType="decimal-pad"
                />
              </Field>
            </View>
            <View style={styles.half}>
              <Field label="Price" hint={`per ${unit}`}>
                <Input
                  value={fuelPrice}
                  onChangeText={setFuelPrice}
                  keyboardType="decimal-pad"
                  placeholder="6.89"
                />
              </Field>
            </View>
          </View>
        </Card>

        {/* What it was for --------------------------------------------- */}
        <Card style={styles.group}>
          <SectionHeading>What this flight was</SectionHeading>
          <Choice options={CATEGORIES} value={category} onChange={setCategory} />
          {category === 'maintenance' ? (
            // Said out loud, because a club might reasonably expect otherwise
            // and §3.7 makes a charge append-only once it exists.
            <Body muted>Recorded on the flight. It does not change what this costs.</Body>
          ) : null}
        </Card>

        {/* Anything wrong ---------------------------------------------- */}
        <Card style={styles.group}>
          <View style={styles.squawkHead}>
            <SectionHeading>Anything wrong?</SectionHeading>
            {!squawking ? (
              <Pressable
                onPress={() => setSquawking(true)}
                accessibilityRole="button"
                accessibilityLabel="Add a squawk"
                hitSlop={space.sm}
                style={({ pressed }) => [styles.add, pressed && styles.pressed]}
              >
                <Feather name="plus" size={16} color={color.navy} />
                <Text style={styles.addLabel}>Add squawk</Text>
              </Pressable>
            ) : null}
          </View>

          {squawking ? (
            <>
              <Field label="What is wrong" required>
                <Input
                  value={squawkSummary}
                  onChangeText={setSquawkSummary}
                  placeholder="Left brake soft"
                  maxLength={200}
                />
              </Field>
              <Field label="Details" hint="What you saw, heard or felt.">
                <Input
                  value={squawkDetails}
                  onChangeText={setSquawkDetails}
                  placeholder="Pedal travels most of the way before it bites."
                  multiline
                  maxLength={4000}
                  style={styles.details}
                />
              </Field>

              {/*
                §3.6: `grounding` is a separate judgement from severity — an
                inspection can ground something reported as minor — and it is
                the boolean §3.3 reads to stop the aeroplane being booked. So
                it is the pilot's call, made explicitly.
              */}
              <Pressable
                onPress={() => setSquawkGrounds((on) => !on)}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: squawkGrounds }}
                style={({ pressed }) => [
                  styles.check,
                  squawkGrounds && styles.checkOn,
                  pressed && styles.pressed,
                ]}
              >
                <View style={[styles.box, squawkGrounds && styles.boxOn]}>
                  {squawkGrounds ? <Feather name="check" size={14} color={color.onDark} /> : null}
                </View>
                <Text style={styles.checkLabel}>This grounds the aircraft</Text>
              </Pressable>

              {squawkGrounds ? (
                <Notice tone="error">
                  This stops the aircraft being booked until somebody with maintenance access
                  resolves or defers it.
                </Notice>
              ) : null}

              <Pressable
                onPress={() => {
                  setSquawking(false);
                  setSquawkSummary('');
                  setSquawkDetails('');
                  setSquawkGrounds(false);
                }}
                accessibilityRole="button"
                hitSlop={space.sm}
                style={({ pressed }) => [styles.remove, pressed && styles.pressed]}
              >
                <Text style={styles.removeLabel}>Remove squawk</Text>
              </Pressable>

              {/* §3.6: the squawk log is read back after an accident, so it is
                  not something anyone edits later. Said before the tap. */}
              <Body muted>What you report stays as written. Anything further is a new squawk.</Body>
            </>
          ) : (
            <Body muted>Nothing to report. Add a squawk if something needs looking at.</Body>
          )}
        </Card>

        {/* Remarks ------------------------------------------------------ */}
        <Card style={styles.group}>
          <Field label="Remarks" hint="Anything worth the next pilot knowing. Optional.">
            <Input
              value={remarks}
              onChangeText={setRemarks}
              placeholder="Landing light intermittent on taxi."
              multiline
              maxLength={2000}
              style={styles.details}
            />
          </Field>
        </Card>

        {error ? <Notice tone="error">{error}</Notice> : null}

        <Button label="Save flight" onPress={() => void submit()} busy={busy} />
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
  flex: { flex: 1, backgroundColor: color.mist },
  container: { padding: space.base, gap: space.base, paddingBottom: space.xxl },
  registration: { ...type.pageTitle, color: color.navy, textTransform: 'uppercase' },
  group: { gap: space.base },
  pair: { flexDirection: 'row', gap: space.md },
  half: { flex: 1 },
  details: { height: 96, paddingTop: space.sm, textAlignVertical: 'top' },
  pressed: { opacity: 0.7 },

  squawkHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  add: { flexDirection: 'row', alignItems: 'center', gap: space.xs, paddingVertical: space.xs },
  addLabel: { ...type.button },
  remove: { alignSelf: 'flex-start', paddingVertical: space.sm },
  removeLabel: { ...type.button, color: color.secondary },

  check: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: 48,
    paddingHorizontal: space.md,
    borderWidth: 1,
    borderColor: color.control,
    borderRadius: radius.control,
  },
  checkOn: { borderColor: color.teal, borderWidth: 2 },
  box: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: color.control,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Fill as well as tick, so the state is never the tick alone (§11 §13).
  boxOn: { backgroundColor: color.navy, borderColor: color.navy },
  checkLabel: { ...type.body, flex: 1 },
});
