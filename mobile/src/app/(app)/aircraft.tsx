import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import type {
  AircraftAvailabilityResponse,
  AircraftResponse,
  MaintenanceItemResponse,
  MembershipSummaryResponse,
  ReservationResponse,
  TenantResponse,
} from '@flightsquare/shared';

import {
  AircraftThumbnail,
  StatusIndicator,
  maintenanceDetail,
  maintenanceIsOverdue,
  reservationDetail,
  statusesFor,
  type FleetStatus,
} from '@/components/aircraft';
import { Body, Button, Notice, SectionHeading } from '@/components/ui';
import { Sheet } from '@/components/sheet';
import { api, withAuth } from '@/lib/api';
import { useEntitlements, useQuota } from '@/lib/entitlements';
import { pendingCount, sync } from '@/lib/sync';
import { color, radius, space, type } from '@/theme';

/**
 * The fleet.
 *
 * One card per aeroplane, and the card answers the question somebody is
 * standing in a car park asking: can I fly it, what do the meters read, where
 * is it, and how much fuel did the last pilot leave.
 *
 * **Status is the server's answer, never this screen's.** §3.3 puts dispatch
 * state in `aircraft_availability` — the one resolved view the booking path
 * itself consults — precisely so that a screen cannot drift from what the
 * booking path will do. Nothing here decides whether an aeroplane flies.
 *
 * The buttons this list used to carry — Log flight, Report a defect — moved
 * to the aeroplane's own screen along with everything else about it. A card
 * in a list of four with two buttons on it is four primary actions on one
 * screen, which §11 §6 rules out, and they were the only way to reach either
 * flow, so they had to land somewhere rather than simply go.
 */
