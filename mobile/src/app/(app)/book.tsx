import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import DateTimePicker from '@react-native-community/datetimepicker';
import type { AircraftAvailabilityResponse, AircraftResponse } from '@flightsquare/shared';
import { dayLabel, timeIn, zonedToInstant } from '@flightsquare/shared/time';

import { AircraftThumbnail } from '@/components/aircraft';
import { Body, Button, Card, Field, Input, Notice, SectionHeading } from '@/components/ui';
import { Sheet } from '@/components/sheet';
import { api, messageFor, withAuth } from '@/lib/api';
import { usePermission } from '@/lib/entitlements';
import { color, radius, space, type } from '@/theme';

/**
 * Taking a slot.
 *
 * Its own screen now, reached from the day you were looking at, rather than a
 * form sitting above the calendar. The date arrives filled in because you
 * chose it by tapping it.
 *
 * **Wall clock, not instants.** The pickers below are set to a date and a
 * time the *club* would say out loud — "Saturday, nine in the morning" — and
 * `zonedToInstant` turns that into the moment it names. The native picker
 * hands back a `Date` in the phone's zone, so only its wall-clock parts are
 * read; treating its value as an instant is the easy mistake and books the
 * wrong hour for anybody outside the club's zone.
 *
 * §8.2: nothing here decides whether the slot is free. A clash, a grounded
 * aeroplane or a checkout the pilot does not hold all come back from the
 * server in its own words, because the database is what refuses them.
 */
