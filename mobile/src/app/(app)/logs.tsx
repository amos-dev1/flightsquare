import { router, useFocusEffect } from 'expo-router';
import Feather from '@expo/vector-icons/Feather';
import { useCallback, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import type {
  AircraftResponse,
  FlightPeriodAndPerson,
  FlightResponse,
  FlightSummaryResponse,
  MemberResponse,
} from '@flightsquare/shared';

import { AircraftThumbnail } from '@/components/aircraft';
import { Body, Card, Choice, Notice, Picker, SectionHeading } from '@/components/ui';
import { Sheet } from '@/components/sheet';
import { api, withAuth } from '@/lib/api';
import { routeOf } from '@/lib/format';
import { usePermission } from '@/lib/entitlements';
import { color, radius, space, type } from '@/theme';

/**
 * Flight logs, by aeroplane.
 *
 * An admin sees everyone's flights on the aircraft; anybody else sees their
 * own. **That is presentation, not a control.** §4.4 gives every member
 * `flights` at scope `all` deliberately — who flew what is how a club
 * reconciles its meters and its money — so the whole list is still reachable
 * through the API. Nothing here should be read as a restriction; making it
 * one is a change to the permission model.
 *
 * The statistics come from the server (§8.2). Adding up the rows on the
 * device would be wrong past 200 flights, which is where the list caps, and
 * wrong in the direction nobody notices.
 */
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** Whose flights: everybody's, the viewer's own, or one member's. */
type Person = { kind: 'everyone' } | { kind: 'me' } | { kind: 'member'; member: MemberResponse };

function personOf(member: MemberResponse): string {
  return member.name ?? member.email;
}

/** Inclusive flight dates for a year, or a month of it. Null is all time. */
function periodOf(year: number | null, month: number | null): FlightPeriodAndPerson {
  if (year === null) return {};
  if (month === null) return { from: `${year}-01-01`, to: `${year}-12-31` };
  const mm = String(month).padStart(2, '0');
  // Day 0 of the next month is the last day of this one.
  const last = new Date(year, month, 0).getDate();
  return { from: `${year}-${mm}-01`, to: `${year}-${mm}-${last}` };
}

export default function Logs() {
  const [fleet, setFleet] = useState<AircraftResponse[] | null>(null);
  const [aircraftId, setAircraftId] = useState<string | null>(null);
  const [flights, setFlights] = useState<FlightResponse[]>([]);
  const [summary, setSummary] = useState<FlightSummaryResponse | null>(null);
  const [offline, setOffline] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [picking, setPicking] = useState(false);

  /*
    Which flights: a year, a month of it, and whose. Filters on the server's
    query (§8.2 — the totals are the server's sums of exactly these), never a
    trim of a 200-row page on the phone.
  */
  const [year, setYear] = useState<number | null>(null);
  const [month, setMonth] = useState<number | null>(null);
  const [person, setPerson] = useState<Person | null>(null);
  const [members, setMembers] = useState<MemberResponse[] | null>(null);
  const [firstYear, setFirstYear] = useState<number | null>(null);
  const [choosing, setChoosing] = useState<'year' | 'month' | 'person' | null>(null);

  // Everyone holds `flights: write` (§4.4) — a club's flights are shared on
  // purpose — so this is about where the button points, not whether it is
  // there. The endpoint checks it either way (§8.1).
  const canLog = usePermission('flights') === 'write';

  // The same test scheduling already calls `administers`.
  const administers = usePermission('aircraft') === 'write';
  // A roster to pick from needs `members: read`, which a Pilot does not
  // hold (§4.4) — so a Pilot chooses between everyone and themselves.
  const canListMembers = usePermission('members') !== 'none';

  // An admin opens on everybody's flights and anybody else on their own, as
  // this screen always has; either can change it.
  const whose: Person = person ?? (administers ? { kind: 'everyone' } : { kind: 'me' });

  const load = useCallback(
    async (selected: string | null) => {
      try {
        const aircraft = await withAuth(() => api.listAircraft());
        setFleet(aircraft);

        const chosen = selected ?? aircraft.find((a) => a.status === 'active')?.id ?? null;
        setAircraftId(chosen);

        const query = {
          ...(chosen ? { aircraftId: chosen } : {}),
          ...(whose.kind === 'me' ? { mine: true } : {}),
          ...(whose.kind === 'member' ? { flownBy: whose.member.id } : {}),
          ...periodOf(year, month),
        };

        const [rows, totals, ever, roster] = await Promise.all([
          withAuth(() => api.listFlights(query)),
          withAuth(() => api.flightSummary(query)),
          // The aeroplane's first flight, unfiltered, so the year list runs
          // back exactly as far as there is anything to see.
          withAuth(() => api.flightSummary(chosen ? { aircraftId: chosen } : {})).catch(() => null),
          canListMembers ? withAuth(() => api.listMembers()).catch(() => null) : null,
        ]);

        setFlights(rows);
        setSummary(totals);
        setFirstYear(ever?.first_flight_date ? Number(ever.first_flight_date.slice(0, 4)) : null);
        if (roster) setMembers(roster);
        setOffline(false);
      } catch {
        setOffline(true);
      }
    },
    // `whose` is rebuilt each render, so its parts are the dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [administers, canListMembers, year, month, whose.kind, whose.kind === 'member' ? whose.member.id : null],
  );

  useFocusEffect(
    useCallback(() => {
      void load(aircraftId);
    }, [load, aircraftId]),
  );

  const active = fleet?.filter((aircraft) => aircraft.status !== 'archived') ?? [];

  const thisYear = new Date().getFullYear();
  const years = Array.from(
    { length: Math.max(1, thisYear - Math.min(firstYear ?? thisYear, thisYear) + 1) },
    (_, i) => thisYear - i,
  );
  const whoseLabel =
    whose.kind === 'everyone' ? 'Everyone' : whose.kind === 'me' ? 'Me' : personOf(whose.member);
  const periodLabel =
    year === null ? 'All time' : month === null ? String(year) : `${MONTHS[month - 1]} ${year}`;
  const filtered = year !== null || whose.kind !== (administers ? 'everyone' : 'me');
  // Who flew it is worth saying on a row whenever the list is not one person's.
  const showPilot = whose.kind === 'everyone';
  const people: Person[] = [
    { kind: 'everyone' },
    ...(members
      ? members.map((member): Person => ({ kind: 'member', member }))
      : [{ kind: 'me' } as Person]),
  ];

  return (
    <ScrollView
      contentContainerStyle={styles.container}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true);
            void load(aircraftId).finally(() => setRefreshing(false));
          }}
        />
      }
    >
      {offline ? <Notice>Offline. Showing the logs loaded last.</Notice> : null}

      {/*
        Logging starts here as well as from an aeroplane's own screen.
        §3.4 calls the post-flight entry the most important screen in the
        product, and a pilot who has just walked in opens the logs — making
        them go and find the aircraft first is the friction that turns into
        stale meters.
      */}
      {canLog && active.length > 0 ? (
        <Pressable
          onPress={() => {
            // One aeroplane is not a choice. More than one is, and asking is
            // better than guessing at a record that advances the meters.
            if (active.length === 1) {
              router.push({ pathname: '/log-flight', params: { aircraft: active[0]!.id } });
            } else {
              setPicking(true);
            }
          }}
          accessibilityRole="button"
          accessibilityLabel={
            active.length === 1
              ? `Log a flight in ${active[0]!.registration}`
              : 'Log a flight, choose an aircraft'
          }
          style={({ pressed }) => [styles.log, pressed && styles.logPressed]}
        >
          <Feather name="plus" size={18} color={color.onDark} />
          <Text style={styles.logLabel}>
            Log flight{active.length === 1 ? ` · ${active[0]!.registration}` : ''}
          </Text>
        </Pressable>
      ) : null}

      {active.length > 1 ? (
        <Choice
          options={active.map((aircraft) => ({
            value: aircraft.id,
            label: aircraft.registration,
          }))}
          value={aircraftId ?? active[0]!.id}
          onChange={(id) => {
            setAircraftId(id);
            void load(id);
          }}
        />
      ) : null}

      {/* Which flights: the period, and whose. */}
      <View style={styles.filters}>
        <Picker compact onPress={() => setChoosing('year')} label={`Year: ${year ?? 'all'}. Change`}>
          <Feather name="calendar" size={16} color={color.secondary} />
          <Text style={styles.filterText}>{year ?? 'All years'}</Text>
        </Picker>
        <Picker
          compact
          disabled={year === null}
          onPress={() => setChoosing('month')}
          label={`Month: ${month ? MONTHS[month - 1] : 'whole year'}. Change`}
        >
          <Text style={[styles.filterText, year === null && styles.filterOff]}>
            {month ? MONTHS[month - 1] : 'All months'}
          </Text>
        </Picker>
        <Picker compact onPress={() => setChoosing('person')} label={`Pilot: ${whoseLabel}. Change`}>
          <Feather name="user" size={16} color={color.secondary} />
          <Text style={styles.filterText} numberOfLines={1}>
            {whoseLabel}
          </Text>
        </Picker>
      </View>

      {summary ? (
        <Card>
          <SectionHeading>
            {whose.kind === 'me' ? 'Your flights' : whoseLabel}
            {active.length === 1 && active[0] ? ` · ${active[0].registration}` : ''}
          </SectionHeading>
          <Text style={styles.range}>{periodLabel}</Text>
          <View style={styles.stats}>
            <Stat label="Flights" value={String(summary.flights)} />
            {/* §11 and §3.4: which meter, said out loud, and neither derived
                from the other. */}
            <Stat label="Hobbs" value={round(summary.hobbs_hours)} unit="hrs" />
            <Stat label="Tach" value={round(summary.tach_hours)} unit="hrs" />
          </View>
          {summary.first_flight_date ? (
            <Text style={styles.range}>
              {summary.first_flight_date} to {summary.last_flight_date}
            </Text>
          ) : null}
        </Card>
      ) : null}

      {flights.length === 0 ? (
        <View style={styles.empty}>
          <SectionHeading>Nothing logged</SectionHeading>
          <Body muted>
            {filtered
              ? 'No flights match the year, month and pilot chosen above.'
              : administers
                ? 'No flights have been logged against this aircraft.'
                : 'You have not logged a flight on this aircraft.'}
          </Body>
        </View>
      ) : (
        flights.map((flight) => (
          // The same gesture as the dashboard's widget, on the screen its
          // "View all" leads to — a row that opens there and not here would
          // read as two different kinds of thing.
          <Pressable
            key={flight.id}
            onPress={() => router.push({ pathname: '/flight', params: { id: flight.id } })}
            accessibilityRole="button"
            accessibilityLabel={`Flight on ${flight.flight_date}, ${routeOf(flight)}`}
            style={({ pressed }) => [pressed && styles.pressed]}
          >
            <Card>
              <View style={styles.row}>
                <Text style={styles.route}>{routeOf(flight)}</Text>
                <Text style={styles.date}>{flight.flight_date}</Text>
              </View>
              <Text style={styles.meta}>
                {/* The projection carries the address and no name, which is
                    enough to say who had the aeroplane. */}
                {showPilot
                  ? `${flight.flown_by_name ?? flight.flown_by_email ?? 'Unknown pilot'} · `
                  : ''}
                {flight.aircraft_registration}
              </Text>
              {/* Struck rather than hidden: §3.4 keeps both rows, and the
                  figures on a replaced entry are no longer what the aeroplane
                  is counting. */}
              <Text
                style={[
                  styles.meters,
                  (flight.superseded_by || flight.logged_in_error) && styles.replaced,
                ]}
              >
                {flight.hobbs_hours ? `${flight.hobbs_hours} hobbs` : 'no hobbs'}
                {flight.tach_hours ? ` · ${flight.tach_hours} tach` : ''}
              </Text>
              {flight.logged_in_error ? (
                <Text style={styles.meta}>Logged in error</Text>
              ) : flight.superseded_by ? (
                <Text style={styles.meta}>Corrected</Text>
              ) : null}
              {flight.needs_review && flight.review_reason && !flight.superseded_by ? (
                // §8.2: a meter gap is a flag for a person, never a rejection,
                // and it is usually a maintenance run or an unlogged flight.
                // A corrected entry stops asking: being replaced says more
                // than being cleared, and nothing was edited to say it.
                <Text style={styles.review}>{flight.review_reason}</Text>
              ) : null}
              {/* 0042: the aeroplane asked for a photograph of the panel and
                  none arrived. A flag for whoever checks the log, in the same
                  quiet line as a meter gap — never a reason it was refused. */}
              {administers && flight.meter_photo_missing ? (
                <Text style={styles.review}>Meter photo missing</Text>
              ) : null}
            </Card>
          </Pressable>
        ))
      )}

      <Sheet
        visible={choosing !== null}
        title={choosing === 'year' ? 'Year' : choosing === 'month' ? 'Month' : 'Pilot'}
        onClose={() => setChoosing(null)}
      >
        <ScrollView style={styles.sheetList}>
          {choosing === 'year'
            ? [null, ...years].map((value) => (
                <FilterOption
                  key={value ?? 'all'}
                  label={value === null ? 'All years' : String(value)}
                  chosen={value === year}
                  onPress={() => {
                    setYear(value);
                    if (value === null) setMonth(null);
                    setChoosing(null);
                  }}
                />
              ))
            : choosing === 'month'
              ? [null, ...MONTHS.map((_, i) => i + 1)].map((value) => (
                  <FilterOption
                    key={value ?? 'all'}
                    label={value === null ? 'All months' : MONTHS[value - 1]!}
                    chosen={value === month}
                    onPress={() => {
                      setMonth(value);
                      setChoosing(null);
                    }}
                  />
                ))
              : people.map((one) => (
                  <FilterOption
                    key={one.kind === 'member' ? one.member.id : one.kind}
                    label={
                      one.kind === 'everyone'
                        ? 'Everyone'
                        : one.kind === 'me'
                          ? 'Me'
                          : personOf(one.member)
                    }
                    detail={
                      one.kind === 'member' && one.member.status === 'removed'
                        ? 'No longer a member'
                        : undefined
                    }
                    chosen={
                      one.kind === whose.kind &&
                      (one.kind !== 'member' ||
                        (whose.kind === 'member' && whose.member.id === one.member.id))
                    }
                    onPress={() => {
                      setPerson(one);
                      setChoosing(null);
                    }}
                  />
                ))}
        </ScrollView>
      </Sheet>

      {/* Which aeroplane was flown. The same picker the calendar uses. */}
      <Sheet visible={picking} title="Log a flight in" onClose={() => setPicking(false)}>
        {active.map((one) => (
          <Pressable
            key={one.id}
            onPress={() => {
              setPicking(false);
              router.push({ pathname: '/log-flight', params: { aircraft: one.id } });
            }}
            accessibilityRole="button"
            accessibilityLabel={`Log a flight in ${one.registration}`}
            style={({ pressed }) => [styles.option, pressed && styles.pressed]}
          >
            <AircraftThumbnail size="small" photo={one.photo} />
            <View style={styles.optionText}>
              <Text style={styles.optionLabel}>{one.registration}</Text>
              <Text style={styles.optionType}>{one.type_code ?? 'Type not recorded'}</Text>
            </View>
            <Feather name="chevron-right" size={18} color={color.secondary} />
          </Pressable>
        ))}
      </Sheet>
    </ScrollView>
  );
}

