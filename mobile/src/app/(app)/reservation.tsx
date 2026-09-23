import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ApiError, type ReservationResponse } from '@flightsquare/shared';

import { Body, Button, Card, Notice, SectionHeading, Status } from '@/components/ui';
import { api, messageFor, withAuth } from '@/lib/api';
import { color, space, type } from '@/theme';

/**
 * One booking.
 *
 * Reached from the dashboard and the calendar. It exists because a row in a
 * list can say when and which aeroplane, and cannot say who else it was
 * booked for, what the note attached to it was, or why the club flagged it —
 * and those are the things somebody opens a booking to find out.
 *
 * Cancelling lives here as well as in the calendar, because this is where
 * somebody ends up when they follow a link from a confirmation email. §10
 * makes cancelling a status rather than a delete: the slot frees the moment
 * it returns, and the booking stays on the record for the club that is
 * arguing about a Saturday.
 */
export default function Reservation() {
  const { id } = useLocalSearchParams<{ id: string }>();

  const [reservation, setReservation] = useState<ReservationResponse | null>(null);
  const [missing, setMissing] = useState(false);
  const [offline, setOffline] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      setReservation(await withAuth(() => api.getReservation(id)));
      setMissing(false);
      setOffline(false);
    } catch (caught) {
      // A 404 and no signal are different answers and get different words.
      if (caught instanceof ApiError && caught.status === 404) setMissing(true);
      else setOffline(true);
    }
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  async function cancel() {
    if (!reservation) return;
    setBusy(true);
    setError(null);
    try {
      setReservation(await withAuth(() => api.cancelReservation(reservation.id)));
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(false);
    }
  }

  if (missing) {
    return (
      <View style={styles.empty}>
        <SectionHeading>Booking not found</SectionHeading>
        <Body muted>It may have been made on another account.</Body>
      </View>
    );
  }

  const cancelled = reservation?.status === 'cancelled';
  // §3.4: "A flight record should be creatable from a completed reservation."
  // Offered once the slot has started, and never for one that was called off.
  const flyable =
    reservation !== null && !cancelled && new Date(reservation.starts_at) <= new Date();

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
      {offline && !reservation ? (
        <Notice>Offline. This booking could not be loaded.</Notice>
      ) : null}
      {offline && reservation ? <Notice>Offline. Showing what loaded last.</Notice> : null}

      {reservation ? (
        <>
          <View style={styles.header}>
            <Text style={styles.registration}>{reservation.aircraft_registration}</Text>
            <Text style={styles.slot}>{dayOf(reservation.starts_at)}</Text>
            <Text style={styles.time}>
              {/* §11: the zone is named. "09:00 – 12:00" alone is ambiguous
                  the moment two members are in different ones. */}
              {clock(reservation.starts_at)} – {clock(reservation.ends_at)} {zone()}
            </Text>
          </View>

          {cancelled ? (
            <Notice>
              This booking was cancelled. The slot is free again; the record
              stays.
            </Notice>
          ) : null}

          {reservation.needs_review && reservation.review_reason ? (
            /*
             * §3.3: when an aircraft is grounded its future bookings are
             * flagged for the club to act on, never cancelled by the system —
             * somebody has to ring those members, and only they know what
             * else was arranged around it.
             */
            <Notice tone="error">{reservation.review_reason}</Notice>
          ) : null}

          <Card>
            <View style={styles.headline}>
              <SectionHeading>Booking</SectionHeading>
              {reservation.needs_review ? <Status label="Needs review" emphatic /> : null}
            </View>

            <Line
              label="Flying"
              /* The booking subject, not whoever filled the form in. */
              value={
                reservation.booked_by_name ?? reservation.booked_by_email ?? 'A member'
              }
            />
            <Line label="Aircraft" value={reservation.aircraft_registration} />
            <Line label="From" value={full(reservation.starts_at)} />
            <Line label="Until" value={full(reservation.ends_at)} />
            <Line label="Purpose" value={reservation.purpose ?? 'Not given'} />
            <Line label="Status" value={statusWord(reservation.status)} />
          </Card>

          {reservation.notes ? (
            <Card>
              <SectionHeading>Notes</SectionHeading>
              <Body>{reservation.notes}</Body>
            </Card>
          ) : null}

          {error ? <Notice tone="error">{error}</Notice> : null}

          {flyable ? (
            <Button
              label="Log this flight"
              onPress={() =>
                router.push({
                  pathname: '/log-flight',
                  params: { aircraft: reservation.aircraft_id },
                })
              }
            />
          ) : null}

          {/* The same question the policy asks, answered by the server so
              this only shows what it would not refuse (§8.1). */}
          {reservation.can_edit && !cancelled ? (
            <Button
              label="Cancel this booking"
              variant="secondary"
              onPress={() => void cancel()}
              busy={busy}
            />
          ) : null}
        </>
      ) : null}
    </ScrollView>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.line}>
      <Text style={styles.lineLabel}>{label}</Text>
      <Text style={styles.lineValue}>{value}</Text>
    </View>
  );
}

/** §10: a status, never a delete — so it is said in words, not implied. */
function statusWord(status: ReservationResponse['status']): string {
  switch (status) {
    case 'cancelled':
      return 'Cancelled';
    case 'completed':
      return 'Completed';
    default:
      return 'Booked';
  }
}

function dayOf(instant: string): string {
  return new Date(instant).toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

function clock(instant: string): string {
  return new Date(instant).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function full(instant: string): string {
  return new Date(instant).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZoneName: 'short',
  });
}

/** Whatever this phone is set to, named rather than assumed. */
function zone(): string {
  const parts = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' }).formatToParts(
    new Date(),
  );
  return parts.find((part) => part.type === 'timeZoneName')?.value ?? '';
}

const styles = StyleSheet.create({
  container: { padding: space.base, gap: space.md },
  empty: { padding: space.base, gap: space.sm },
  header: { gap: space.xs },
  registration: { ...type.pageTitle, textTransform: 'uppercase' },
  slot: { ...type.body, color: color.secondary },
  time: { ...type.sectionHeading, fontVariant: ['tabular-nums'] },
  headline: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
  },
  line: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: space.md,
    marginTop: space.md,
  },
  lineLabel: { ...type.supporting, color: color.secondary, flex: 1 },
  lineValue: { ...type.bodySmall, flexShrink: 1, textAlign: 'right' },
});
