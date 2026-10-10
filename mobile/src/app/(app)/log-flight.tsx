import { router, useFocusEffect, useLocalSearchParams, useNavigation } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import DateTimePicker from '@react-native-community/datetimepicker';
import Feather from '@expo/vector-icons/Feather';
import { dayLabel, plainDate } from '@flightsquare/shared/time';
import type {
  AerodromeResponse,
  AircraftResponse,
  FlightCategory,
  FlightResponse,
} from '@flightsquare/shared';

import {
  Body,
  Button,
  Card,
  CardHeading,
  Choice,
  Field,
  Input,
  Notice,
  Picker,
} from '@/components/ui';
import { api, messageFor, withAuth } from '@/lib/api';
import { saveAttachment, saveFlight, saveSquawk } from '@/lib/sync';
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
 * notes. Fuel is no longer behind a button — an aeroplane is handed on with
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

/**
 * When the reading was taken, for a flight dated `day`.
 *
 * Today's flight is being logged at the aeroplane, so the moment is the truth.
 * A flight logged the next morning happened at some point on its own day, and
 * noon local is the honest anchor for "that day" — precise enough to order it
 * before anything logged since, vague enough not to claim a time nobody
 * recorded.
 *
 * Two flights back-dated to the same day tie, and the tie breaks on the row id,
 * which is a UUIDv7 and therefore ordered by when it was minted. Deterministic,
 * and the later entry wins — which is the best available answer.
 */
function recordedAtFor(day: string): string {
  if (day === todayIso()) return new Date().toISOString();
  return new Date(`${day}T12:00:00`).toISOString();
}

/**
 * The airport behind an identifier, if the table knows it.
 *
 * Decoration, deliberately. §8.2 keeps this form working with no signal, so
 * a lookup that cannot be made simply shows nothing — and an identifier the
 * table has never heard of shows nothing either, because 0014 dropped the
 * foreign key on the grounds that "a list that incomplete refuses almost
 * every true answer". A grass strip with a name rather than a code is a true
 * answer and stays loggable.
 *
 * Debounced, because it runs on a keystroke, and cancelled on the way out so
 * a slow answer to "KL" cannot land after "KLOT" has been typed.
 */
