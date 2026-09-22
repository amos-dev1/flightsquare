import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import type {
  AircraftAvailabilityResponse,
  AircraftResponse,
  ReservationResponse,
} from '@flightsquare/shared';

import { Body, Button, Card, Choice, Field, Input, Notice, SectionHeading, Status } from '@/components/ui';
import { api, messageFor, withAuth } from '@/lib/api';
import { color, space, type } from '@/theme';

/**
 * The shared calendar, and taking a slot in it.
 *
 * Seven days, because a phone is used to answer "is it free on Saturday",
 * not to plan a quarter — the web has the month view for that.
 *
 * **The whole club's bookings, not just this pilot's.** §4.4 gives a Pilot
 * `reservations: write` with scope `own`, and the policies behind it scope
 * the *writing*: `reservation_own_insert` and `reservation_own_update` are
 * the ones that carry `owns_row`, while SELECT stays tenant-wide. That is
 * what sharing an aeroplane means — you cannot book around other people
 * without seeing them.
 *
 * **Online only, deliberately.** §8.2 queues the writes that must not be lost
 * while standing at an aeroplane: a flight that happened, a defect that was
 * found. A booking is a claim on a shared resource in the future, and one
 * made offline would be granted against a calendar this phone has not seen —
 * the exclusion constraint in §3.3 is what decides, and it can only decide
 * online. So the form refuses rather than queues, and says why.
 */

const DAYS = 7;

export default function Schedule() {
  const [fleet, setFleet] = useState<AircraftResponse[] | null>(null);
  const [availability, setAvailability] = useState<AircraftAvailabilityResponse[]>([]);
  const [reservations, setReservations] = useState<ReservationResponse[]>([]);
  const [offline, setOffline] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [showing, setShowing] = useState<'everyone' | 'mine'>('everyone');

  const [aircraftId, setAircraftId] = useState<string | null>(null);
  const [day, setDay] = useState(today());
  const [from, setFrom] = useState('09:00');
  const [to, setTo] = useState('12:00');
  const [purpose, setPurpose] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [booked, setBooked] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const window = { from: startOfToday(), to: endOfWindow() };
      const [aircraft, dispatch, rows] = await Promise.all([
        withAuth(() => api.listAircraft()),
        withAuth(() => api.availability()),
        withAuth(() => api.listReservations(window)),
      ]);
      setFleet(aircraft);
      setAvailability(dispatch);
      setReservations(rows);
      setOffline(false);
      setAircraftId((current) => current ?? aircraft.find((a) => a.status === 'active')?.id ?? null);
    } catch {
      setOffline(true);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  async function book() {
    if (!aircraftId) return;
    setBusy(true);
    setError(null);
    setBooked(null);
    try {
      const created = await withAuth(() =>
        api.createReservation({
          aircraft_id: aircraftId,
          starts_at: instant(day, from),
          ends_at: instant(day, to),
          ...(purpose.trim() ? { purpose: purpose.trim() } : {}),
        }),
      );
      setBooked(`${created.aircraft_registration} is yours on ${day}, ${from}–${to}.`);
      setPurpose('');
      await load();
    } catch (caught) {
      // A conflict, a grounded aeroplane or a checkout the pilot does not
      // hold all arrive here with the server's own sentence. §8.2: the
      // client never works out whether a slot is free.
      setError(messageFor(caught));
    } finally {
      setBusy(false);
    }
  }

  const active = fleet?.filter((aircraft) => aircraft.status === 'active') ?? [];
  const shown =
    showing === 'mine' ? reservations.filter((r) => r.can_edit && !r.needs_review) : reservations;
  const byDay = groupByDay(shown.filter((r) => r.status !== 'cancelled'));

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
      {offline ? (
        <Notice>
          Offline. This is the calendar as it was, and booking needs a signal —
          a slot can only be claimed against what the server can see.
        </Notice>
      ) : null}

      {active.length > 0 ? (
        <Card>
          <SectionHeading>Book an aircraft</SectionHeading>

          {active.length > 1 ? (
            <View style={styles.field}>
              <Choice
                options={active.map((aircraft) => ({
                  value: aircraft.id,
                  label: aircraft.registration,
                }))}
                value={aircraftId ?? active[0]!.id}
                onChange={setAircraftId}
              />
            </View>
          ) : null}

          {/* §11 wants the aeroplane's dispatch state where the decision is
              made, not one screen away. A grounded one is still listed, and
              the booking is refused by the server if it is tried. */}
          <Dispatch availability={availability} aircraftId={aircraftId} />

          <Field label="Day" hint="YYYY-MM-DD, in the club's own clock.">
            <Input value={day} onChangeText={setDay} autoCapitalize="none" />
          </Field>
          <View style={styles.times}>
            <View style={styles.time}>
              <Field label="From">
                <Input value={from} onChangeText={setFrom} autoCapitalize="none" />
              </Field>
            </View>
            <View style={styles.time}>
              <Field label="Until">
                <Input value={to} onChangeText={setTo} autoCapitalize="none" />
              </Field>
            </View>
          </View>
          <Field label="Purpose" hint="Optional. Useful to whoever looks at the calendar next.">
            <Input value={purpose} onChangeText={setPurpose} placeholder="Local, circuits" />
          </Field>

          {error ? <Notice tone="error">{error}</Notice> : null}
          {booked ? <Notice>{booked}</Notice> : null}

          <View style={styles.field}>
            <Button label="Book it" onPress={() => void book()} busy={busy} disabled={!aircraftId} />
          </View>
        </Card>
      ) : null}

      <View style={styles.viewToggle}>
        <Choice
          options={[
            { value: 'everyone', label: 'Everyone' },
            { value: 'mine', label: 'Mine' },
          ]}
          value={showing}
          onChange={setShowing}
        />
      </View>

      {byDay.length === 0 ? (
        <View style={styles.empty}>
          <SectionHeading>Nothing booked</SectionHeading>
          <Body muted>
            {showing === 'mine'
              ? 'You have nothing in the next week.'
              : 'The next week is clear.'}
          </Body>
        </View>
      ) : null}

      {byDay.map(([date, rows]) => (
        <View key={date} style={styles.day}>
          <Text style={styles.dayLabel}>{dayLabel(date)}</Text>
          {rows.map((reservation) => (
            <Card key={reservation.id}>
              <View style={styles.headline}>
                <Text style={styles.registration}>{reservation.aircraft_registration}</Text>
                {reservation.needs_review ? <Status label="Needs review" emphatic /> : null}
              </View>
              <Text style={styles.slot}>
                {clock(reservation.starts_at)} – {clock(reservation.ends_at)}
              </Text>
              <Text style={styles.meta}>
                {reservation.booked_by_name ?? reservation.booked_by_email ?? 'a member'}
                {reservation.purpose ? ` · ${reservation.purpose}` : ''}
              </Text>

              {reservation.needs_review && reservation.review_reason ? (
                // §3.3: an existing booking is flagged for a person to ring,
                // never cancelled underneath them.
                <Text style={styles.meta}>{reservation.review_reason}</Text>
              ) : null}

              {reservation.can_edit ? (
                <View style={styles.field}>
                  <Button
                    label="Cancel this booking"
                    variant="secondary"
                    onPress={() => {
                      void withAuth(() => api.cancelReservation(reservation.id))
                        .then(load)
                        .catch((caught) => setError(messageFor(caught)));
                    }}
                  />
                </View>
              ) : null}
            </Card>
          ))}
        </View>
      ))}
    </ScrollView>
  );
}

