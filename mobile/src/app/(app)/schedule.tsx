import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import type {
  AircraftAvailabilityResponse,
  AircraftResponse,
  BlackoutResponse,
  ReservationResponse,
} from '@flightsquare/shared';
import { addDays, dayIn, dayLabel, startOfWeek, timeIn, todayIn } from '@flightsquare/shared/time';

import { AircraftThumbnail } from '@/components/aircraft';
import { Body, Notice, Picker, SectionHeading } from '@/components/ui';
import { Sheet } from '@/components/sheet';
import { WeekStrip, type DayMarks } from '@/components/week';
import { api, withAuth } from '@/lib/api';
import { usePermission } from '@/lib/entitlements';
import { color, radius, space, type } from '@/theme';

/**
 * The week.
 *
 * A club asks "who has it Saturday", so the week is the unit and the current
 * one is where this opens. The strip says which days have something on them;
 * the day below says what. Tapping a day shows it, and booking starts from
 * the day you are looking at rather than from a form sitting above the
 * calendar it is meant to follow from.
 *
 * **Everything here is in the club's zone, not the phone's.** Which day a
 * booking falls on is a question about the field, and the web has always
 * answered it that way; the phone used to answer it with whatever the phone
 * was set to, which is invisible in a flat list of the next seven days and
 * wrong the moment either client draws a calendar. The zone is named on
 * screen so nobody has to guess which clock they are reading (§11 §11).
 *
 * §8.2: nothing here works out whether a slot is free. The exclusion
 * constraint decides that, inside the transaction that does the insert.
 */
