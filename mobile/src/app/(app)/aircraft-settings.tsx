import { router, useFocusEffect, useLocalSearchParams, useNavigation } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { File } from 'expo-file-system';
import Feather from '@expo/vector-icons/Feather';
import {
  ApiError,
  type AircraftResponse,
  type AuthorizationResponse,
  type BillingMeter,
  type FuelUnits,
  type MaintenanceMeter,
  type MemberResponse,
  type MeterReadingResponse,
  type RateBasis,
  type UpdateAircraftRequest,
} from '@flightsquare/shared';

import { AircraftThumbnail } from '@/components/aircraft';
import { Sheet } from '@/components/sheet';
import {
  Body,
  Button,
  Card,
  Choice,
  Field,
  Input,
  Notice,
  SectionHeading,
} from '@/components/ui';
import { api, messageFor, withAuth } from '@/lib/api';
import { usePermission } from '@/lib/entitlements';
import { color, radius, space, type } from '@/theme';

/**
 * One aeroplane's settings — the web's Settings tab, on the phone.
 *
 * Photo, details, a manual meter reading and the log behind it, who may fly
 * it, and archiving. Offered only to a member holding `aircraft: write`, and
 * the API refuses regardless (§8.1: hiding is cosmetics).
 *
 * **Online only, and it says so.** Unlike a flight, nothing here is queued:
 * these are an admin's decisions, and a rate change or a sign-off that went
 * out hours later from a phone in a pocket would be a surprise to everybody.
 * With no signal a save fails in place and nothing is kept for later.
 */