function Dispatch({
  availability,
  aircraftId,
}: {
  availability: AircraftAvailabilityResponse[];
  aircraftId: string | null;
}) {
  const state = availability.find((row) => row.aircraft_id === aircraftId);
  if (!state) return null;

  return state.available ? (
    <View style={styles.field}>
      <Status label="Available" />
    </View>
  ) : (
    <View style={styles.field}>
      <Status label="Grounded" emphatic />
      {state.grounding_reasons.map((reason) => (
        <Text key={reason} style={styles.meta}>
          {reason}
        </Text>
      ))}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Dates, kept deliberately dumb
//
// The device's own zone, because the phone is at the aeroplane and that is
// the clock the pilot is reading. The server stores instants (§6) and the web
// renders the club's configured zone; a pilot standing at the field does not
// need the distinction, and inventing a zone picker here would be a worse
// answer than the one their watch gives.
// ---------------------------------------------------------------------------

function today(): string {
  return new Date().toLocaleDateString('en-CA');
}

function startOfToday(): string {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return now.toISOString();
}

function endOfWindow(): string {
  const end = new Date();
  end.setDate(end.getDate() + DAYS);
  end.setHours(23, 59, 59, 0);
  return end.toISOString();
}

function instant(day: string, time: string): string {
  return new Date(`${day}T${time}:00`).toISOString();
}

function clock(instantString: string): string {
  return new Date(instantString).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function dayLabel(day: string): string {
  return new Date(`${day}T12:00:00`).toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'short',
  });
}

function groupByDay(rows: ReservationResponse[]): [string, ReservationResponse[]][] {
  const days = new Map<string, ReservationResponse[]>();
  for (const row of [...rows].sort((a, b) => a.starts_at.localeCompare(b.starts_at))) {
    const key = new Date(row.starts_at).toLocaleDateString('en-CA');
    days.set(key, [...(days.get(key) ?? []), row]);
  }
  return [...days.entries()];
}

const styles = StyleSheet.create({
  container: { padding: space.base, gap: space.md },
  field: { marginTop: space.md },
  times: { flexDirection: 'row', gap: space.md },
  time: { flex: 1 },
  viewToggle: { marginTop: space.sm },
  empty: { gap: space.sm, paddingVertical: space.lg },
  day: { gap: space.sm },
  dayLabel: { ...type.sectionHeading, marginTop: space.sm },
  headline: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  registration: { ...type.cardHeading, flex: 1 },
  slot: { ...type.body, marginTop: space.xs },
  meta: { ...type.supporting, color: color.secondary, marginTop: space.xs },
});