export default function Schedule() {
  /**
   * Where to open.
   *
   * The dashboard and an aircraft's screen send an aeroplane; a booking that
   * lost its slot sends both, so the calendar opens on the day that was
   * refused with that aeroplane already filtered — which is the whole point
   * of following the refusal here rather than just saying no.
   */
  const { aircraft: preselected, date: requested } = useLocalSearchParams<{
    aircraft?: string;
    date?: string;
  }>();

  const [zone, setZone] = useState('UTC');
  /**
   * The same value, reachable from `load` without putting it in the
   * dependency list — which would change `load`'s identity the first time
   * the zone arrived and send the focus effect round a second time.
   */
  const zoneRef = useRef('UTC');
  const [anchor, setAnchor] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [aircraftId, setAircraftId] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [showing, setShowing] = useState<'everyone' | 'mine'>('everyone');

  const [fleet, setFleet] = useState<AircraftResponse[]>([]);
  const [availability, setAvailability] = useState<AircraftAvailabilityResponse[]>([]);
  const [reservations, setReservations] = useState<ReservationResponse[]>([]);
  const [blackouts, setBlackouts] = useState<BlackoutResponse[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [offline, setOffline] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // The client's job is to hide what it would only be refused (§8.1); the
  // endpoint checks this itself either way.
  const canBook = usePermission('reservations') === 'write';

  const week = useMemo(() => {
    if (!anchor) return null;
    const first = startOfWeek(anchor);
    return { first, days: Array.from({ length: 7 }, (_, i) => addDays(first, i)) };
  }, [anchor]);

  /**
   * Apply the route's parameters when they change, and only then.
   *
   * This screen is a tab and stays mounted, so its state outlives any single
   * navigation — arriving a second time with a different aeroplane has to win
   * over the filter left from the first, while an ordinary re-focus must not
   * reset what somebody has since chosen. The key is what distinguishes the
   * two.
   */
  const applied = useRef('');
  useEffect(() => {
    const key = `${requested ?? ''}|${preselected ?? ''}`;
    if (key === applied.current) return;
    applied.current = key;
    if (requested) {
      setAnchor(requested);
      setSelected(requested);
    }
    if (preselected) setAircraftId(preselected);
  }, [requested, preselected]);

  const load = useCallback(
    async (forAnchor: string | null) => {
      try {
        /**
         * The club's zone decides the whole window, so it is fetched before
         * the rest rather than beside it — a week measured in the wrong zone
         * is the wrong week.
         *
         * It is allowed to fail on its own, though. The zone is how the week
         * is *rendered*; the bookings are what the screen is for, and one
         * unlucky call should not blank a calendar that four other calls
         * would have filled. Whatever was known last stays, which on a
         * second load is the club's real zone and on a first is UTC.
         */
        const club = await withAuth(() => api.tenant()).catch(() => null);
        const clubZone = club?.timezone || zoneRef.current;
        zoneRef.current = clubZone;
        setZone(clubZone);

        const today = todayIn(clubZone);
        const at = forAnchor ?? today;
        const first = startOfWeek(at);

        /**
         * A day either side, the way the web over-fetches: the window is a
         * half-open overlap (`ends_at > from AND starts_at < to`), so a
         * booking straddling Monday midnight belongs to the week on screen
         * and has to come back with it.
         */
        const window = {
          from: `${addDays(first, -1)}T00:00:00Z`,
          to: `${addDays(first, 8)}T00:00:00Z`,
        };
        const narrowed = aircraftId ? { aircraftId } : {};

        const [aircraft, dispatch, rows, held] = await Promise.all([
          withAuth(() => api.listAircraft()),
          withAuth(() => api.availability()).catch(() => []),
          withAuth(() =>
            api.listReservations({
              ...window,
              ...narrowed,
              // "Mine" asked of the server rather than guessed from
              // `can_edit` — an admin may edit everybody's, so the old proxy
              // showed an admin the whole club under a filter saying Mine.
              ...(showing === 'mine' ? { mine: true } : {}),
            }),
          ),
          // An aeroplane held for an annual is not free, and a calendar that
          // leaves that out says it is (§3.3).
          withAuth(() => api.listBlackouts({ ...window, ...narrowed })).catch(
            () => [] as BlackoutResponse[],
          ),
        ]);

        setFleet(aircraft);
        setAvailability(dispatch);
        setReservations(rows);
        setBlackouts(held);
        setOffline(false);

        setAnchor((current) => current ?? at);
        setSelected((current) => {
          if (current && current >= first && current <= addDays(first, 6)) return current;
          // Today when it is in the week being shown, its Monday otherwise.
          return today >= first && today <= addDays(first, 6) ? today : first;
        });
        // A filter pointing at an aeroplane that has been archived, or that
        // a parameter named wrongly, would narrow every query to nothing and
        // show an empty week that is not empty. Correct it to all aircraft.
        setAircraftId((current) =>
          current && aircraft.some((a) => a.id === current && a.status === 'active')
            ? current
            : null,
        );
      } catch {
        // No signal. Whatever loaded last stays — this is a field app, and an
        // empty week would read as a free one.
        setOffline(true);
      } finally {
        setLoaded(true);
      }
    },
    [aircraftId, showing],
  );

  useFocusEffect(
    useCallback(() => {
      void load(anchor);
      // Keyed on the week and the filters, so stepping a week refetches and
      // coming back from a booking refreshes the week you were on.
    }, [load, anchor]),
  );

  const today = todayIn(zone);
  const active = fleet.filter((one) => one.status === 'active');
  const chosen = active.find((one) => one.id === aircraftId) ?? null;
  const thisWeek = week !== null && today >= week.first && today <= addDays(week.first, 6);

  /** Everything on a given day, in the club's zone, ordered by start. */
  const onDay = useCallback(
    (day: string) => ({
      // A blackout spans days; a booking is filed under the day it starts,
      // the way the web files it.
      blackouts: blackouts.filter(
        (b) => dayIn(b.starts_at, zone) <= day && dayIn(b.ends_at, zone) >= day,
      ),
      bookings: reservations
        .filter((r) => dayIn(r.starts_at, zone) === day)
        .sort((a, b) => a.starts_at.localeCompare(b.starts_at)),
    }),
    [reservations, blackouts, zone],
  );

  const marksFor = useCallback(
    (day: string): DayMarks => {
      const { bookings, blackouts: held } = onDay(day);
      return { bookings: bookings.length, blackouts: held.length };
    },
    [onDay],
  );

  const day = selected ? onDay(selected) : { bookings: [], blackouts: [] };

  return (
    <>
      <ScrollView
        contentContainerStyle={styles.container}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              void load(anchor).finally(() => setRefreshing(false));
            }}
          />
        }
      >
        {offline ? (
          <Notice>Offline. This is the calendar as it was, and booking needs a signal.</Notice>
        ) : null}

        {/* The week, and how to move between them ---------------------- */}
        {week ? (
          <>
            <View style={styles.weekHead}>
              <Step
                icon="chevron-left"
                label="Previous week"
                onPress={() => setAnchor(addDays(week.first, -7))}
              />
              <View style={styles.range}>
                <Text style={styles.rangeLabel}>
                  {dayLabel(week.first)} – {dayLabel(addDays(week.first, 6))}
                </Text>
                {/* §11: the zone is named, because a bare clock time is
                    ambiguous the moment two members are in different ones. */}
                <Text style={styles.zone}>Times at {zone}</Text>
              </View>
              <Step
                icon="chevron-right"
                label="Next week"
                onPress={() => setAnchor(addDays(week.first, 7))}
              />
            </View>

            <WeekStrip
              days={week.days}
              selected={selected ?? week.first}
              today={today}
              marksFor={marksFor}
              onSelect={setSelected}
            />
          </>
        ) : null}

        <View style={styles.controls}>
          <View style={styles.filters}>
            {(['everyone', 'mine'] as const).map((option) => (
              <Pressable
                key={option}
                onPress={() => setShowing(option)}
                accessibilityRole="button"
                accessibilityState={{ selected: showing === option }}
                hitSlop={space.sm}
              >
                <Text style={[styles.filter, showing === option && styles.filterOn]}>
                  {option === 'everyone' ? 'Everyone' : 'Mine'}
                </Text>
              </Pressable>
            ))}

            {active.length > 1 ? (
              /*
                Compact, because it shares a row with the everyone/mine toggle
                and a full-height labelled control would unbalance it — but the
                same control boundary and the same chevron as the Dashboard and
                Book pickers (§11 §8). It names what it changes, so the chip
                reads as a control rather than as a statement of what is shown.
              */
              <Picker
                compact
                onPress={() => setPicking(true)}
                label={
                  chosen ? `Showing ${chosen.registration}. Change aircraft` : 'Filter by aircraft'
                }
              >
                <View style={styles.aircraftFilterText}>
                  <Text style={styles.aircraftFilterPrefix}>Aircraft</Text>
                  <Text style={styles.aircraftFilterLabel} numberOfLines={1}>
                    {chosen ? chosen.registration : 'All'}
                  </Text>
                </View>
              </Picker>
            ) : null}
          </View>

          {/* Absent when it would do nothing: this week is already showing. */}
          {week && !thisWeek ? (
            <Pressable
              onPress={() => {
                setAnchor(today);
                setSelected(today);
              }}
              accessibilityRole="button"
              accessibilityLabel="Go to this week"
              hitSlop={space.sm}
              style={({ pressed }) => [styles.link, pressed && styles.pressed]}
            >
              <Text style={styles.linkLabel}>Today</Text>
            </Pressable>
          ) : null}
        </View>

        {/* The selected day -------------------------------------------- */}
        {selected ? (
          <View style={styles.dayHead}>
            <SectionHeading>{dayLabel(selected)}</SectionHeading>
            {canBook && active.length > 0 ? (
              <Pressable
                onPress={() =>
                  router.push({
                    pathname: '/book',
                    params: { date: selected, ...(aircraftId ? { aircraft: aircraftId } : {}) },
                  })
                }
                accessibilityRole="button"
                accessibilityLabel={`Book an aircraft on ${dayLabel(selected)}`}
                hitSlop={space.sm}
                style={({ pressed }) => [styles.book, pressed && styles.pressed]}
              >
                <Feather name="plus" size={16} color={color.onDark} />
                <Text style={styles.bookLabel}>Book</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}

        {/* Held first: an aeroplane out for an annual is not a booking. */}
        {day.blackouts.map((blackout) => (
          <View key={blackout.id} style={[styles.card, styles.blackout]}>
            <View style={styles.rowHead}>
              <Feather name="slash" size={16} color={color.secondary} />
              <Text style={styles.registration}>{blackout.aircraft_registration}</Text>
              <Text style={styles.unavailable}>Unavailable</Text>
            </View>
            <Text style={styles.meta}>{blackout.reason}</Text>
            <Text style={styles.meta}>
              {dayIn(blackout.starts_at, zone) === dayIn(blackout.ends_at, zone)
                ? `${timeIn(blackout.starts_at, zone)} – ${timeIn(blackout.ends_at, zone)}`
                : `${dayLabel(dayIn(blackout.starts_at, zone))} to ${dayLabel(
                    dayIn(blackout.ends_at, zone),
                  )}`}
            </Text>
          </View>
        ))}

        {/*
          One row per booking, each naming its aeroplane.

          That is the whole answer to two aircraft at the same hour: they are
          two rows that say which is which. It is complete rather than a
          simplification — the exclusion constraint makes it impossible for
          *one* aeroplane to overlap itself, so an overlap on screen is
          always different aircraft, and narrowing to one makes overlap
          impossible by construction. Colour could not help anyway: §11 keeps
          the palette monochrome with teal reserved for selection and forbids
          colour as the only carrier, so the registration is the identifier.
        */}
        {day.bookings.map((reservation) => (
          <Pressable
            key={reservation.id}
            onPress={() =>
              router.push({ pathname: '/reservation', params: { id: reservation.id } })
            }
            accessibilityRole="button"
            accessibilityLabel={`${reservation.aircraft_registration}, ${timeIn(
              reservation.starts_at,
              zone,
            )} to ${timeIn(reservation.ends_at, zone)}, ${
              reservation.booked_by_name ?? reservation.booked_by_email ?? 'a member'
            }`}
            style={({ pressed }) => [styles.card, pressed && styles.pressed]}
          >
            <View style={styles.rowHead}>
              <Text style={styles.slot}>
                {timeIn(reservation.starts_at, zone)} – {timeIn(reservation.ends_at, zone)}
              </Text>
              <Text style={styles.registration}>{reservation.aircraft_registration}</Text>
              <Feather name="chevron-right" size={18} color={color.secondary} />
            </View>

            <Text style={styles.meta}>
              {reservation.booked_by_name ?? reservation.booked_by_email ?? 'a member'}
              {reservation.purpose ? ` · ${reservation.purpose}` : ''}
            </Text>

            {reservation.needs_review ? (
              /* §3.3: a grounding flags future bookings for somebody to ring,
                 and never cancels one underneath the member who made it. */
              <View style={styles.review}>
                <Feather name="alert-triangle" size={14} color={color.navy} />
                <Text style={styles.reviewText}>
                  {reservation.review_reason ?? 'Needs review'}
                </Text>
              </View>
            ) : null}
          </Pressable>
        ))}

        {loaded && selected && day.bookings.length === 0 && day.blackouts.length === 0 ? (
          <View style={styles.empty}>
            <Body muted>
              {showing === 'mine'
                ? 'You have nothing booked this day.'
                : chosen
                  ? `${chosen.registration} is free all day.`
                  : 'Nothing booked.'}
            </Body>
          </View>
        ) : null}

        {loaded && active.length === 0 ? (
          <View style={styles.empty}>
            <SectionHeading>No aircraft yet</SectionHeading>
            <Body muted>There is nothing to book until an aircraft is added.</Body>
          </View>
        ) : null}
      </ScrollView>

      <Sheet visible={picking} title="Show aircraft" onClose={() => setPicking(false)}>
        <Option
          label="All aircraft"
          detail="Everything booked this week"
          // §11 reserves uppercase for registrations; this is a sentence.
          registration={false}
          chosen={aircraftId === null}
          onPress={() => {
            setAircraftId(null);
            setPicking(false);
          }}
        />
        {active.map((one) => (
          <Option
            key={one.id}
            label={one.registration}
            detail={one.type_code ?? 'Type not recorded'}
            grounded={availability.find((a) => a.aircraft_id === one.id)?.available === false}
            chosen={aircraftId === one.id}
            onPress={() => {
              setAircraftId(one.id);
              setPicking(false);
            }}
          />
        ))}
      </Sheet>
    </>
  );
}

function Step({
  icon,
  label,
  onPress,
}: {
  icon: 'chevron-left' | 'chevron-right';
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={space.sm}
      style={({ pressed }) => [styles.step, pressed && styles.pressed]}
    >
      <Feather name={icon} size={22} color={color.navy} />
    </Pressable>
  );
}

function Option({
  label,
  detail,
  chosen,
  grounded,
  registration = true,
  onPress,
}: {
  label: string;
  detail: string;
  chosen: boolean;
  grounded?: boolean;
  /** Whether the label is a tail number, which §11 sets in uppercase. */
  registration?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected: chosen }}
      style={({ pressed }) => [
        styles.option,
        chosen && styles.optionChosen,
        pressed && styles.pressed,
      ]}
    >
      <AircraftThumbnail size="small" />
      <View style={styles.optionText}>
        <Text style={[styles.optionLabel, registration && styles.optionRegistration]}>
          {label}
        </Text>
        <Text style={styles.meta}>{detail}</Text>
        {/* Stated, not implied by an absence (§11 §11). */}
        {grounded ? <Text style={styles.meta}>Grounded</Text> : null}
      </View>
      {chosen ? <Feather name="check" size={20} color={color.tealText} /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { padding: space.base, paddingBottom: space.xxl, gap: space.md },
  pressed: { opacity: 0.7 },

  weekHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  step: { padding: space.sm, borderRadius: radius.control },
  range: { flex: 1, alignItems: 'center' },
  rangeLabel: { ...type.cardHeading },
  zone: { ...type.supporting, fontSize: 12, color: color.secondary },

  controls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  link: { paddingVertical: space.xs },
  linkLabel: { ...type.button, color: color.tealText },
  filters: { flexDirection: 'row', alignItems: 'center', gap: space.base },
  filter: { ...type.label, color: color.secondary, paddingVertical: space.xs },
  // Weight and a teal rule, so the selected filter is never colour alone.
  filterOn: { color: color.navy, borderBottomWidth: 2, borderBottomColor: color.teal },
  // Two Text nodes rather than one with a nested span: §11 reserves uppercase
  // for registrations, and the word that names the control is not one. Siblings
  // keep that unambiguous without relying on a nested textTransform overriding
  // its parent.
  aircraftFilterText: { flexDirection: 'row', alignItems: 'center', gap: space.xs, flexShrink: 1 },
  aircraftFilterPrefix: { ...type.label, color: color.secondary },
  aircraftFilterLabel: { ...type.label, textTransform: 'uppercase', flexShrink: 1 },

  dayHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: space.sm,
  },
  book: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    height: 36,
    paddingHorizontal: space.md,
    borderRadius: radius.control,
    backgroundColor: color.navy,
  },
  bookLabel: { ...type.button, color: color.onDark },

  card: {
    backgroundColor: color.surface,
    borderColor: color.line,
    borderWidth: 1,
    borderRadius: radius.card,
    padding: space.base,
    gap: space.xs,
  },
  // Mist rather than white: it is time taken off the calendar, not a booking.
  blackout: { backgroundColor: color.subtle },
  rowHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  slot: { ...type.cardHeading, fontVariant: ['tabular-nums'] },
  registration: { ...type.cardHeading, flex: 1, textTransform: 'uppercase' },
  unavailable: { ...type.supporting, color: color.secondary },
  meta: { ...type.supporting, color: color.secondary },
  review: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, marginTop: space.xs },
  reviewText: { ...type.supporting, flex: 1 },

  empty: { gap: space.sm, paddingVertical: space.lg },

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
  optionText: { flex: 1, gap: 2 },
  optionLabel: { ...type.cardHeading },
  optionRegistration: { textTransform: 'uppercase' },
});