export default function Book() {
  const { date, aircraft: preselected } = useLocalSearchParams<{
    date?: string;
    aircraft?: string;
  }>();

  const canBook = usePermission('reservations') === 'write';

  const [zone, setZone] = useState('UTC');
  const [fleet, setFleet] = useState<AircraftResponse[]>([]);
  const [availability, setAvailability] = useState<AircraftAvailabilityResponse[]>([]);
  const [aircraftId, setAircraftId] = useState<string | null>(preselected ?? null);
  const [picking, setPicking] = useState(false);

  /**
   * Wall-clock values, held as the parts a person picked rather than as
   * instants. `day` is the plain date the calendar sent; `from` and `to` are
   * "HH:MM" in the club's zone.
   */
  const [day, setDay] = useState(date ?? '');
  const [from, setFrom] = useState('09:00');
  const [to, setTo] = useState('12:00');
  const [showing, setShowing] = useState<'day' | 'from' | 'to' | null>(null);

  const [purpose, setPurpose] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const [club, aircraft, dispatch] = await Promise.all([
          withAuth(() => api.tenant()),
          withAuth(() => api.listAircraft()),
          withAuth(() => api.availability()).catch(() => []),
        ]);
        setZone(club.timezone || 'UTC');
        setFleet(aircraft);
        setAvailability(dispatch);
        setAircraftId((current) => {
          if (current && aircraft.some((a) => a.id === current && a.status === 'active')) {
            return current;
          }
          return aircraft.find((a) => a.status === 'active')?.id ?? null;
        });
        if (!date) setDay(new Date().toISOString().slice(0, 10));
      } catch (caught) {
        setError(messageFor(caught));
      }
    })();
  }, [date]);

  const active = fleet.filter((one) => one.status === 'active');
  const chosen = active.find((one) => one.id === aircraftId) ?? null;
  const dispatch = availability.find((row) => row.aircraft_id === aircraftId);

  async function book() {
    if (!aircraftId || !day) return;
    setBusy(true);
    setError(null);
    try {
      await withAuth(() =>
        api.createReservation({
          aircraft_id: aircraftId,
          // The club's clock, turned into the instant it names.
          starts_at: zonedToInstant(day, from, zone).toISOString(),
          ends_at: zonedToInstant(day, to, zone).toISOString(),
          ...(purpose.trim() ? { purpose: purpose.trim() } : {}),
        }),
      );
      // Back to the week, which reloads on focus and will show it.
      router.back();
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(false);
    }
  }

  if (!canBook) {
    return (
      <View style={styles.denied}>
        <SectionHeading>Booking is not yours to do</SectionHeading>
        <Body muted>
          This account has you on the calendar as a reader. An administrator can
          change that.
        </Body>
      </View>
    );
  }

  return (
    <>
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        {/* Which aeroplane -------------------------------------------- */}
        <Card style={styles.group}>
          <SectionHeading>Aircraft</SectionHeading>
          <Pressable
            onPress={() => setPicking(true)}
            disabled={active.length <= 1}
            accessibilityRole={active.length > 1 ? 'button' : undefined}
            accessibilityLabel={
              chosen ? `${chosen.registration}. Change aircraft` : 'Choose an aircraft'
            }
            style={({ pressed }) => [styles.chooser, pressed && styles.pressed]}
          >
            <AircraftThumbnail size="small" />
            <View style={styles.chooserText}>
              <Text style={styles.registration}>{chosen?.registration ?? 'Choose one'}</Text>
              <Text style={styles.meta}>{chosen?.type_code ?? 'Type not recorded'}</Text>
            </View>
            {active.length > 1 ? (
              <Feather name="chevron-down" size={20} color={color.navy} />
            ) : null}
          </Pressable>

          {/*
            §3.3: dispatch state is the server's one resolved view, and the
            booking trigger reads the same thing — so a grounded aeroplane
            says so here rather than only in the refusal.
          */}
          {dispatch && !dispatch.available ? (
            <Notice tone="error">
              {dispatch.grounding_reasons.join('\n') || 'This aircraft is grounded.'}
            </Notice>
          ) : null}
        </Card>

        {/* When -------------------------------------------------------- */}
        <Card style={styles.group}>
          <SectionHeading>When</SectionHeading>
          <Body muted>Times are the club’s own clock, at {zone}.</Body>

          <Slot
            label="Day"
            value={day ? dayLabel(day) : 'Choose a day'}
            onPress={() => setShowing(showing === 'day' ? null : 'day')}
            open={showing === 'day'}
          />
          <View style={styles.pair}>
            <View style={styles.half}>
              <Slot
                label="From"
                value={from}
                onPress={() => setShowing(showing === 'from' ? null : 'from')}
                open={showing === 'from'}
              />
            </View>
            <View style={styles.half}>
              <Slot
                label="Until"
                value={to}
                onPress={() => setShowing(showing === 'to' ? null : 'to')}
                open={showing === 'to'}
              />
            </View>
          </View>

          {showing ? (
            <DateTimePicker
              value={pickerValue(day, showing === 'day' ? from : showing === 'from' ? from : to)}
              mode={showing === 'day' ? 'date' : 'time'}
              display={Platform.OS === 'ios' ? 'spinner' : 'default'}
              minuteInterval={15}
              // `onValueChange`, not the deprecated `onChange` that also
              // reports dismissals through an event type.
              onValueChange={(_, picked) => {
                // Android's dialog is modal and closes itself; the iOS
                // spinner stays open under the field it belongs to.
                if (Platform.OS !== 'ios') setShowing(null);
                if (!picked) return;
                // Only the wall-clock parts. The picker's instant belongs to
                // the phone's zone and is not what was chosen.
                if (showing === 'day') setDay(plainDate(picked));
                else if (showing === 'from') setFrom(plainTime(picked));
                else setTo(plainTime(picked));
              }}
              onDismiss={() => setShowing(null)}
            />
          ) : null}
        </Card>

        <Card style={styles.group}>
          <Field label="Purpose" hint="Useful to whoever looks at the calendar next.">
            <Input value={purpose} onChangeText={setPurpose} placeholder="Local, circuits" />
          </Field>
        </Card>

        {error ? <Notice tone="error">{error}</Notice> : null}

        <Button
          label="Book it"
          onPress={() => void book()}
          busy={busy}
          disabled={!aircraftId || !day}
        />
        {/*
          Reservations are deliberately outside the offline queue: a booking
          that quietly waits for signal is a booking somebody thinks they
          have, and the slot may be gone by the time it sends.
        */}
        <Body muted>Booking needs a signal. Nothing here is saved for later.</Body>
      </ScrollView>

      <Sheet visible={picking} title="Choose aircraft" onClose={() => setPicking(false)}>
        {active.map((one) => {
          const state = availability.find((row) => row.aircraft_id === one.id);
          const isChosen = one.id === aircraftId;
          return (
            <Pressable
              key={one.id}
              onPress={() => {
                setAircraftId(one.id);
                setPicking(false);
              }}
              accessibilityRole="radio"
              accessibilityState={{ selected: isChosen }}
              style={({ pressed }) => [
                styles.option,
                isChosen && styles.optionChosen,
                pressed && styles.pressed,
              ]}
            >
              <AircraftThumbnail size="small" />
              <View style={styles.chooserText}>
                <Text style={styles.registration}>{one.registration}</Text>
                <Text style={styles.meta}>{one.type_code ?? 'Type not recorded'}</Text>
                {state && !state.available ? <Text style={styles.meta}>Grounded</Text> : null}
              </View>
              {isChosen ? <Feather name="check" size={20} color={color.tealText} /> : null}
            </Pressable>
          );
        })}
      </Sheet>
    </>
  );
}