function FilterOption({
  label,
  detail,
  chosen,
  onPress,
}: {
  label: string;
  detail?: string;
  chosen: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected: chosen }}
      style={({ pressed }) => [
        styles.filterOption,
        chosen && styles.filterOptionChosen,
        pressed && styles.pressed,
      ]}
    >
      <View style={styles.optionText}>
        <Text style={[styles.filterOptionLabel, chosen && styles.filterOptionLabelChosen]}>
          {label}
        </Text>
        {detail ? <Text style={styles.optionType}>{detail}</Text> : null}
      </View>
      {chosen ? <Feather name="check" size={20} color={color.navy} /> : null}
    </Pressable>
  );
}

function Stat({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>
        {value}
        {unit ? <Text style={styles.statUnit}> {unit}</Text> : null}
      </Text>
    </View>
  );
}

function round(hours: string): string {
  return Number(hours).toFixed(1);
}

const styles = StyleSheet.create({
  container: { padding: space.base, gap: space.md },
  stats: { flexDirection: 'row', gap: space.xl, marginTop: space.md },
  stat: { gap: space.xs },
  statLabel: { ...type.supporting, color: color.secondary },
  statValue: { ...type.sectionHeading },
  statUnit: { ...type.supporting, color: color.secondary },
  range: { ...type.supporting, color: color.secondary, marginTop: space.md },
  empty: { gap: space.sm, paddingVertical: space.lg },
  row: { flexDirection: 'row', alignItems: 'baseline', gap: space.sm },
  route: { ...type.cardHeading, flex: 1 },
  date: { ...type.supporting, color: color.secondary },
  meta: { ...type.supporting, color: color.secondary, marginTop: space.xs },
  replaced: { textDecorationLine: 'line-through', color: color.secondary },
  meters: { ...type.bodySmall, marginTop: space.xs, fontVariant: ['tabular-nums'] },
  pressed: { opacity: 0.7 },

  log: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    height: 48,
    borderRadius: radius.control,
    backgroundColor: color.navy,
  },
  logPressed: { backgroundColor: color.navyHover },
  logLabel: { ...type.button, color: color.onDark },

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
  optionText: { flex: 1, gap: 2 },
  optionLabel: { ...type.cardHeading, textTransform: 'uppercase' },
  optionType: { ...type.supporting, color: color.secondary },
  review: { ...type.supporting, marginTop: space.xs },

  filters: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  filterText: { ...type.bodySmall, maxWidth: 140 },
  filterOff: { color: color.secondary },
  sheetList: { maxHeight: 420 },
  filterOption: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: 48,
    paddingHorizontal: space.md,
    borderRadius: radius.control,
  },
  filterOptionChosen: { backgroundColor: color.selected },
  filterOptionLabel: { ...type.body },
  filterOptionLabelChosen: { fontFamily: type.button.fontFamily },
});