export default function AircraftSettings() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const canWrite = usePermission('aircraft') === 'write';
  const canSignOff = usePermission('qualifications') === 'write';

  const navigation = useNavigation();
  const [aircraft, setAircraft] = useState<AircraftResponse | null>(null);
  const [readings, setReadings] = useState<MeterReadingResponse[]>([]);
  const [authorizations, setAuthorizations] = useState<AuthorizationResponse[]>([]);
  const [members, setMembers] = useState<MemberResponse[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    navigation.setOptions({
      title: aircraft ? `${aircraft.registration} settings` : 'Aircraft settings',
    });
  }, [navigation, aircraft]);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [found, log, signedOff, roster] = await Promise.all([
        withAuth(() => api.getAircraft(id)),
        withAuth(() => api.listMeterReadings(id)).catch(() => []),
        withAuth(() => api.listAuthorizations(id)).catch(() => []),
        // Only an admin can read the roster, and only they can sign anybody off.
        withAuth(() => api.listMembers()).catch(() => [] as MemberResponse[]),
      ]);
      setAircraft(found);
      setReadings(log);
      setAuthorizations(signedOff);
      setMembers(roster);
      setLoadError(null);
    } catch (caught) {
      setLoadError(errorFor(caught));
    }
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  if (!canWrite) {
    return (
      <View style={styles.empty}>
        <SectionHeading>Settings</SectionHeading>
        <Body muted>Only an administrator can change an aircraft&apos;s settings.</Body>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled"
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
        {loadError ? <Notice tone="error">{loadError}</Notice> : null}

        {aircraft ? (
          <>
            <PhotoSection aircraft={aircraft} onChanged={setAircraft} />
            <DetailsSection aircraft={aircraft} onSaved={setAircraft} />
            <ReadingSection aircraftId={aircraft.id} onSaved={load} />
            <MeterLog readings={readings} />
            <SignOffSection
              aircraft={aircraft}
              authorizations={authorizations}
              members={members}
              canWrite={canSignOff}
              onChanged={load}
            />
            <ArchiveSection aircraft={aircraft} onChanged={setAircraft} />
          </>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

/** An API refusal in the server's words; anything else is no signal, and nothing was kept. */
function errorFor(caught: unknown): string {
  if (caught instanceof ApiError) return messageFor(caught);
  return 'No signal. Nothing was saved — try again when you are back online.';
}

// ---------------------------------------------------------------------------
// Photo (0043)
// ---------------------------------------------------------------------------

/**
 * Quality turned down for the same reason as every photograph in the app:
 * `storage.bytes` is a real quota on every plan, and a picture that tells
 * three white Cessnas apart does not need eight megabytes.
 */
const PHOTO_OPTIONS: ImagePicker.ImagePickerOptions = {
  mediaTypes: ['images'],
  quality: 0.6,
  allowsEditing: true,
  aspect: [4, 3],
};

function PhotoSection({
  aircraft,
  onChanged,
}: {
  aircraft: AircraftResponse;
  onChanged: (aircraft: AircraftResponse) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  async function pick(from: 'camera' | 'library') {
    const permission =
      from === 'camera'
        ? await ImagePicker.requestCameraPermissionsAsync()
        : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setError(
        from === 'camera'
          ? 'FlightSquare needs camera access to photograph the aircraft. Settings › FlightSquare.'
          : 'FlightSquare needs photo access to choose a picture. Settings › FlightSquare.',
      );
      return;
    }

    const result =
      from === 'camera'
        ? await ImagePicker.launchCameraAsync(PHOTO_OPTIONS)
        : await ImagePicker.launchImageLibraryAsync(PHOTO_OPTIONS);
    const asset = result.canceled ? undefined : result.assets[0];
    if (!asset) return;

    setError(null);
    setBusy('Uploading…');
    try {
      // The same three steps as every upload (§3.8): sign, send the bytes
      // straight to storage, complete — which also puts the old photo aside.
      const contentType =
        asset.mimeType ?? (/\.png$/i.test(asset.uri) ? 'image/png' : 'image/jpeg');
      const file = new File(asset.uri);
      const created = await withAuth(() =>
        api.createAircraftPhoto(aircraft.id, {
          content_type: contentType,
          byte_size: file.size ?? asset.fileSize ?? 1,
        }),
      );
      const sent = await fetch(created.upload_url!, {
        method: 'PUT',
        headers: { 'Content-Type': contentType },
        body: await file.bytes(),
      });
      if (!sent.ok) throw new Error(`the upload was refused (${sent.status})`);
      onChanged(await withAuth(() => api.completeAircraftPhoto(aircraft.id, created.id)));
    } catch (caught) {
      setError(errorFor(caught));
    } finally {
      setBusy(null);
    }
  }

  function remove() {
    Alert.alert(
      'Remove the photo?',
      'It stops being shown everywhere. The file still counts toward your storage.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => {
            setBusy('Removing…');
            setError(null);
            void withAuth(() => api.removeAircraftPhoto(aircraft.id))
              .then(onChanged)
              .catch((caught: unknown) => setError(errorFor(caught)))
              .finally(() => setBusy(null));
          },
        },
      ],
    );
  }

  const photo = aircraft.photo && failed !== aircraft.photo.url ? aircraft.photo : null;

  return (
    <Card>
      <SectionHeading>Photo</SectionHeading>
      {photo ? (
        <Image
          source={{ uri: photo.url }}
          style={styles.photo}
          resizeMode="cover"
          accessibilityLabel={`Photo of ${aircraft.registration}`}
          onError={() => setFailed(photo.url)}
        />
      ) : (
        <View style={styles.photoEmpty}>
          <AircraftThumbnail />
          <Body muted>No photo yet.</Body>
        </View>
      )}
      <Body muted>
        Shown wherever {aircraft.registration} appears, here and on the web. A photo from the
        side, in daylight, is easiest to recognise.
      </Body>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <View style={styles.actions}>
        <Button
          label={busy ?? (aircraft.photo ? 'Take a new photo' : 'Take a photo')}
          busy={busy !== null}
          onPress={() => void pick('camera')}
        />
        <Button
          label="Choose from library"
          variant="secondary"
          disabled={busy !== null}
          onPress={() => void pick('library')}
        />
        {aircraft.photo ? (
          <Button
            label="Remove photo"
            variant="secondary"
            disabled={busy !== null}
            onPress={remove}
          />
        ) : null}
      </View>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Details
// ---------------------------------------------------------------------------

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

const DECIMAL = /^[0-9]{1,7}(\.[0-9])?$/;

function DetailsSection({
  aircraft,
  onSaved,
}: {
  aircraft: AircraftResponse;
  onSaved: (aircraft: AircraftResponse) => void;
}) {
  const [homeBase, setHomeBase] = useState(aircraft.home_base ?? '');
  const [seats, setSeats] = useState(aircraft.seats === null ? '' : String(aircraft.seats));
  const [maintenanceMeter, setMaintenanceMeter] = useState(aircraft.maintenance_meter);
  const [billingMeter, setBillingMeter] = useState(aircraft.billing_meter);
  const [rate, setRate] = useState(
    aircraft.default_rate_cents === null ? '' : (aircraft.default_rate_cents / 100).toFixed(2),
  );
  const [rateBasis, setRateBasis] = useState(aircraft.rate_basis);
  const [fuelCapacity, setFuelCapacity] = useState(aircraft.fuel_capacity ?? '');
  const [fuelUnits, setFuelUnits] = useState(aircraft.fuel_units);
  const [meterPhotos, setMeterPhotos] = useState(aircraft.require_meter_photos);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function save() {
    setSaved(false);
    const body: UpdateAircraftRequest = {
      home_base: homeBase.trim().toUpperCase() || null,
      maintenance_meter: maintenanceMeter,
      billing_meter: billingMeter,
      rate_basis: rateBasis,
      fuel_units: fuelUnits,
      require_meter_photos: meterPhotos,
    };

    // Blank is "not recorded", which clears what was there.
    if (seats.trim()) {
      const count = Number(seats);
      if (!Number.isInteger(count) || count < 1 || count > 50) {
        setError('Enter the seats as a whole number, 1 to 50.');
        return;
      }
      body.seats = count;
    } else {
      body.seats = null;
    }
    if (fuelCapacity.trim()) {
      if (!DECIMAL.test(fuelCapacity.trim())) {
        setError('Enter the usable fuel as a number, for example 53 or 53.5.');
        return;
      }
      body.fuel_capacity = fuelCapacity.trim();
    } else {
      body.fuel_capacity = null;
    }
    if (rate.trim()) {
      const perHour = Number(rate);
      if (!Number.isFinite(perHour) || perHour < 0) {
        setError('Enter the hourly rate as an amount, for example 165.00.');
        return;
      }
      // §3.7 rule 3: integer minor units, converted once, here.
      const cents = Math.round(perHour * 100);
      // A new rate is a new effective-dated row (§3.7 rule 4), so only send
      // one when it actually changed.
      if (cents !== aircraft.default_rate_cents) body.default_rate_cents = cents;
    }

    setBusy(true);
    setError(null);
    try {
      onSaved(await withAuth(() => api.updateAircraft(aircraft.id, body)));
      setSaved(true);
    } catch (caught) {
      setError(errorFor(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card style={styles.group}>
      <SectionHeading>Details</SectionHeading>
      <View style={styles.row}>
        <View style={styles.half}>
          <Field label="Home base">
            <Input
              value={homeBase}
              onChangeText={(text) => setHomeBase(text.toUpperCase())}
              autoCapitalize="characters"
              autoCorrect={false}
              maxLength={16}
              placeholder="KLOT"
            />
          </Field>
        </View>
        <View style={styles.half}>
          <Field label="Seats">
            <Input value={seats} onChangeText={setSeats} keyboardType="number-pad" maxLength={2} />
          </Field>
        </View>
      </View>

      <Field label="Maintenance meter" hint="What inspection intervals count against.">
        <Choice options={MAINTENANCE_METERS} value={maintenanceMeter} onChange={setMaintenanceMeter} />
      </Field>
      <Field label="Billing meter" hint="What flights are charged on.">
        <Choice options={BILLING_METERS} value={billingMeter} onChange={setBillingMeter} />
      </Field>

      <Field label="Hourly rate (USD)" hint="What a member pays per hour.">
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
        hint="Wet credits a pilot back for fuel they buy. Dry does not."
      >
        <Choice options={RATE_BASES} value={rateBasis} onChange={setRateBasis} />
      </Field>

      <View style={styles.row}>
        <View style={styles.half}>
          <Field label="Usable fuel">
            <Input
              value={fuelCapacity}
              onChangeText={setFuelCapacity}
              keyboardType="decimal-pad"
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

      {/* 0042: asked of the form, never a reason a flight is refused (§8.1). */}
      <View style={styles.switchRow}>
        <View style={styles.switchText}>
          <Text style={styles.switchLabel}>Require a photo of the meters with each flight</Text>
          <Text style={styles.meta}>
            Logging a flight asks for a photo of the Hobbs and tach. One that arrives without —
            from an older app, or a failed upload — is saved and marked as missing it.
          </Text>
        </View>
        <Switch
          value={meterPhotos}
          onValueChange={setMeterPhotos}
          trackColor={{ true: color.teal, false: color.line }}
          accessibilityLabel="Require a photo of the meters with each flight"
        />
      </View>

      {/* §3.7: a charge snapshots its rate, so this re-prices nothing past. */}
      <Text style={styles.meta}>
        Changing the rate applies to flights logged from now on. Charges already recorded keep
        the rate they were charged at.
      </Text>

      {error ? <Notice tone="error">{error}</Notice> : null}
      {saved ? <Notice>Saved.</Notice> : null}
      <Button label="Save settings" busy={busy} onPress={() => void save()} />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// A manual meter reading, and the log behind it
// ---------------------------------------------------------------------------

/**
 * Not how meters normally move — a flight does that, and a reading recorded
 * instead advances the meters with nobody billed and nothing saying who had
 * the aeroplane (§3.4). This is for the opening figures, a mistyped number,
 * or hours no flight accounts for. Readings are append-only.
 */
function ReadingSection({ aircraftId, onSaved }: { aircraftId: string; onSaved: () => Promise<void> }) {
  const [hobbs, setHobbs] = useState('');
  const [tach, setTach] = useState('');
  const [airframe, setAirframe] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function save() {
    setSaved(false);
    const values = { hobbs: hobbs.trim(), tach: tach.trim(), airframe_hours: airframe.trim() };
    if (!values.hobbs && !values.tach && !values.airframe_hours) {
      setError('Enter at least one reading.');
      return;
    }
    if (Object.values(values).some((value) => value && !DECIMAL.test(value))) {
      setError('Enter readings to one decimal place, for example 1202.9.');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await withAuth(() =>
        api.createMeterReading(aircraftId, {
          ...(values.hobbs ? { hobbs: values.hobbs } : {}),
          ...(values.tach ? { tach: values.tach } : {}),
          ...(values.airframe_hours ? { airframe_hours: values.airframe_hours } : {}),
          ...(note.trim() ? { note: note.trim() } : {}),
        }),
      );
      setHobbs('');
      setTach('');
      setAirframe('');
      setNote('');
      setSaved(true);
      await onSaved();
    } catch (caught) {
      setError(errorFor(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card style={styles.group}>
      <SectionHeading>Record a meter reading</SectionHeading>
      <Body muted>
        Flights move the meters on their own — log one instead of using this. This is for the
        opening figures, a mistyped number, or hours no flight accounts for, like a maintenance
        run.
      </Body>
      <View style={styles.row}>
        <View style={styles.third}>
          <Field label="Hobbs">
            <Input value={hobbs} onChangeText={setHobbs} keyboardType="decimal-pad" style={styles.tabular} />
          </Field>
        </View>
        <View style={styles.third}>
          <Field label="Tach">
            <Input value={tach} onChangeText={setTach} keyboardType="decimal-pad" style={styles.tabular} />
          </Field>
        </View>
        <View style={styles.third}>
          <Field label="Airframe">
            <Input value={airframe} onChangeText={setAirframe} keyboardType="decimal-pad" style={styles.tabular} />
          </Field>
        </View>
      </View>
      <Field label="Note">
        <Input value={note} onChangeText={setNote} maxLength={500} placeholder="New Hobbs fitted" />
      </Field>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {saved ? <Notice>Reading recorded.</Notice> : null}
      <Button label="Record reading" variant="secondary" busy={busy} onPress={() => void save()} />
    </Card>
  );
}

function MeterLog({ readings }: { readings: MeterReadingResponse[] }) {
  // The latest twenty: enough to see what changed recently. The whole trail is
  // on the web, and it is append-only either way (§3.4).
  const shown = readings.slice(0, 20);
  return (
    <Card>
      <SectionHeading>Meter log</SectionHeading>
      {shown.length === 0 ? <Body muted>Nothing recorded yet.</Body> : null}
      {shown.map((reading) => (
        <View key={reading.id} style={styles.logRow}>
          <Text style={styles.meta}>
            {new Date(reading.recorded_at).toLocaleString(undefined, {
              day: 'numeric',
              month: 'short',
              year: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
            })}
            {/* Kept, and labelled rather than hidden (§3.4). */}
            {reading.superseded ? ' · Corrected' : ''}
          </Text>
          <Text style={styles.logValues}>
            {[
              reading.hobbs ? `Hobbs ${reading.hobbs}` : null,
              reading.tach ? `Tach ${reading.tach}` : null,
              reading.airframe_hours ? `Airframe ${reading.airframe_hours}` : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </Text>
          {reading.note ? <Text style={styles.meta}>{reading.note}</Text> : null}
        </View>
      ))}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Who may fly it (§3.5)
// ---------------------------------------------------------------------------

function SignOffSection({
  aircraft,
  authorizations,
  members,
  canWrite,
  onChanged,
}: {
  aircraft: AircraftResponse;
  authorizations: AuthorizationResponse[];
  members: MemberResponse[];
  canWrite: boolean;
  onChanged: () => Promise<void>;
}) {
  const [picking, setPicking] = useState(false);
  const [chosen, setChosen] = useState<MemberResponse | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signedOff = new Set(authorizations.map((one) => one.membership_id));
  const candidates = members.filter(
    (member) => member.status === 'active' && !signedOff.has(member.id),
  );

  async function signOff() {
    if (!chosen) return;
    setBusy(true);
    setError(null);
    try {
      await withAuth(() =>
        api.authorize(aircraft.id, {
          membership_id: chosen.id,
          ...(note.trim() ? { note: note.trim() } : {}),
        }),
      );
      setChosen(null);
      setNote('');
      await onChanged();
    } catch (caught) {
      setError(errorFor(caught));
    } finally {
      setBusy(false);
    }
  }

  function withdraw(authorization: AuthorizationResponse) {
    const who = authorization.name ?? authorization.email;
    Alert.alert(`Withdraw ${who}?`, `They will no longer be able to book ${aircraft.registration}.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Withdraw',
        style: 'destructive',
        onPress: () => {
          setError(null);
          void withAuth(() => api.withdrawAuthorization(aircraft.id, authorization.membership_id))
            .then(onChanged)
            .catch((caught: unknown) => setError(errorFor(caught)));
        },
      },
    ]);
  }

  return (
    <Card style={styles.group}>
      <SectionHeading>Who may fly it</SectionHeading>
      {authorizations.length === 0 ? (
        <Body muted>
          Nobody is signed off in {aircraft.registration} yet. Until somebody is, only an
          administrator can book it.
        </Body>
      ) : (
        authorizations.map((authorization) => (
          <View key={authorization.membership_id} style={styles.personRow}>
            <View style={styles.personText}>
              <Text style={styles.personName}>{authorization.name ?? authorization.email}</Text>
              <Text style={styles.meta}>
                Signed off {authorization.authorized_on}
                {authorization.authorized_by_email ? ` by ${authorization.authorized_by_email}` : ''}
                {authorization.note ? ` · ${authorization.note}` : ''}
              </Text>
            </View>
            {canWrite ? (
              <Pressable
                onPress={() => withdraw(authorization)}
                accessibilityRole="button"
                accessibilityLabel={`Withdraw ${authorization.name ?? authorization.email}`}
                hitSlop={8}
                style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
              >
                <Feather name="x" size={20} color={color.navy} />
              </Pressable>
            ) : null}
          </View>
        ))
      )}

      {canWrite && candidates.length > 0 ? (
        <View style={styles.group}>
          <Field label="Sign off a member">
            <Pressable
              onPress={() => setPicking(true)}
              accessibilityRole="button"
              accessibilityLabel={chosen ? `${chosen.name ?? chosen.email}. Change` : 'Choose somebody'}
              style={({ pressed }) => [styles.select, pressed && styles.pressed]}
            >
              <Text style={chosen ? styles.personName : styles.placeholder}>
                {chosen ? (chosen.name ?? chosen.email) : 'Choose somebody…'}
              </Text>
              <Feather name="chevron-down" size={20} color={color.secondary} />
            </Pressable>
          </Field>
          <Field label="Note" hint="Optional — when, and by whom, if it matters.">
            <Input value={note} onChangeText={setNote} maxLength={500} placeholder="Checked out 15 May" />
          </Field>
          <Button label="Sign off" variant="secondary" busy={busy} disabled={!chosen} onPress={() => void signOff()} />
        </View>
      ) : null}
      {error ? <Notice tone="error">{error}</Notice> : null}

      <Sheet visible={picking} title="Sign off a member" onClose={() => setPicking(false)}>
        {candidates.map((member) => (
          <Pressable
            key={member.id}
            onPress={() => {
              setChosen(member);
              setPicking(false);
            }}
            accessibilityRole="radio"
            accessibilityState={{ selected: chosen?.id === member.id }}
            style={({ pressed }) => [
              styles.option,
              chosen?.id === member.id && styles.optionChosen,
              pressed && styles.pressed,
            ]}
          >
            <View style={styles.personText}>
              <Text style={styles.personName}>{member.name ?? member.email}</Text>
              {member.name ? <Text style={styles.meta}>{member.email}</Text> : null}
            </View>
            {chosen?.id === member.id ? <Feather name="check" size={20} color={color.navy} /> : null}
          </Pressable>
        ))}
      </Sheet>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Archive (§5.5)
// ---------------------------------------------------------------------------

function ArchiveSection({
  aircraft,
  onChanged,
}: {
  aircraft: AircraftResponse;
  onChanged: (aircraft: AircraftResponse) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const archived = aircraft.status === 'archived';

  function change(status: 'active' | 'archived') {
    setBusy(true);
    setError(null);
    void withAuth(() => api.updateAircraft(aircraft.id, { status }))
      .then((updated) => {
        onChanged(updated);
        if (status === 'archived') router.back();
      })
      // Restoring can be a 402: it has to fit the plan's aircraft limit again.
      .catch((caught: unknown) => setError(errorFor(caught)))
      .finally(() => setBusy(false));
  }

  return (
    <Card style={styles.group}>
      <SectionHeading>{archived ? 'Archived' : 'Archive'}</SectionHeading>
      <Body muted>
        {archived
          ? `${aircraft.registration} keeps its whole history. Restoring it makes it bookable again, if your plan has room for it.`
          : `${aircraft.registration} stops being bookable and stops counting toward your plan. Its flights and maintenance history stay, and it can be restored.`}
      </Body>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Button
        label={archived ? 'Restore aircraft' : 'Archive aircraft'}
        variant="secondary"
        busy={busy}
        onPress={() =>
          archived
            ? change('active')
            : Alert.alert(`Archive ${aircraft.registration}?`, 'Its history stays. You can restore it later.', [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Archive', style: 'destructive', onPress: () => change('archived') },
              ])
        }
      />
    </Card>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: color.mist },
  container: { padding: space.base, paddingBottom: space.xxl, gap: space.md },
  empty: { padding: space.base, gap: space.sm },
  group: { gap: space.md },
  actions: { gap: space.sm, marginTop: space.sm },
  row: { flexDirection: 'row', gap: space.md },
  half: { flex: 1 },
  third: { flex: 1 },
  tabular: { fontVariant: ['tabular-nums'] },
  meta: { ...type.supporting, color: color.secondary },

  photo: {
    width: '100%',
    aspectRatio: 4 / 3,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: color.line,
    backgroundColor: color.mist,
    marginVertical: space.md,
  },
  photoEmpty: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    marginVertical: space.md,
  },

  switchRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  switchText: { flex: 1, gap: 2 },
  switchLabel: { ...type.body, color: color.navy },

  logRow: {
    paddingVertical: space.sm,
    borderTopWidth: 1,
    borderTopColor: color.line,
    marginTop: space.sm,
    gap: 2,
  },
  logValues: { ...type.bodySmall, color: color.navy, fontVariant: ['tabular-nums'] },

  personRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  personText: { flex: 1, gap: 2 },
  personName: { ...type.body, color: color.navy },
  placeholder: { ...type.body, color: color.secondary },
  iconButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.control,
  },
  select: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.md,
    borderWidth: 1,
    borderColor: color.control,
    borderRadius: radius.control,
    backgroundColor: color.surface,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: 56,
    padding: space.md,
    borderWidth: 1,
    borderColor: color.line,
    borderRadius: radius.control,
    marginBottom: space.sm,
  },
  optionChosen: { borderColor: color.teal, backgroundColor: color.selected },
  pressed: { opacity: 0.7 },
});