function useAerodrome(ident: string): AerodromeResponse | null {
  const [found, setFound] = useState<AerodromeResponse | null>(null);

  useEffect(() => {
    const code = ident.trim();
    if (code.length < 3) {
      setFound(null);
      return;
    }

    let live = true;
    const timer = setTimeout(() => {
      void withAuth(() => api.aerodrome(code))
        .then((row) => live && setFound(row))
        .catch(() => live && setFound(null));
    }, 300);

    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [ident]);

  return found;
}

/** "Lewis University Airport · Chicago/Romeoville, IL" */
function describe(aerodrome: AerodromeResponse): string {
  const place = [aerodrome.municipality, aerodrome.region].filter(Boolean).join(', ');
  return place ? `${aerodrome.name} · ${place}` : aerodrome.name;
}

/** One defect, before it is a record. `key` is for React, not the server. */
interface SquawkDraft {
  key: string;
  summary: string;
  details: string;
  grounds: boolean;
  photos: PhotoDraft[];
}

/**
 * A photograph the picker has handed back, still in its cache.
 *
 * It is not copied anywhere or uploaded until the flight is saved: the
 * ordinary outcome of opening this screen is saving it, but the outcome of
 * tapping a photo and then backing out should not be a file left in the
 * app's documents forever.
 */
interface PhotoDraft {
  key: string;
  uri: string;
  contentType: string;
}

/**
 * A photograph of the defect, taken at the aeroplane.
 *
 * Quality is turned down hard on purpose. A modern phone camera produces
 * eight megabytes a frame, `storage.bytes` is a real quota on every plan, and
 * nothing about a cracked bracket or a weeping fitting needs more resolution
 * than this — the picture exists so a mechanic knows what they are walking out
 * to, not so it can be printed.
 */
const PHOTO_OPTIONS: ImagePicker.ImagePickerOptions = {
  mediaTypes: ['images'],
  quality: 0.6,
  allowsMultipleSelection: false,
};

function contentTypeOf(asset: ImagePicker.ImagePickerAsset): string {
  if (asset.mimeType) return asset.mimeType;
  // The picker usually says. When it does not, JPEG is what a phone camera
  // produced and what the API accepts.
  return /\.png$/i.test(asset.uri) ? 'image/png' : 'image/jpeg';
}

const CATEGORIES: { value: FlightCategory; label: string }[] = [
  { value: 'personal', label: 'Personal' },
  { value: 'business', label: 'Business' },
  { value: 'maintenance', label: 'Maintenance' },
];

export default function LogFlight() {
  /**
   * Logging a flight, or correcting one.
   *
   * `correct` is a flight id, and it turns this screen into the same form
   * filled in with that entry — because §3.4 makes a correction a *new
   * flight* superseding the old one, so what has to be submitted is the whole
   * thing again. One screen rather than a second one: every field, the date
   * picker, the aerodrome lookups and the fuel block already live here, and
   * the meters §3.4 calls the most important in the product should be typed
   * in exactly one place.
   */
  const params = useLocalSearchParams<{ aircraft?: string; correct?: string }>();
  const correctingId = params.correct;
  const [correcting, setCorrecting] = useState<FlightResponse | null>(null);
  const [reason, setReason] = useState('');
  const aircraftId = correcting?.aircraft_id ?? params.aircraft ?? '';

  // The tab registers one static title for both uses of this screen, so the
  // one that is not the default says so itself.
  const navigation = useNavigation();
  useEffect(() => {
    navigation.setOptions({ title: correctingId ? 'Correct flight' : 'Log flight' });
  }, [navigation, correctingId]);

  const [aircraft, setAircraft] = useState<AircraftResponse | null>(null);

  /**
   * When it was flown.
   *
   * Today, almost always — a post-flight entry is made at the aeroplane — so
   * today is the default and nobody has to touch it. But a flight logged the
   * next morning is the whole reason the field exists, and until now this
   * screen sent `todayIso()` with no way to say otherwise, which quietly
   * dated yesterday's flying to today and put its meters in the wrong order.
   *
   * A plain calendar date, never an instant (§6 keeps those apart).
   */
  const [flightDate, setFlightDate] = useState(todayIso);
  const [pickingDate, setPickingDate] = useState(false);

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

  /**
   * However many are wrong.
   *
   * A walk-around finds what it finds, and §3.6 keeps each defect its own
   * record — separate severity, separate grounding judgement, separately
   * deferred or signed off. One form field could only ever have produced one
   * squawk holding a list, which is not the same thing at all.
   */
  const [squawks, setSquawks] = useState<SquawkDraft[]>([]);

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * Which of the prefillable fields the pilot has actually typed in.
   *
   * The prefill reruns on every focus now, so it needs to tell a figure it
   * put there itself from one somebody entered. A value it supplied is a
   * stand-in and may be replaced by a better one; a value the pilot typed is
   * the answer and is never overwritten.
   *
   * A ref and not state: nothing renders from it, and it must be readable by
   * the fetch's callback without making the effect depend on it.
   */
  const touched = useRef(new Set<string>());
  const touch = (field: string) => {
    touched.current.add(field);
  };

  /**
   * Back to blank, except for what the next flight genuinely starts from.
   *
   * This screen is registered in `_layout.tsx` as a tab with `href: null`, so
   * leaving it hides it rather than unmounting it and every `useState` above
   * survives. Logging a second flight therefore opened the form still holding
   * the first one's entry — which on the most important screen in the product
   * (§3.4) is how last leg's Hobbs end gets saved as this one's start, and
   * every number downstream follows it.
   *
   * What carries over is the *aeroplane's* state and never the pilot's entry:
   * it is now wherever the last flight arrived, its meters read what that
   * flight ended at, and its tanks hold what was left in them. Those come from
   * the values just submitted rather than from re-reading the aircraft,
   * because §8.2 queues the write — a refetch would answer with the
   * pre-flight figures until it syncs, and at a rural tiedown would not
   * answer at all.
   */
  const resetForm = useCallback(
    (carry?: { location?: string; hobbs?: string; tach?: string; fuel?: string }) => {
      setFlightDate(todayIso());
      setPickingDate(false);
      setMeters({
        hobbs_start: carry?.hobbs ?? '',
        hobbs_end: '',
        tach_start: carry?.tach ?? '',
        tach_end: '',
      });
      setDepartedFrom(carry?.location ?? '');
      // Never carried: where it is going is not something the last flight
      // knows, and suggesting the return leg is how a round trip gets logged
      // twice in the same direction.
      setArrivedAt('');
      setFuelBefore(carry?.fuel ?? '');
      setFuelAfter('');
      setFuelAdded('');
      setFuelPrice('');
      setCategory('personal');
      setRemarks('');
      // §3.6 keeps each defect its own record, and one already filed is one
      // already queued. Carrying a draft forward would file it twice.
      setSquawks([]);
      setError(null);
      // Carried values are prefills, not answers: the figures below came from
      // the last flight and the server may know better by the next focus.
      touched.current = new Set();

      /*
        The queued flight has moved the aeroplane, and this screen's own
        snapshot of it is what the "does not meet the last reading" flag
        compares a start against (§8.2 flags, never rejects). Left on the
        pre-flight figures, the next entry would open accusing the pilot of a
        gap against the reading they had just written down.

        Mirroring it locally rather than refetching, for the same reason the
        carried values come from the submitted ones: the write is in the queue.
      */
      if (carry) {
        setAircraft((current) =>
          current
            ? {
                ...current,
                ...(carry.hobbs ? { hobbs: carry.hobbs } : {}),
                ...(carry.tach ? { tach: carry.tach } : {}),
                ...(carry.fuel ? { fuel_remaining: carry.fuel } : {}),
                ...(carry.location ? { last_location: carry.location } : {}),
              }
            : current,
        );
      }
    },
    [],
  );

  /**
   * A different aeroplane is a different form.
   *
   * Clearing on the id rather than inside the focus effect, so that coming
   * back to the *same* aeroplane keeps a half-finished entry.
   */
  const lastLoaded = useRef<string | null>(null);

  /**
   * Never wind a meter backwards.
   *
   * The one hazard in reloading: a flight logged with no signal sits in
   * SQLite (§8.2), and until it drains `/aircraft` answers with the figures
   * from *before* it. Hobbs and tach only ever go up, so "the larger of the
   * two" settles it with no knowledge of the queue at all — which is what
   * this needs, because a *failed* queue entry stays there until somebody
   * retries or discards it and would otherwise hold the prefill off for good.
   *
   * Fuel and the aerodrome are not monotonic and get no such rule: online the
   * server is the record, and offline the fetch below simply fails and the
   * carried values stand, which is the behaviour wanted in both cases.
   */
  const higher = (local: string | null, remote: string | null): string | null => {
    if (local === null) return remote;
    if (remote === null) return local;
    return Number(remote) >= Number(local) ? remote : local;
  };

  /**
   * Prefill from what the aeroplane is showing — on **every focus**, not once.
   *
   * This screen is a tab with `href: null`, so it stays mounted and a plain
   * mount effect ran exactly once a session. Every other screen in the app
   * reloads on focus (`index`, `aircraft-detail`, `logs`, `maintenance` and
   * the rest); this one did not, which made it the only place that could show
   * figures the club had already moved on from. Log a flight on the web and
   * open this screen on the phone, and it offered the fuel and the aerodrome
   * from before that flight.
   *
   * It never overwrites a field the pilot typed — `touched` is the whole
   * difference between a suggestion and an answer. The values carried forward
   * after a save are deliberately not marked: they are this screen's guess at
   * where the aeroplane now is, and the server may know better.
   */
  /**
   * The entry being corrected, filled in as it stands.
   *
   * On mount only, and overwriting rather than filling blanks: the figures to
   * start from are the ones that were logged, not the ones the aeroplane is
   * showing now. The focus prefill below is skipped entirely while this is on
   * — it exists to answer "what should this flight start from", and a
   * correction already knows.
   */
  useEffect(() => {
    if (!correctingId) return;
    let live = true;
    void withAuth(() => api.getFlight(correctingId))
      .then((found) => {
        if (!live) return;
        setCorrecting(found);
        setFlightDate(found.flight_date);
        setMeters({
          hobbs_start: found.hobbs_start ?? '',
          hobbs_end: found.hobbs_end ?? '',
          tach_start: found.tach_start ?? '',
          tach_end: found.tach_end ?? '',
        });
        setDepartedFrom(found.departed_from ?? '');
        setArrivedAt(found.arrived_at ?? '');
        setFuelBefore(found.fuel_remaining_before ?? '');
        setFuelAfter(found.fuel_remaining_after ?? '');
        setFuelAdded(found.fuel_added_qty ?? '');
        setFuelPrice(found.fuel_price_cents !== null ? (found.fuel_price_cents / 100).toFixed(2) : '');
        setCategory(found.category ?? 'personal');
        setRemarks(found.remarks ?? '');
        // Every field is now the pilot's answer, not a suggestion, so the
        // focus prefill must not treat any of them as replaceable.
        touched.current = new Set([
          'hobbs_start', 'tach_start', 'departedFrom', 'fuelBefore',
        ]);
        void withAuth(() => api.getAircraft(found.aircraft_id))
          .then((plane) => live && setAircraft(plane))
          .catch(() => undefined);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [correctingId]);

  useFocusEffect(
    useCallback(() => {
      let live = true;
      if (!aircraftId || correctingId) return undefined;
      if (lastLoaded.current !== null && lastLoaded.current !== aircraftId) resetForm();
      lastLoaded.current = aircraftId;

      void withAuth(() => api.getAircraft(aircraftId))
        .then((found) => {
          if (!live) return;

          // Keeping the higher meters, because this is also the figure §8.2's
          // "does not meet the last reading" notice compares a start against:
          // taking a stale one would put that notice up against a reading the
          // pilot had just written down.
          setAircraft((current) =>
            current === null
              ? found
              : {
                  ...found,
                  hobbs: higher(current.hobbs, found.hobbs),
                  tach: higher(current.tach, found.tach),
                  airframe_hours: higher(current.airframe_hours, found.airframe_hours),
                },
          );

          const keep = (field: string, current: string) =>
            touched.current.has(field) ? current : null;

          setMeters((current) => ({
            ...current,
            hobbs_start:
              keep('hobbs_start', current.hobbs_start) ??
              (higher(current.hobbs_start || null, found.hobbs) ?? ''),
            tach_start:
              keep('tach_start', current.tach_start) ??
              (higher(current.tach_start || null, found.tach) ?? ''),
          }));
          // Where it last landed is where this flight starts from. Where it
          // is going is not something the aeroplane knows, so **To** stays
          // empty rather than suggesting the pilot is coming straight back.
          const here = found.last_location ?? found.home_base ?? '';
          setDepartedFrom((current) => keep('departedFrom', current) ?? here);
          // §3.4: fuel is state, latest reading wins. Suggested, not asserted —
          // where the pilot corrects it, the difference is fuel somebody added
          // without logging it, which is information rather than an error.
          setFuelBefore((current) => keep('fuelBefore', current) ?? (found.fuel_remaining ?? ''));
        })
        // No signal: whatever is in the form already is the best answer there
        // is, and an empty form is still fillable. That is the point of it.
        .catch(() => undefined);

      return () => {
        live = false;
      };
    }, [aircraftId, correctingId, resetForm]),
  );

  const from = useAerodrome(departedFrom);
  const to = useAerodrome(arrivedAt);

  const hobbsHours = hoursBetween(meters.hobbs_start, meters.hobbs_end);
  const tachHours = hoursBetween(meters.tach_start, meters.tach_end);
  const unit = aircraft?.fuel_units === 'litres' ? 'L' : 'gal';
  /** The word, for the heading. `unit` is the abbreviation, for a label. */
  const units = aircraft?.fuel_units === 'litres' ? 'litres' : 'gallons';

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
    if (squawks.some((one) => !one.summary.trim())) {
      setError('Say what is wrong, or remove the empty squawk.');
      return;
    }
    if (correctingId && reason.trim().length < 5) {
      setError('Say what was wrong with the entry. It stays on the record.');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const flightId = await saveFlight({
        aircraft_id: aircraftId,
        flight_date: flightDate,
        // §8.2: recorded-at is when it *happened*, and received-at is when it
        // arrived — "frequently different, sometimes by days". That stopped
        // being a formality the moment the date became choosable, because
        // `record_flight_meters` stamps the meter reading with the flight's
        // recorded-at and `refresh_aircraft_meter_totals` takes the latest
        // reading by it. Send `now` for a flight logged this morning and the
        // aircraft's totals would wind *backwards* to yesterday's shutdown,
        // with every number downstream following.
        recorded_at: recordedAtFor(flightDate),
        category,
        // §3.4: this row replaces that one, and both stay. There is no PATCH.
        ...(correctingId
          ? { supersedes_id: correctingId, correction_reason: reason.trim() }
          : {}),
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

      /**
       * Each squawk queued separately, and named against the flight it was
       * found on.
       *
       * Separate writes rather than one because they are separate records
       * with separate lives — §3.6 makes the squawk log something read back
       * after an accident, and none of them must depend on the flight's write
       * succeeding. The flight id is the device's (§8.2), so every link holds
       * even when nothing has reached the server.
       */
      for (const draft of squawks) {
        if (!draft.summary.trim()) continue;
        const reportedAt = new Date().toISOString();
        const squawkId = await saveSquawk({
          aircraft_id: aircraftId,
          summary: draft.summary.trim(),
          ...(draft.details.trim() ? { details: draft.details.trim() } : {}),
          // The pilot's judgement, not inferred from the words they used.
          ...(draft.grounds ? { severity: 'grounding' as const, grounding: true } : {}),
          found_on_flight_id: flightId,
          reported_at: reportedAt,
        });

        // Each photograph is its own queue entry, ordered just behind the
        // squawk it belongs to — `after` is what puts it there, and the queue
        // sends in that order so the squawk exists by the time the upload
        // names it (§8.2).
        for (const photo of draft.photos) {
          await saveAttachment({
            owner: { kind: 'squawk', squawkId },
            uri: photo.uri,
            contentType: photo.contentType,
            after: reportedAt,
          });
        }
      }

      /*
        Blank for the next flight, holding only what the aeroplane now reads.
        A local circuit usually leaves **To** empty, so where it is standing is
        where it arrived or, failing that, where it departed.
      */
      resetForm({
        location: arrivedAt.trim() || departedFrom.trim(),
        hobbs: meters.hobbs_end,
        tach: meters.tach_end,
        fuel: fuelAfter.trim(),
      });

      router.back();
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(false);
    }
  }

  const set = (key: keyof typeof meters) => (value: string) => {
    // Typed, so the focus prefill leaves it alone from here on.
    touch(key);
    setMeters((current) => ({ ...current, [key]: value }));
  };

  const edit = (key: string, patch: Partial<SquawkDraft>) =>
    setSquawks((all) => all.map((one) => (one.key === key ? { ...one, ...patch } : one)));

  /**
   * Add one, from the camera or from what is already on the phone.
   *
   * Permission is asked for at the tap rather than on mount: a pilot who
   * never photographs anything should never see the prompt, and one who does
   * sees it at the moment it is obvious why.
   */
  async function addPhoto(draftKey: string, from: 'camera' | 'library') {
    const permission =
      from === 'camera'
        ? await ImagePicker.requestCameraPermissionsAsync()
        : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setError(
        from === 'camera'
          ? 'FlightSquare needs camera access to photograph a defect. Settings › FlightSquare.'
          : 'FlightSquare needs photo access to attach a picture. Settings › FlightSquare.',
      );
      return;
    }

    const result =
      from === 'camera'
        ? await ImagePicker.launchCameraAsync(PHOTO_OPTIONS)
        : await ImagePicker.launchImageLibraryAsync(PHOTO_OPTIONS);
    if (result.canceled) return;

    const asset = result.assets[0];
    if (!asset) return;

    setError(null);
    edit(draftKey, {
      photos: [
        ...(squawks.find((one) => one.key === draftKey)?.photos ?? []),
        {
          key: `${Date.now()}-${asset.uri}`,
          uri: asset.uri,
          contentType: contentTypeOf(asset),
        },
      ],
    });
  }

  const removePhoto = (draftKey: string, photoKey: string) =>
    setSquawks((all) =>
      all.map((one) =>
        one.key === draftKey
          ? { ...one, photos: one.photos.filter((photo) => photo.key !== photoKey) }
          : one,
      ),
    );

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        {/*
          The aeroplane and the day, on one line. The date is almost always
          today and almost never touched, so it sits here as a compact control
          rather than as a field of its own further down the form.
        */}
        <View style={styles.head}>
          {/* `flex: 1` either way, so the date sits at the right edge from the
              first frame instead of jumping there when the aircraft loads. */}
          <Text style={styles.registration} numberOfLines={1}>
            {aircraft?.registration ?? ''}
          </Text>
          <Picker
            compact
            onPress={() => setPickingDate(true)}
            label={`Flown ${dayLabel(flightDate)}. Change the date`}
          >
            <Feather name="calendar" size={16} color={color.secondary} />
            <Text style={styles.date}>
              {flightDate === todayIso() ? 'Today' : dayLabel(flightDate)}
            </Text>
          </Picker>
        </View>

        {pickingDate ? (
          <DateTimePicker
            value={new Date(`${flightDate}T12:00:00`)}
            mode="date"
            display={Platform.OS === 'ios' ? 'spinner' : 'default'}
            // Nothing has been flown tomorrow. The server does not care, but
            // offering the date is offering a mistake.
            maximumDate={new Date()}
            onValueChange={(_, picked) => {
              // Android's dialog is modal and closes itself; the iOS spinner
              // stays open under the control it belongs to.
              if (Platform.OS !== 'ios') setPickingDate(false);
              // The wall-clock date, never the picker's instant — which
              // belongs to the phone's zone and is already tomorrow in UTC
              // for half the world.
              if (picked) setFlightDate(plainDate(picked));
            }}
            onDismiss={() => setPickingDate(false)}
          />
        ) : null}

        {/*
          Why, first, because it is the thing a correction is *for* and the
          only field that is not already filled in. §3.6's house pattern:
          the permanence is said before the tap, not after.
        */}
        {correctingId ? (
          <Card style={styles.group}>
            <CardHeading>Correcting this entry</CardHeading>
            <Body muted>
              The original stays on the log beside the correction. Both do — nothing in a flight
              record is ever removed, and any charge is reversed and worked out again.
            </Body>
            <Field label="What was wrong with it" compact required>
              <Input
                compact
                value={reason}
                onChangeText={setReason}
                multiline
                maxLength={500}
                style={styles.details}
                placeholder="Hobbs was misread; the panel said 1202.5"
              />
            </Field>
          </Card>
        ) : null}

        {/* Meters ------------------------------------------------------ */}
        <Card style={styles.group}>
          {/*
            §11 and §3.4: Hobbs and tach are distinguished explicitly. They
            run at different rates by design, and the difference between them
            is real data about how the aircraft was flown — so they are two
            named rows of a grid rather than two anonymous pairs.

            A grid, because the two meters ask the same two questions: naming
            Out and In once across the top costs one 18px row instead of four
            field labels, and the derived hours get a column rather than a line
            of body text each. Four stacked fields became two rows.
          */}
          <View style={styles.meterHead}>
            <Text style={styles.meterName} />
            <Text style={styles.columnLabel}>Out</Text>
            <Text style={styles.columnLabel}>In</Text>
            <Text style={styles.hoursLabel}>Hours</Text>
          </View>

          <View style={styles.meterRow}>
            <Text style={styles.meterName}>Hobbs</Text>
            <Input
              compact
              style={styles.meterInput}
              value={meters.hobbs_start}
              onChangeText={set('hobbs_start')}
              keyboardType="decimal-pad"
              accessibilityLabel="Hobbs out"
            />
            <Input
              compact
              style={styles.meterInput}
              value={meters.hobbs_end}
              onChangeText={set('hobbs_end')}
              keyboardType="decimal-pad"
              autoFocus
              accessibilityLabel="Hobbs in"
            />
            <Text style={styles.hoursValue}>{hobbsHours ?? '—'}</Text>
          </View>

          <View style={styles.meterRow}>
            <Text style={styles.meterName}>Tach</Text>
            <Input
              compact
              style={styles.meterInput}
              value={meters.tach_start}
              onChangeText={set('tach_start')}
              keyboardType="decimal-pad"
              accessibilityLabel="Tach out"
            />
            <Input
              compact
              style={styles.meterInput}
              value={meters.tach_end}
              onChangeText={set('tach_end')}
              keyboardType="decimal-pad"
              accessibilityLabel="Tach in"
            />
            <Text style={styles.hoursValue}>{tachHours ?? '—'}</Text>
          </View>

          {hobbsGap ? (
            <Notice>
              This does not match the last recorded Hobbs of {aircraft?.hobbs}. Save it anyway —
              the flight will be flagged for review.
            </Notice>
          ) : null}
        </Card>

        {/* Route ------------------------------------------------------- */}
        <Card style={styles.group}>
          <CardHeading>Route</CardHeading>
          <View style={styles.pair}>
            <View style={styles.half}>
              <Field label="From" compact>
                <Input
                  compact
                  value={departedFrom}
                  onChangeText={(text) => {
                    touch('departedFrom');
                    setDepartedFrom(text.toUpperCase());
                  }}
                  placeholder="KPAO"
                  autoCapitalize="characters"
                  autoCorrect={false}
                  maxLength={16}
                />
              </Field>
              {from ? <Text style={styles.place}>{describe(from)}</Text> : null}
            </View>
            <View style={styles.half}>
              <Field label="To" compact>
                <Input
                  compact
                  value={arrivedAt}
                  onChangeText={(text) => setArrivedAt(text.toUpperCase())}
                  placeholder="KHAF"
                  autoCapitalize="characters"
                  autoCorrect={false}
                  maxLength={16}
                />
              </Field>
              {to ? <Text style={styles.place}>{describe(to)}</Text> : null}
            </View>
          </View>
        </Card>

        {/* Fuel -------------------------------------------------------- */}
        <Card style={styles.group}>
          {/*
            The unit said once, in the heading. Four fields each repeating it
            underneath was four lines saying what the heading already says —
            and the labels stay short, because "At shutdown (required)" wraps
            to two lines in a half-width column and costs more than it saves.
          */}
          <CardHeading>Fuel · {units}</CardHeading>
          {/*
            §3.4: two different things, and they must not be one field.
            Remaining is aircraft *state* — the next pilot walks out to it.
            Added is a *transaction*, and on a wet rate it credits the pilot
            back (§3.7).
          */}
          <View style={styles.pair}>
            <View style={styles.half}>
              <Field label="Before" compact>
                <Input
                  compact
                  value={fuelBefore}
                  onChangeText={(text) => {
                    touch('fuelBefore');
                    setFuelBefore(text);
                  }}
                  keyboardType="decimal-pad"
                />
              </Field>
            </View>
            <View style={styles.half}>
              <Field label="After" required compact>
                <Input
                  compact
                  value={fuelAfter}
                  onChangeText={setFuelAfter}
                  keyboardType="decimal-pad"
                />
              </Field>
            </View>
          </View>

          <View style={styles.pair}>
            <View style={styles.half}>
              <Field label="Added" compact>
                <Input
                  compact
                  value={fuelAdded}
                  onChangeText={setFuelAdded}
                  keyboardType="decimal-pad"
                />
              </Field>
            </View>
            <View style={styles.half}>
              <Field label={`Price/${unit}`} compact>
                <Input
                  compact
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
          <CardHeading>What this flight was</CardHeading>
          <Choice options={CATEGORIES} value={category} onChange={setCategory} />
          {category === 'maintenance' ? (
            // Said out loud, because a club might reasonably expect otherwise
            // and §3.7 makes a charge append-only once it exists.
            <Body muted>Recorded on the flight. It does not change what this costs.</Body>
          ) : null}
        </Card>

        {/*
          Squawks ------------------------------------------------------
          Not offered on a correction: the defect belongs to the flight it was
          found on, and filing the drafts again would file it twice (§3.6).
        */}
        {correctingId ? null : squawks.map((draft, index) => (
          <Card key={draft.key} style={styles.group}>
            <View style={styles.squawkHead}>
              <CardHeading>Squawk {squawks.length > 1 ? index + 1 : ''}</CardHeading>
              <Pressable
                onPress={() => setSquawks((all) => all.filter((one) => one.key !== draft.key))}
                accessibilityRole="button"
                accessibilityLabel={`Remove squawk ${index + 1}`}
                hitSlop={space.sm}
                style={({ pressed }) => [styles.remove, pressed && styles.pressed]}
              >
                <Text style={styles.removeLabel}>Remove</Text>
              </Pressable>
            </View>

            <Field label="What is wrong" required compact>
              <Input
                value={draft.summary}
                onChangeText={(text) => edit(draft.key, { summary: text })}
                placeholder="Left brake soft"
                maxLength={200}
                autoFocus={draft.summary === '' && draft.details === ''}
              />
            </Field>

            <Field label="Details" compact>
              <Input
                value={draft.details}
                onChangeText={(text) => edit(draft.key, { details: text })}
                placeholder="Pedal travels most of the way before it bites."
                multiline
                maxLength={4000}
                style={styles.details}
              />
            </Field>

            {/*
              §3.6: `grounding` is a separate judgement from severity — an
              inspection can ground something reported as minor — and it is
              the boolean §3.3 reads to stop the aeroplane being booked. So it
              is the pilot's call, made explicitly.
            */}
            <Pressable
              onPress={() => edit(draft.key, { grounds: !draft.grounds })}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: draft.grounds }}
              style={({ pressed }) => [
                styles.check,
                draft.grounds && styles.checkOn,
                pressed && styles.pressed,
              ]}
            >
              <View style={[styles.box, draft.grounds && styles.boxOn]}>
                {draft.grounds ? <Feather name="check" size={14} color={color.onDark} /> : null}
              </View>
              <Text style={styles.checkLabel}>This grounds the aircraft</Text>
            </Pressable>

            {draft.grounds ? (
              // Not a description of the field — what happens because of it.
              <Notice tone="error">
                This stops the aircraft being booked until somebody with maintenance access
                resolves or defers it.
              </Notice>
            ) : null}

            {/*
              Photographs. A mechanic reading a squawk a week later gets far
              more from one picture of the bracket than from any sentence a
              pilot standing in the wind is going to type.
            */}
            {draft.photos.length > 0 ? (
              <View style={styles.photos}>
                {draft.photos.map((photo) => (
                  <View key={photo.key} style={styles.thumbWrap}>
                    <Image source={{ uri: photo.uri }} style={styles.thumb} />
                    <Pressable
                      onPress={() => removePhoto(draft.key, photo.key)}
                      accessibilityRole="button"
                      accessibilityLabel="Remove this photo"
                      hitSlop={space.sm}
                      style={({ pressed }) => [styles.thumbRemove, pressed && styles.pressed]}
                    >
                      <Feather name="x" size={14} color={color.onDark} />
                    </Pressable>
                  </View>
                ))}
              </View>
            ) : null}

            <View style={styles.pair}>
              <Pressable
                onPress={() => void addPhoto(draft.key, 'camera')}
                accessibilityRole="button"
                accessibilityLabel="Take a photo of this defect"
                style={({ pressed }) => [styles.photoButton, pressed && styles.pressed]}
              >
                <Feather name="camera" size={18} color={color.navy} />
                <Text style={styles.photoLabel}>Take photo</Text>
              </Pressable>
              <Pressable
                onPress={() => void addPhoto(draft.key, 'library')}
                accessibilityRole="button"
                accessibilityLabel="Choose a photo of this defect"
                style={({ pressed }) => [styles.photoButton, pressed && styles.pressed]}
              >
                <Feather name="image" size={18} color={color.navy} />
                <Text style={styles.photoLabel}>Choose photo</Text>
              </Pressable>
            </View>
          </Card>
        ))}

        {correctingId ? null : (
          <Pressable
            onPress={() =>
              setSquawks((all) => [
                ...all,
                { key: `${Date.now()}-${all.length}`, summary: '', details: '', grounds: false, photos: [] },
              ])
            }
            accessibilityRole="button"
            accessibilityLabel="Add a squawk"
            style={({ pressed }) => [styles.addSquawk, pressed && styles.pressed]}
          >
            <Feather name="plus" size={18} color={color.navy} />
            <Text style={styles.addSquawkLabel}>Add squawk</Text>
          </Pressable>
        )}

        {!correctingId && squawks.length > 0 ? (
          // §3.6: the squawk log is read back after an accident, so it is not
          // something anyone edits later. Said before the tap, not after.
          <Body muted>What you report stays as written. Anything further is a new squawk.</Body>
        ) : null}

        {/* Notes --------------------------------------------------------- */}
        <Card style={styles.group}>
          {/*
            No placeholder. The suggestion here was a defect ("landing light
            intermittent on taxi"), which is a squawk — its own record, with
            its own severity and its own grounding judgement (§3.6) — and
            putting it in the notes box is where it goes unread. An empty box
            asks the open question it is actually for.
          */}
          <Field label="Notes" compact>
            <Input
              compact
              value={remarks}
              onChangeText={setRemarks}
              multiline
              maxLength={2000}
              style={styles.details}
            />
          </Field>
        </Card>

        {error ? <Notice tone="error">{error}</Notice> : null}

        <Button
          label={correctingId ? 'Save the correction' : 'Save flight'}
          onPress={() => void submit()}
          busy={busy}
        />
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
  // 12 between cards rather than 16: there are five of them, and this screen
  // is one a pilot scrolls with a thumb while standing at a wing.
  container: { padding: space.base, gap: space.md, paddingBottom: space.xxl },

  head: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  // sectionHeading, not pageTitle: the registration is a label on this form,
  // not the form's own title — the navigation bar already names the screen.
  registration: { ...type.sectionHeading, textTransform: 'uppercase', flex: 1 },
  date: { ...type.label },

  group: { gap: space.md },

  /**
   * The meter grid: name, Out, In, Hours.
   *
   * Fixed widths on the two outside columns so the inputs line up down the
   * card and the digits in the Hours column line up with each other, which is
   * what makes a wrong reading visible at a glance.
   */
  meterHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  meterRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  meterName: { ...type.label, width: 46 },
  meterInput: { flex: 1, textAlign: 'center' },
  columnLabel: { ...type.supporting, color: color.secondary, flex: 1, textAlign: 'center' },
  hoursLabel: { ...type.supporting, color: color.secondary, width: 44, textAlign: 'right' },
  hoursValue: {
    ...type.label,
    width: 44,
    textAlign: 'right',
    fontVariant: ['tabular-nums'],
  },

  pair: { flexDirection: 'row', gap: space.md },
  half: { flex: 1 },
  place: { ...type.supporting, color: color.secondary, marginTop: space.xs },
  // 72, not 96: three lines is more than anybody types standing at a wing,
  // and the field grows under the keyboard anyway once it is focused.
  details: { height: 72, paddingTop: space.sm, textAlignVertical: 'top' },
  pressed: { opacity: 0.7 },

  squawkHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  // Secondary, not primary: "Save flight" is the one dominant action on this
  // screen (§11 §6), and adding a squawk is a step towards it rather than a
  // second way of finishing.
  addSquawk: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    height: 48,
    borderRadius: radius.control,
    borderWidth: 1,
    borderColor: color.control,
    backgroundColor: color.surface,
  },
  addSquawkLabel: { ...type.button },
  remove: { paddingVertical: space.sm },
  removeLabel: { ...type.button, color: color.secondary },

  photos: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  thumbWrap: { position: 'relative' },
  thumb: {
    width: 72,
    height: 72,
    borderRadius: radius.control,
    // A photograph of an engine bay is dark and a photograph of a wing in
    // sunlight is nearly white; a border is what keeps both visible on mist.
    borderWidth: 1,
    borderColor: color.line,
    backgroundColor: color.mist,
  },
  thumbRemove: {
    position: 'absolute',
    top: -6,
    right: -6,
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.navy,
  },
  photoButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    height: 44,
    borderRadius: radius.control,
    borderWidth: 1,
    borderColor: color.control,
    backgroundColor: color.surface,
  },
  photoLabel: { ...type.button },

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
