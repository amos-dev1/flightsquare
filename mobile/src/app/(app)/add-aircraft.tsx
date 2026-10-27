import { router } from 'expo-router';
import { useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';
import type {
  BillingMeter,
  CreateAircraftRequest,
  FuelUnits,
  MaintenanceMeter,
  RateBasis,
  RegistrationLookupResponse,
} from '@flightsquare/shared';

import { Body, Button, Card, Choice, Field, Input, Notice, SectionHeading } from '@/components/ui';
import { api, messageFor, withAuth } from '@/lib/api';
import { useEntitlements } from '@/lib/entitlements';
import { space } from '@/theme';

/**
 * Adding an aeroplane — the same questions the web's form asks, in the same
 * order, so an aircraft added at the hangar on a phone starts as complete as
 * one added at a desk.
 *
 * Registration is the only thing the API insists on; everything else is
 * optional and can be changed later in Aircraft settings.
 *
 * **The gates are the server's, and this screen does not duplicate them.**
 * §1.6 orders them feature, permission, quota; the entitlement fetch decides
 * whether the button that reaches this screen exists at all (§8.1: the client
 * hiding a button is cosmetics), and `assert_quota` decides whether the write
 * lands. A 402 arriving here is shown in the server's own words.
 *
 * §8.3: it says what the limit is and stops. No price, no link, nothing that
 * reads as a route to a purchase — that is what keeps this app inside Apple's
 * 3.1.3(f).
 */

const MAINTENANCE_METERS: { value: MaintenanceMeter; label: string }[] = [
  { value: 'tach', label: 'Tach' },
  { value: 'hobbs', label: 'Hobbs' },
  { value: 'airframe', label: 'Airframe' },
];
const BILLING_METERS: { value: BillingMeter; label: string }[] = [
  { value: 'hobbs', label: 'Hobbs' },
  { value: 'tach', label: 'Tach' },
];
const RATE_BASES: { value: RateBasis; label: string }[] = [
  { value: 'dry', label: 'Dry' },
  { value: 'wet', label: 'Wet' },
];
const FUEL_UNITS: { value: FuelUnits; label: string }[] = [
  { value: 'gallons', label: 'Gallons' },
  { value: 'litres', label: 'Litres' },
];

/** What a meter column holds: whole hours and one decimal place. */
const DECIMAL = /^[0-9]{1,7}(\.[0-9])?$/;

export default function AddAircraft() {
  const { refresh } = useEntitlements();

  const [registration, setRegistration] = useState('');
  const [typeCode, setTypeCode] = useState('');
  const [homeBase, setHomeBase] = useState('');
  const [serial, setSerial] = useState('');
  const [year, setYear] = useState('');
  const [seats, setSeats] = useState('');

  const [maintenanceMeter, setMaintenanceMeter] = useState<MaintenanceMeter>('tach');
  const [billingMeter, setBillingMeter] = useState<BillingMeter>('hobbs');
  const [rate, setRate] = useState('');
  const [rateBasis, setRateBasis] = useState<RateBasis>('dry');
  const [fuelCapacity, setFuelCapacity] = useState('');
  const [fuelUnits, setFuelUnits] = useState<FuelUnits>('gallons');

  const [hobbs, setHobbs] = useState('');
  const [tach, setTach] = useState('');
  const [airframe, setAirframe] = useState('');

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /*
    The FAA registry (0045), asked when the registration loses focus. It
    fills only the boxes still empty and says where the values came from, so
    they are checked rather than trusted. No signal, a foreign tail or an
    unknown one: nothing is suggested and the form is as it was.
  */
  const [found, setFound] = useState<RegistrationLookupResponse | null>(null);
  const lastLooked = useRef('');

  async function lookUp() {
    const tail = registration.trim().toUpperCase();
    if (tail.length < 2 || tail === lastLooked.current) return;
    lastLooked.current = tail;
    let result: RegistrationLookupResponse | null = null;
    try {
      result = await withAuth(() => api.registration(tail));
    } catch {
      result = null;
    }
    setFound(result);
    if (!result) return;
    const fill = (current: string, set: (value: string) => void, value: string | number | null) => {
      if (current.trim() === '' && value !== null) set(String(value));
    };
    fill(typeCode, setTypeCode, result.type_code);
    fill(serial, setSerial, result.serial_number);
    fill(year, setYear, result.year_manufactured);
    fill(seats, setSeats, result.seats);
  }

  /** The request, or the sentence that says what is wrong with the form. */
  function build(): CreateAircraftRequest | string {
    const tail = registration.trim().toUpperCase();
    if (!tail) return 'Enter the registration.';

    const body: CreateAircraftRequest = {
      registration: tail,
      maintenance_meter: maintenanceMeter,
      billing_meter: billingMeter,
      rate_basis: rateBasis,
      fuel_units: fuelUnits,
    };
    if (typeCode.trim()) body.type_code = typeCode.trim().toUpperCase();
    if (homeBase.trim()) body.home_base = homeBase.trim().toUpperCase();
    if (serial.trim()) body.serial_number = serial.trim();

    if (year.trim()) {
      const value = Number(year.trim());
      if (!Number.isInteger(value) || value < 1900 || value > 2100) {
        return 'Enter the year as four digits, for example 1978.';
      }
      body.year_manufactured = value;
    }
    if (seats.trim()) {
      const value = Number(seats.trim());
      if (!Number.isInteger(value) || value < 1 || value > 50) {
        return 'Enter the number of seats, from 1 to 50.';
      }
      body.seats = value;
    }

    if (rate.trim()) {
      // §3.7 rule 3: money is integer minor units. Typed as the club quotes
      // it, converted once, here.
      const perHour = Number(rate.trim());
      if (!Number.isFinite(perHour) || perHour < 0) {
        return 'Enter the hourly rate as an amount, for example 165.00.';
      }
      body.default_rate_cents = Math.round(perHour * 100);
    }
    if (fuelCapacity.trim()) {
      if (!DECIMAL.test(fuelCapacity.trim())) return 'Enter the fuel capacity as a number, for example 53.0.';
      body.fuel_capacity = fuelCapacity.trim();
    }

    // §3.4: even the opening numbers are written as a reading, so the totals
    // stay derived from the log rather than set behind it. Strings the whole
    // way, because a float round-trip is how a countdown drifts.
    for (const [value, key, name] of [
      [hobbs, 'hobbs', 'Hobbs'],
      [tach, 'tach', 'tach'],
      [airframe, 'airframe_hours', 'airframe hours'],
    ] as const) {
      if (!value.trim()) continue;
      if (!DECIMAL.test(value.trim())) return `Enter the ${name} as read, for example 1202.9.`;
      body[key] = value.trim();
    }
    return body;
  }

  async function submit() {
    const body = build();
    if (typeof body === 'string') {
      setError(body);
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await withAuth(() => api.createAircraft(body));
      // The count in the header and the fleet list both read this.
      await refresh();
      router.back();
    } catch (caught) {
      // The server's own words: a registration already in use, a type
      // designator it does not know, or the plan limit (§1.6's 402).
      setError(messageFor(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <Card style={styles.group}>
          <SectionHeading>The aircraft</SectionHeading>
          <Field
            label="Registration"
            required
            hint="The tail number, as painted. A US one fills in what the FAA registry knows."
          >
            <Input
              value={registration}
              onChangeText={setRegistration}
              onBlur={() => void lookUp()}
              placeholder="N7642G"
              autoCapitalize="characters"
              autoCorrect={false}
              maxLength={16}
              autoFocus
            />
          </Field>
          {found ? (
            <Body muted>
              From the FAA registry:{' '}
              {[found.manufacturer, found.model].filter(Boolean).join(' ') || 'type not recorded'}
              {found.year_manufactured ? `, ${found.year_manufactured}` : ''}
              {found.serial_number ? `, serial ${found.serial_number}` : ''}. Filled in where
              blank — check them against the aircraft’s papers.
              {found.type_code ? '' : ' That model has no match in our type list, so enter the type yourself.'}
            </Body>
          ) : null}

          <Field label="Type" hint="The ICAO designator — C172, SR22, P28A.">
            <Input
              value={typeCode}
              onChangeText={setTypeCode}
              placeholder="C172"
              autoCapitalize="characters"
              autoCorrect={false}
              maxLength={16}
            />
          </Field>

          <Field label="Home base" hint="Identifier, or the name of the field.">
            <Input
              value={homeBase}
              onChangeText={setHomeBase}
              placeholder="KPAO"
              autoCapitalize="characters"
              autoCorrect={false}
              maxLength={16}
            />
          </Field>

          <Field label="Serial number">
            <Input value={serial} onChangeText={setSerial} autoCorrect={false} maxLength={64} />
          </Field>

          <View style={styles.row}>
            <View style={styles.half}>
              <Field label="Year">
                <Input value={year} onChangeText={setYear} keyboardType="number-pad" maxLength={4} />
              </Field>
            </View>
            <View style={styles.half}>
              <Field label="Seats">
                <Input value={seats} onChangeText={setSeats} keyboardType="number-pad" maxLength={2} />
              </Field>
            </View>
          </View>
        </Card>

        {/*
          §3.7: which meter maintenance counts on and which one the money
          counts on are two questions, and frequently two answers — Hobbs for
          billing and tach for engine intervals is the common pairing.
        */}
        <Card style={styles.group}>
          <SectionHeading>Meters, rate and fuel</SectionHeading>
          <Field label="Maintenance meter" hint="What inspection intervals count against. Usually tach.">
            <Choice options={MAINTENANCE_METERS} value={maintenanceMeter} onChange={setMaintenanceMeter} />
          </Field>
          <Field label="Billing meter" hint="What flights are charged on. Usually Hobbs.">
            <Choice options={BILLING_METERS} value={billingMeter} onChange={setBillingMeter} />
          </Field>

          <Field label="Hourly rate (USD)" hint="What a member pays per hour. You can leave this until later.">
            <Input
              value={rate}
              onChangeText={setRate}
              keyboardType="decimal-pad"
              placeholder="165.00"
              style={styles.tabular}
            />
          </Field>
          <Field
            label="Rate includes fuel"
            hint="Wet: fuel a pilot buys is credited back to them. Dry: it is their own cost."
          >
            <Choice options={RATE_BASES} value={rateBasis} onChange={setRateBasis} />
          </Field>

          <View style={styles.row}>
            <View style={styles.half}>
              <Field label="Fuel capacity" hint="Usable, for the low-level warning.">
                <Input
                  value={fuelCapacity}
                  onChangeText={setFuelCapacity}
                  keyboardType="decimal-pad"
                  placeholder="53.0"
                  style={styles.tabular}
                />
              </Field>
            </View>
            <View style={styles.half}>
              <Field label="Fuel units">
                <Choice options={FUEL_UNITS} value={fuelUnits} onChange={setFuelUnits} />
              </Field>
            </View>
          </View>
        </Card>

        <Card style={styles.group}>
          <SectionHeading>Where the meters stand today</SectionHeading>
          {/* The one time these are set rather than advanced. Optional, and
              a correction later is a new reading rather than an edit. */}
          <Body muted>
            Read them off the panel. From here on they advance when flights are logged.
          </Body>
          <View style={styles.row}>
            <View style={styles.third}>
              <Field label="Hobbs">
                <Input
                  value={hobbs}
                  onChangeText={setHobbs}
                  keyboardType="decimal-pad"
                  placeholder="1202.9"
                  style={styles.tabular}
                />
              </Field>
            </View>
            <View style={styles.third}>
              <Field label="Tach">
                <Input
                  value={tach}
                  onChangeText={setTach}
                  keyboardType="decimal-pad"
                  placeholder="1100.2"
                  style={styles.tabular}
                />
              </Field>
            </View>
            <View style={styles.third}>
              <Field label="Airframe">
                <Input
                  value={airframe}
                  onChangeText={setAirframe}
                  keyboardType="decimal-pad"
                  placeholder="1202.9"
                  style={styles.tabular}
                />
              </Field>
            </View>
          </View>
        </Card>

        {error ? <Notice tone="error">{error}</Notice> : null}

        <Button label="Add aircraft" onPress={() => void submit()} busy={busy} />
        <Body muted>
          Nothing is tracked for maintenance until you add it. You can change any of this
          later in Aircraft settings.
        </Body>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { padding: space.base, gap: space.base, paddingBottom: space.xxl },
  group: { gap: space.base },
  row: { flexDirection: 'row', gap: space.md },
  half: { flex: 1 },
  third: { flex: 1 },
  tabular: { fontVariant: ['tabular-nums'] },
});