function Slot({
  label,
  value,
  open,
  onPress,
}: {
  label: string;
  value: string;
  open: boolean;
  onPress: () => void;
}) {
  return (
    <View style={styles.slot}>
      <Text style={styles.slotLabel}>{label}</Text>
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${label}, ${value}`}
        style={({ pressed }) => [
          styles.slotValue,
          open && styles.slotValueOpen,
          pressed && styles.pressed,
        ]}
      >
        <Text style={styles.slotText}>{value}</Text>
        <Feather name={open ? 'chevron-up' : 'chevron-down'} size={18} color={color.secondary} />
      </Pressable>
    </View>
  );
}

/**
 * What to hand the native picker.
 *
 * Built in the *phone's* zone from the wall-clock parts being edited, so the
 * wheels open on what the form already says. The instant it happens to be is
 * meaningless and is never read back.
 */
function pickerValue(day: string, time: string): Date {
  const [year, month, date] = (day || new Date().toISOString().slice(0, 10))
    .split('-')
    .map(Number);
  const [hour, minute] = time.split(':').map(Number);
  return new Date(year!, month! - 1, date!, hour ?? 9, minute ?? 0, 0, 0);
}

/** The picker's wall-clock date, as `YYYY-MM-DD`. Never its instant. */
function plainDate(picked: Date): string {
  const month = String(picked.getMonth() + 1).padStart(2, '0');
  const date = String(picked.getDate()).padStart(2, '0');
  return `${picked.getFullYear()}-${month}-${date}`;
}

/** The picker's wall-clock time, as `HH:MM`. Never its instant. */
function plainTime(picked: Date): string {
  return `${String(picked.getHours()).padStart(2, '0')}:${String(picked.getMinutes()).padStart(
    2,
    '0',
  )}`;
}

const styles = StyleSheet.create({
  container: { padding: space.base, paddingBottom: space.xxl, gap: space.base },
  denied: { padding: space.base, gap: space.sm },
  pressed: { opacity: 0.7 },
  group: { gap: space.base },

  chooser: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: 56 },
  chooserText: { flex: 1, gap: 2 },
  registration: { ...type.cardHeading, textTransform: 'uppercase' },
  meta: { ...type.supporting, color: color.secondary },

  slot: { gap: space.sm },
  slotLabel: { ...type.label },
  slotValue: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 48,
    paddingHorizontal: space.md,
    borderWidth: 1,
    borderColor: color.control,
    borderRadius: radius.control,
    backgroundColor: color.surface,
  },
  slotValueOpen: { borderColor: color.teal, borderWidth: 2 },
  slotText: { ...type.input, fontVariant: ['tabular-nums'] },

  pair: { flexDirection: 'row', gap: space.md },
  half: { flex: 1 },

  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.md,
    borderWidth: 1,
    borderColor: color.line,
    borderRadius: radius.card,
    minHeight: 64,
  },
  optionChosen: { borderColor: color.teal, backgroundColor: color.selected },
});