export default function Fleet() {
  const [fleet, setFleet] = useState<AircraftResponse[] | null>(null);
  const [availability, setAvailability] = useState<AircraftAvailabilityResponse[]>([]);
  const [items, setItems] = useState<MaintenanceItemResponse[]>([]);
  const [flying, setFlying] = useState<ReservationResponse[]>([]);
  const [tenant, setTenant] = useState<TenantResponse | null>(null);
  const [memberships, setMemberships] = useState<MembershipSummaryResponse[]>([]);
  const [queue, setQueue] = useState({ pending: 0, failed: 0 });
  const [failed, setFailed] = useState(false);
  const [offline, setOffline] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // Kept across a trip into an aeroplane's screen and back: this tab stays
  // mounted, so a treasurer who filtered to "Grounded" comes back to it.
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<FleetStatus[]>([]);
  const [filtering, setFiltering] = useState(false);

  /**
   * The provider fetches once at launch, which is right for a plan a club
   * changes a handful of times a year — but the quota's *current* count moves
   * every time somebody adds or archives an aeroplane, and this is the screen
   * where that happens. The "+ Add" control is hidden on `current < limit`,
   * so a stale count is the difference between the button being there and
   * not.
   */
  const { refresh: refreshEntitlements } = useEntitlements();

  const load = useCallback(async () => {
    // Flush first: a flight logged on the ramp should reach the server before
    // the meters are read back, or this list shows stale numbers.
    await sync().catch(() => undefined);
    setQueue(await pendingCount());

    try {
      const now = new Date().toISOString();
      const [aircraft, dispatch, maintenance, inProgress, club, clubs] = await Promise.all([
        withAuth(() => api.listAircraft()),
        withAuth(() => api.availability()),
        // Every tier has maintenance tracking (§4.3), so this does not 404 for
        // entitlement reasons — but a tenant override could turn it off, and a
        // fleet list is not worth failing over a badge.
        withAuth(() => api.listMaintenanceItems()).catch(() => []),
        /**
         * Reserved *now*, not "has a booking some day".
         *
         * The window is a single instant, so the server returns exactly the
         * bookings where `starts_at < now < ends_at` — the filtering happens
         * in SQL and this screen only reads which aeroplane each one is on.
         * §8.2 keeps computation off the client, and a badge that says an
         * aeroplane is in use is worth getting right.
         */
        withAuth(() => api.listReservations({ from: now, to: now })).catch(() => []),
        withAuth(() => api.tenant()).catch(() => null),
        withAuth(() => api.memberships()).catch(() => []),
        refreshEntitlements(),
      ]);

      setFleet(aircraft);
      setAvailability(dispatch);
      setItems(maintenance);
      setFlying(inProgress);
      setTenant(club);
      setMemberships(clubs);
      setFailed(false);
      setOffline(false);
    } catch {
      // Two different failures: never loaded, and loaded once and now cannot
      // reach the server. The first needs a retry; the second needs the last
      // known readings left where they are, because this is a field app.
      if (fleet === null) setFailed(true);
      else setOffline(true);
    }
  }, [fleet, refreshEntitlements]);

  useFocusEffect(
    useCallback(() => {
      void load();
      // Deliberately not keyed on `load`: it closes over `fleet` to tell a
      // first failure from a later one, and re-running on every list change
      // would make this a loop.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );

  const active = useMemo(
    () => fleet?.filter((aircraft) => aircraft.status === 'active') ?? [],
    [fleet],
  );

  /** What each aeroplane is wearing, worked out once for the list. */
  const badgesFor = useCallback(
    (aircraft: AircraftResponse): FleetStatus[] =>
      statusesFor({
        available: availability.find((row) => row.aircraft_id === aircraft.id)?.available,
        reservedNow: flying.some((row) => row.aircraft_id === aircraft.id),
        dueSoon: dueSoon(items, aircraft.id),
      }),
    [availability, flying, items],
  );

  /**
   * The second line under a status, where one exists.
   *
   * Only facts already on the wire: when the booking in progress ends, and
   * which maintenance item is nearest with the server's own countdown.
   * Nothing is invented — a status with no such fact simply has one line.
   */
  const detailsFor = useCallback(
    (aircraft: AircraftResponse) => ({
      detail: {
        reserved: reservationDetail(flying.find((row) => row.aircraft_id === aircraft.id)),
        due_soon: maintenanceDetail(items, aircraft.id),
      } as Partial<Record<FleetStatus, string | null>>,
      overdue: maintenanceIsOverdue(items, aircraft.id),
    }),
    [flying, items],
  );

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return active.filter((aircraft) => {
      const matchesText =
        needle === '' ||
        `${aircraft.registration} ${aircraft.type_code ?? ''}`.toLowerCase().includes(needle);
      const matchesFilter =
        filters.length === 0 || badgesFor(aircraft).some((badge) => filters.includes(badge));
      return matchesText && matchesFilter;
    });
  }, [active, query, filters, badgesFor]);

  const narrowed = query.trim() !== '' || filters.length > 0;

  return (
    <>
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
        {/* Which club, and how many aeroplanes are in it. --------------- */}
        <View style={styles.context}>
          <OrgLine tenant={tenant} memberships={memberships} />
          <Text style={styles.count}>
            {fleet === null
              ? 'Loading…'
              : `${active.length} aircraft${
                  // The total and the filtered total are different numbers and
                  // are never allowed to look like one.
                  narrowed ? ` · ${shown.length} shown` : ''
                }`}
          </Text>
        </View>

        {/* Search and filter ------------------------------------------- */}
        <View style={styles.searchRow}>
          <View style={styles.search}>
            <Feather name="search" size={18} color={color.secondary} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Search registration or model"
              placeholderTextColor={color.secondary}
              autoCapitalize="characters"
              autoCorrect={false}
              style={styles.searchInput}
              accessibilityLabel="Search aircraft by registration or model"
              returnKeyType="search"
            />
            {query !== '' ? (
              <Pressable
                onPress={() => setQuery('')}
                accessibilityRole="button"
                accessibilityLabel="Clear search"
                hitSlop={space.md}
              >
                <Feather name="x" size={18} color={color.secondary} />
              </Pressable>
            ) : null}
          </View>

          <Pressable
            onPress={() => setFiltering(true)}
            accessibilityRole="button"
            accessibilityLabel={
              filters.length > 0
                ? `Filter by status, ${filters.length} active`
                : 'Filter by status'
            }
            style={({ pressed }) => [
              styles.filterButton,
              filters.length > 0 && styles.filterButtonOn,
              pressed && styles.pressed,
            ]}
          >
            <Feather name="sliders" size={20} color={color.navy} />
            {/* A count, not just a colour — the active state has to survive
                somebody who cannot see the teal (§11 §13). */}
            {filters.length > 0 ? (
              <View style={styles.filterCount}>
                <Text style={styles.filterCountLabel}>{filters.length}</Text>
              </View>
            ) : null}
          </Pressable>
        </View>

        {offline ? <Notice>Offline. Showing the last known readings.</Notice> : null}

        {queue.pending > 0 ? (
          <Notice>
            {queue.pending} {queue.pending === 1 ? 'entry' : 'entries'} waiting to sync. They
            go on their own when there is a signal.
          </Notice>
        ) : null}

        {queue.failed > 0 ? (
          <View style={styles.stack}>
            <Notice tone="error">
              {queue.failed} {queue.failed === 1 ? 'entry' : 'entries'} could not be saved.
            </Notice>
            <Button
              label="See what is stuck"
              variant="secondary"
              onPress={() => router.push('/(app)/queue')}
            />
          </View>
        ) : null}

        {/* The list ---------------------------------------------------- */}
        {failed ? (
          <View style={styles.stack}>
            <Notice tone="error">The fleet could not be loaded.</Notice>
            <Button label="Try again" onPress={() => void load()} />
          </View>
        ) : null}

        {shown.map((aircraft) => (
          <AircraftCard
            key={aircraft.id}
            aircraft={aircraft}
            badges={badgesFor(aircraft)}
            details={detailsFor(aircraft)}
          />
        ))}

        {fleet !== null && !failed && shown.length === 0 ? (
          <Empty narrowed={narrowed} onClear={() => { setQuery(''); setFilters([]); }} />
        ) : null}
      </ScrollView>

      <FilterSheet
        visible={filtering}
        selected={filters}
        onToggle={(status) =>
          setFilters((current) =>
            current.includes(status)
              ? current.filter((one) => one !== status)
              : [...current, status],
          )
        }
        onReset={() => setFilters([])}
        onClose={() => setFiltering(false)}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

function AircraftCard({
  aircraft,
  badges,
  details,
}: {
  aircraft: AircraftResponse;
  badges: FleetStatus[];
  /** Second lines, where the data for one already exists. */
  details: {
    detail: Partial<Record<FleetStatus, string | null>>;
    overdue: boolean;
  };
}) {
  return (
    <Pressable
      onPress={() =>
        router.push({ pathname: '/aircraft-detail', params: { id: aircraft.id } })
      }
      accessibilityRole="button"
      // Identity, then status, then the readings with their units — the order
      // somebody would say them out loud.
      accessibilityLabel={`${aircraft.registration}, ${modelOf(aircraft)}`}
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}
    >
      <View style={styles.identity}>
        <AircraftThumbnail />

        <View style={styles.identityText}>
          <View style={styles.identityHead}>
            <View style={styles.names}>
              {/* §11 reserves uppercase for registrations. */}
              <Text style={styles.registration}>{aircraft.registration}</Text>
              <Text style={styles.model}>{modelOf(aircraft)}</Text>
            </View>
            {/* The chevron stands alone on the right, clear of the statuses. */}
            <Feather name="chevron-right" size={20} color={color.secondary} />
          </View>

          {/*
            Statuses stack under the model rather than sitting beside the
            registration. Unboxed, they are text — and right-aligned text next
            to a chevron reads as a caption for the chevron. Stacked at the
            left edge, the severity markers line up into a column a pilot can
            run an eye down, and `statusesFor` puts availability first so a
            grounded aeroplane is always the top line.
          */}
          <View style={styles.statuses}>
            {badges.map((badge) => (
              <StatusIndicator
                key={badge}
                status={badge}
                detail={details.detail[badge]}
                label={badge === 'due_soon' && details.overdue ? 'Overdue' : undefined}
              />
            ))}
          </View>
        </View>
      </View>

      <View style={styles.rule} />

      {/* §3.4 and §11: Hobbs and tach are recorded as read, run at different
          rates by design, and neither is derived from the other — so each is
          named, and these are the aeroplane's totals, never a flight's. */}
      <View style={styles.readings}>
        <Reading label="Hobbs" value={hours(aircraft.hobbs)} />
        <View style={styles.readingRule} />
        <Reading label="Tach" value={hours(aircraft.tach)} />
      </View>

      <View style={styles.rule} />

      <View style={styles.readings}>
        <Reading
          /* There is no telemetry here: the only recorded location in the
             schema is the arrival a pilot typed post-flight. */
          label="Location · last arrival"
          value={aircraft.last_location}
          icon="map-pin"
        />
        <View style={styles.readingRule} />
        <Reading
          /* Not "estimated": nothing records whether the tanks were dipped or
             eyeballed, so the honest claim is who said it and when. */
          label="Fuel · last reported"
          value={fuel(aircraft)}
          icon="droplet"
        />
      </View>

      {aircraft.fuel_remaining_at ? (
        <>
          <View style={styles.rule} />
          <Text style={styles.stamp}>
            Fuel reported · {stamp(aircraft.fuel_remaining_at)}
          </Text>
        </>
      ) : null}
    </Pressable>
  );
}

function Reading({
  label,
  value,
  icon,
}: {
  label: string;
  value: string | null;
  icon?: 'map-pin' | 'droplet';
}) {
  return (
    <View style={styles.reading}>
      {/* Nothing capped to a line count: §11 §13 asks for readable text at
          accessibility sizes, and a truncated meter reading is worse than a
          wrapped one. */}
      <Text style={styles.readingLabel}>{label}</Text>
      <View style={styles.readingValue}>
        {icon && value ? <Feather name={icon} size={16} color={color.secondary} /> : null}
        <Text style={value ? styles.readingNumber : styles.readingAbsent}>
          {/* §11: "Not recorded" rather than a zero. Different answers, and
              only one of them is true. */}
          {value ?? 'Not recorded'}
        </Text>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// The rest
// ---------------------------------------------------------------------------

/**
 * The club, with a way to change it only when there is another one.
 *
 * Switching reuses the picker sign-in uses and the `selectTenant` behind it —
 * the existing behaviour reached from a second place, not a second way of
 * doing it.
 */
function OrgLine({
  tenant,
  memberships,
}: {
  tenant: TenantResponse | null;
  memberships: MembershipSummaryResponse[];
}) {
  if (!tenant) return null;

  if (memberships.length <= 1) {
    return <Text style={styles.org}>{tenant.name}</Text>;
  }

  return (
    <Pressable
      onPress={() =>
        router.push({
          pathname: '/choose-tenant',
          params: {
            memberships: JSON.stringify(
              memberships.map((one) => ({
                tenant_id: one.tenant_id,
                tenant_name: one.tenant_name,
              })),
            ),
          },
        })
      }
      accessibilityRole="button"
      accessibilityLabel={`${tenant.name}. Switch club`}
      hitSlop={space.sm}
      style={({ pressed }) => [styles.orgRow, pressed && styles.pressed]}
    >
      <Text style={styles.org}>{tenant.name}</Text>
      <Feather name="chevron-down" size={18} color={color.navy} />
    </Pressable>
  );
}

const FILTERS: FleetStatus[] = ['available', 'reserved', 'grounded', 'due_soon', 'unknown'];

function FilterSheet({
  visible,
  selected,
  onToggle,
  onReset,
  onClose,
}: {
  visible: boolean;
  selected: FleetStatus[];
  onToggle: (status: FleetStatus) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  return (
    <Sheet visible={visible} title="Filter by status" onClose={onClose}>
      <Body muted>
        {/* They overlap on purpose: an aeroplane can be grounded and have an
            annual coming due, and both filters should find it. */}
        An aircraft can hold more than one. Picking several shows anything
        matching any of them.
      </Body>

      {FILTERS.map((status) => {
        const on = selected.includes(status);
        return (
          <Pressable
            key={status}
            onPress={() => onToggle(status)}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: on }}
            style={({ pressed }) => [
              styles.filterOption,
              on && styles.filterOptionOn,
              pressed && styles.pressed,
            ]}
          >
            <StatusIndicator status={status} />
            <View style={styles.spacer} />
            {on ? <Feather name="check" size={20} color={color.tealText} /> : null}
          </Pressable>
        );
      })}

      {selected.length > 0 ? (
        <Button label="Clear filters" variant="secondary" onPress={onReset} />
      ) : null}
    </Sheet>
  );
}

function Empty({ narrowed, onClear }: { narrowed: boolean; onClear: () => void }) {
  if (narrowed) {
    return (
      <View style={styles.empty}>
        <SectionHeading>Nothing matches</SectionHeading>
        <Body muted>No aircraft match that search or those filters.</Body>
        <Button label="Clear search and filters" variant="secondary" onPress={onClear} />
      </View>
    );
  }

  return <EmptyFleet />;
}

/**
 * An account with no aeroplanes.
 *
 * What it offers depends on what this member may actually do. §8.3 keeps
 * every purchase off this app and forbids pointing at one, so a member who
 * cannot add an aircraft is told plainly rather than shown a door that opens
 * onto a 402 or, worse, onto a price.
 */
function EmptyFleet() {
  const quota = useQuota('aircraft.active');
  const room = quota ? quota.limit === 'unlimited' || (quota.current ?? 0) < quota.limit : false;

  return (
    <View style={styles.empty}>
      <SectionHeading>No aircraft yet</SectionHeading>
      <Body muted>
        {room
          ? 'Add one and its meters, maintenance schedule and bookings all hang off it.'
          : 'Nobody has added one to this account yet.'}
      </Body>
      {room ? (
        <Button label="Add aircraft" onPress={() => router.push('/add-aircraft')} />
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// The small decisions
// ---------------------------------------------------------------------------

/** The ICAO type designator is what the schema holds; there is no model name. */
function modelOf(aircraft: AircraftResponse): string {
  return aircraft.type_code ?? 'Type not recorded';
}

/**
 * Whether anything on this aeroplane is close enough to matter.
 *
 * `overdue` with `ever_complied === false` is deliberately **not** counted as
 * due soon: an interval seeded with the aeroplane that nobody has confirmed
 * is unknown rather than overdue, and every other screen in the product keeps
 * those apart. The Maintenance tab is where each group gets its correct name.
 */
function dueSoon(items: MaintenanceItemResponse[], aircraftId: string): boolean {
  return items.some(
    (item) =>
      item.aircraft_id === aircraftId &&
      (item.state === 'due_soon' || (item.state === 'overdue' && item.ever_complied)),
  );
}

/** §11: tabular hours with the unit named, or an honest absence. */
function hours(value: string | null): string | null {
  if (value === null) return null;
  return `${Number(value).toLocaleString(undefined, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })} h`;
}

/**
 * What is in the tanks, in this aeroplane's own configured units.
 *
 * Never a percentage: that needs a capacity not every aircraft has, and §3.4
 * is explicit that fuel is a reading rather than a calculation.
 */
function fuel(aircraft: AircraftResponse): string | null {
  if (aircraft.fuel_remaining === null) return null;
  const unit = aircraft.fuel_units === 'litres' ? 'L' : 'US gal';
  return `${Number(aircraft.fuel_remaining).toLocaleString(undefined, {
    maximumFractionDigits: 1,
  })} ${unit}`;
}

/** §11: the zone is named, because a bare clock time is ambiguous. */
function stamp(instant: string): string {
  return new Date(instant).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

const styles = StyleSheet.create({
  // The last card clears the tab bar; the safe area is the navigator's job.
  container: { padding: space.base, paddingBottom: space.xxl, gap: space.md },
  pressed: { opacity: 0.7 },
  stack: { gap: space.sm },
  spacer: { flex: 1 },
  rule: { height: 1, backgroundColor: color.line },

  context: { gap: 2 },
  org: { ...type.sectionHeading },
  orgRow: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  count: { ...type.supporting, color: color.secondary },

  searchRow: { flexDirection: 'row', gap: space.md, alignItems: 'stretch' },
  search: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: 48,
    paddingHorizontal: space.md,
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.line,
    borderRadius: radius.control,
  },
  searchInput: { flex: 1, ...type.input, paddingVertical: space.sm },
  filterButton: {
    width: 52,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.line,
    borderRadius: radius.control,
  },
  filterButtonOn: { borderColor: color.teal, borderWidth: 2 },
  filterCount: {
    position: 'absolute',
    top: 4,
    right: 4,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    paddingHorizontal: 3,
    backgroundColor: color.tealText,
    alignItems: 'center',
    justifyContent: 'center',
  },
  filterCountLabel: { ...type.supporting, fontSize: 10, color: color.onDark },

  card: {
    backgroundColor: color.surface,
    borderColor: color.line,
    borderWidth: 1,
    borderRadius: radius.card,
  },
  identity: { flexDirection: 'row', gap: space.md, padding: space.base },
  identityText: { flex: 1, gap: space.sm },
  identityHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  names: { flex: 1, gap: 2 },
  registration: { ...type.sectionHeading, textTransform: 'uppercase' },
  model: { ...type.body, color: color.secondary },
  statuses: { gap: space.sm },

  readings: { flexDirection: 'row', paddingVertical: space.md, paddingHorizontal: space.base },
  reading: { flex: 1, gap: space.xs },
  readingRule: { width: 1, backgroundColor: color.line, marginHorizontal: space.base },
  readingLabel: { ...type.supporting, color: color.secondary },
  readingValue: { flexDirection: 'row', alignItems: 'center', gap: space.xs, flexWrap: 'wrap' },
  readingNumber: { ...type.cardHeading, fontSize: 18, fontVariant: ['tabular-nums'] },
  readingAbsent: { ...type.body, color: color.secondary },
  stamp: {
    ...type.supporting,
    color: color.secondary,
    paddingHorizontal: space.base,
    paddingVertical: space.md,
  },

  filterOption: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: 56,
    paddingHorizontal: space.md,
    borderWidth: 1,
    borderColor: color.line,
    borderRadius: radius.card,
  },
  filterOptionOn: { borderColor: color.teal, backgroundColor: color.selected },

  empty: { gap: space.md, paddingVertical: space.xl },
});
