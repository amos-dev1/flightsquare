import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import type {
  AircraftResponse,
  MaintenanceItemResponse,
  MaintenanceState,
  MaintenanceSummaryResponse,
  SquawkResponse,
} from '@flightsquare/shared';

import { Body, Button, Card, CardHeading, Notice, Picker, SectionHeading } from '@/components/ui';
import { Sheet } from '@/components/sheet';
import { AircraftThumbnail } from '@/components/aircraft';
import { api, withAuth } from '@/lib/api';
import { readSession } from '@/lib/auth';
import { usePermission } from '@/lib/entitlements';
import { readPref, writePref } from '@/lib/prefs';
import { color, radius, space, statusColor, type } from '@/theme';

/**
 * Maintenance, which is two screens behind one tab.
 *
 * SPEC §3 splits the module in half and §5 draws both. An admin gets the
 * record — the status card, every tracked item with its countdown, and the way
 * in to adding one. A pilot gets the aeroplane: whether it flies, what is
 * coming up, and a way to report what they found. The split is a permission,
 * not a role name (§1.5), so this screen asks what the member holds rather than
 * what they are called.
 *
 * Nothing here computes a due date, a remaining or a state. §8.2: the client
 * renders what the API returned, and the API renders what the database said —
 * which is why the same numbers appear here, on the web, and in the digest.
 */

const SELECTED = 'maintenance.aircraft';

type Filter = 'all' | 'due_soon' | 'overdue';

export default function Maintenance() {
  const canReadItems = usePermission('maintenance.items') !== 'none';
  const canWriteItems = usePermission('maintenance.items') === 'write';

  const [fleet, setFleet] = useState<AircraftResponse[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);

  const [summary, setSummary] = useState<MaintenanceSummaryResponse | null>(null);
  const [items, setItems] = useState<MaintenanceItemResponse[]>([]);
  const [squawks, setSquawks] = useState<SquawkResponse[]>([]);
  const [filter, setFilter] = useState<Filter>('all');

  const [unread, setUnread] = useState(0);
  /** Who and where, for the remembered selection. Read once, not per tap. */
  const [scope, setScope] = useState<{ userId: string; tenantId: string } | null>(null);
  const [offline, setOffline] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    // Each one catches its own: a club without the maintenance module must not
    // lose the squawk list, and a pilot's 403 on the item list is the
    // permission model working rather than a failure to load.
    const optional = <T,>(promise: Promise<T>, fallback: T): Promise<T> =>
      promise.catch(() => fallback);

    try {
      const aircraft = await withAuth(() => api.listAircraft());
      const active = aircraft.filter((one) => one.status === 'active');
      setFleet(active);
      setOffline(false);

      // Per (user, tenant), like the dashboard's: somebody in two clubs has a
      // different aeroplane in mind at each of them (§3.1).
      const session = await readSession();
      const profile = await withAuth(() => api.me()).catch(() => null);
      const where =
        profile && session?.tenantId
          ? { userId: profile.id, tenantId: session.tenantId }
          : null;
      setScope(where);
      const remembered = where ? await readPref(where.userId, where.tenantId, SELECTED) : null;
      const chosen =
        active.find((one) => one.id === selectedId)?.id ??
        active.find((one) => one.id === remembered)?.id ??
        active[0]?.id ??
        null;
      setSelectedId(chosen);
      if (!chosen) {
        setSummary(null);
        setItems([]);
        return;
      }

      const [theSummary, theItems, theSquawks, bell] = await Promise.all([
        optional(withAuth(() => api.maintenanceSummary(chosen)), null),
        canReadItems
          ? optional(withAuth(() => api.listMaintenanceItems({ aircraftId: chosen })), [])
          : Promise.resolve([] as MaintenanceItemResponse[]),
        optional(withAuth(() => api.listSquawks({ aircraftId: chosen, open: true })), []),
        optional(withAuth(() => api.unreadCount()), { unread: 0 }),
      ]);

      setSummary(theSummary);
      setItems(theItems);
      setSquawks(theSquawks);
      setUnread(bell.unread);
    } catch {
      // Whatever loaded last stays. This is a field app, and an empty
      // maintenance screen reads as an aeroplane with nothing wrong with it.
      setOffline(true);
    }
  }, [canReadItems, selectedId]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const select = useCallback(
    async (id: string) => {
      setSelectedId(id);
      setPicking(false);
      if (scope) await writePref(scope.userId, scope.tenantId, SELECTED, id);
    },
    [scope],
  );

  const selected = fleet.find((one) => one.id === selectedId) ?? null;
  const counts = {
    all: items.length,
    due_soon: items.filter((item) => item.state === 'due_soon').length,
    overdue: items.filter((item) => item.state === 'overdue').length,
  };
  const shown = filter === 'all' ? items : items.filter((item) => item.state === filter);

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
      {/* Which aeroplane, and the bell ------------------------------- */}
      <View style={styles.head}>
        <View style={styles.headPicker}>
          <Picker
            compact
            disabled={fleet.length <= 1}
            onPress={() => setPicking(true)}
            label={selected ? `${selected.registration}. Change aircraft` : 'Choose an aircraft'}
          >
            <Text style={styles.registration} numberOfLines={1}>
              {selected?.registration ?? '—'}
            </Text>
          </Picker>
        </View>
        <Pressable
          onPress={() => router.push('/(app)/notifications')}
          accessibilityRole="button"
          accessibilityLabel={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
          style={({ pressed }) => [styles.bell, pressed && styles.pressed]}
        >
          <Feather name="bell" size={20} color={color.navy} />
          {/* Never the dot alone: the accessible label carries the count, and
              §11 §13 forbids meaning that lives only in a colour. */}
          {unread > 0 ? <View style={styles.dot} /> : null}
        </Pressable>
      </View>

      {offline ? <Notice>Showing what loaded last. No connection.</Notice> : null}

      {selected === null ? (
        <Card style={styles.group}>
          <SectionHeading>No aircraft yet</SectionHeading>
          <Body muted>Add one and its maintenance lives here.</Body>
        </Card>
      ) : (
        <>
          <StatusCard summary={summary} model={selected.type_code} />

          {/* §4.5: a restriction is not a grounding, and saying so is the
              difference between not flying and not flying IFR. */}
          {summary?.restrictions.length ? (
            <Notice>{summary.restrictions.join('\n')}</Notice>
          ) : null}

          {canReadItems ? (
            <AdminItems
              items={shown}
              counts={counts}
              filter={filter}
              onFilter={setFilter}
              canWrite={canWriteItems}
              aircraftId={selected.id}
            />
          ) : (
            <PilotUpcoming summary={summary} />
          )}

          {/* Defects live on this screen because this app has no Squawks tab;
              §1.5 keeps them a separate resource, so they are a separate
              section rather than mixed into the list above. */}
          <View style={styles.group}>
            <SectionHeading>Reported defects</SectionHeading>
            {squawks.length === 0 ? (
              <Body muted>Nothing outstanding.</Body>
            ) : (
              squawks.map((squawk) => (
                <Card key={squawk.id} style={styles.defect}>
                  <View style={styles.defectHead}>
                    <Text style={styles.defectSummary}>{squawk.summary}</Text>
                    {squawk.grounding ? <Pill state="overdue" label="Grounding" /> : null}
                  </View>
                  {squawk.details ? <Body muted>{squawk.details}</Body> : null}
                </Card>
              ))
            )}
            <Button
              label="Report a defect"
              variant="secondary"
              onPress={() =>
                router.push({
                  pathname: '/(app)/report-squawk',
                  params: { aircraft: selected.id },
                })
              }
            />
          </View>
        </>
      )}

      <Sheet visible={picking} title="Choose aircraft" onClose={() => setPicking(false)}>
        {fleet.map((one) => (
          <Pressable
            key={one.id}
            onPress={() => void select(one.id)}
            accessibilityRole="radio"
            accessibilityState={{ selected: one.id === selectedId }}
            style={({ pressed }) => [
              styles.option,
              one.id === selectedId && styles.optionChosen,
              pressed && styles.pressed,
            ]}
          >
            <AircraftThumbnail size="small" />
            <View style={styles.optionText}>
              <Text style={styles.optionRegistration}>{one.registration}</Text>
              <Text style={styles.meta}>{one.type_code ?? 'Type not recorded'}</Text>
            </View>
            {one.id === selectedId ? (
              <Feather name="check" size={20} color={color.tealText} />
            ) : null}
          </Pressable>
        ))}
      </Sheet>
    </ScrollView>
  );
}

/**
 * The dark card at the top of mockup 01.
 *
 * Navy rather than the mockup's ink, and Inter rather than Plex: §11 is the
 * authoritative design spec and the mockups are the layout. The meters keep
 * tabular numerals, which is the one thing both documents insist on.
 */
function StatusCard({
  summary,
  model,
}: {
  summary: MaintenanceSummaryResponse | null;
  model: string | null;
}) {
  const next = summary?.upcoming[0];
  const tone: MaintenanceState = summary
    ? !summary.available
      ? 'overdue'
      : (next?.state ?? 'ok')
    : 'ok';

  return (
    <View style={styles.statusCard}>
      <View style={styles.statusHead}>
        <View style={[styles.pill, { backgroundColor: toneOf(tone).surface }]}>
          <Text style={[styles.pillLabel, { color: toneOf(tone).ink }]}>
            {summary === null ? 'Unknown' : !summary.available ? 'Grounded' : wordFor(tone)}
          </Text>
        </View>
        <Text style={styles.statusMeta}>{model ?? 'Type not recorded'}</Text>
      </View>

      <View style={styles.meters}>
        <View style={styles.meter}>
          <Text style={styles.meterLabel}>Hobbs</Text>
          <Text style={styles.meterValue}>{summary?.hobbs ?? '—'}</Text>
        </View>
        <View style={styles.meter}>
          <Text style={styles.meterLabel}>Tach</Text>
          <Text style={styles.meterValue}>{summary?.tach ?? '—'}</Text>
        </View>
      </View>

      {/* §1 principle 2: never "airworthy". What is tracked, and what it says. */}
      {summary && !summary.available ? (
        <View style={styles.statusFoot}>
          <Text style={styles.statusFootText}>{summary.grounding_reasons.join('\n')}</Text>
          <Text style={styles.statusFootQuiet}>
            New bookings are blocked until an admin logs it complete.
          </Text>
        </View>
      ) : next ? (
        <View style={styles.statusFoot}>
          <Text style={styles.statusFootText}>
            Next due: <Text style={styles.statusStrong}>{next.name}</Text>
            {next.governing_remaining
              ? ` in ${remainingLabel(next.governing_kind, next.governing_remaining)}`
              : ''}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

function AdminItems({
  items,
  counts,
  filter,
  onFilter,
  canWrite,
  aircraftId,
}: {
  items: MaintenanceItemResponse[];
  counts: Record<Filter, number>;
  filter: Filter;
  onFilter: (next: Filter) => void;
  canWrite: boolean;
  aircraftId: string;
}) {
  return (
    <View style={styles.group}>
      <View style={styles.filterRow}>
        <View style={styles.segmented}>
          {(['all', 'due_soon', 'overdue'] as const).map((option) => (
            <Pressable
              key={option}
              onPress={() => onFilter(option)}
              accessibilityRole="button"
              accessibilityState={{ selected: filter === option }}
              style={({ pressed }) => [
                styles.segment,
                filter === option && styles.segmentOn,
                pressed && styles.pressed,
              ]}
            >
              <Text style={[styles.segmentLabel, filter === option && styles.segmentLabelOn]}>
                {option === 'all' ? 'All' : option === 'due_soon' ? 'Due soon' : 'Overdue'}{' '}
                {counts[option]}
              </Text>
            </Pressable>
          ))}
        </View>
        {canWrite ? (
          <Pressable
            onPress={() =>
              router.push({
                pathname: '/(app)/add-maintenance-item',
                params: { aircraft: aircraftId },
              })
            }
            accessibilityRole="button"
            accessibilityLabel="Add a tracked item"
            style={({ pressed }) => [styles.add, pressed && styles.pressed]}
          >
            <Feather name="plus" size={18} color={color.navy} />
            <Text style={styles.addLabel}>Add</Text>
          </Pressable>
        ) : null}
      </View>

      {items.length === 0 ? (
        <Card style={styles.group}>
          {/*
            SPEC §1: nothing is tracked until somebody adds it. A new aeroplane
            arriving with fifteen red items nobody approved is the app asserting
            obligations it cannot know apply.
          */}
          <CardHeading>Nothing tracked yet</CardHeading>
          <Body muted>
            Add the inspections and services this aircraft is on, and FlightSquare counts them
            down against the meters your flights already record.
          </Body>
        </Card>
      ) : (
        items.map((item) => <ItemCard key={item.id} item={item} />)
      )}
    </View>
  );
}

/** Mockup 02: the next five, and nothing about the record (§3). */
function PilotUpcoming({ summary }: { summary: MaintenanceSummaryResponse | null }) {
  return (
    <View style={styles.group}>
      <SectionHeading>Coming up</SectionHeading>
      {summary === null || summary.upcoming.length === 0 ? (
        <Body muted>Nothing outstanding.</Body>
      ) : (
        summary.upcoming.map((item) => (
          <Card key={item.id} style={styles.itemCard}>
            <View style={styles.itemHead}>
              <Text style={styles.itemName}>{item.name}</Text>
              <Text style={[styles.itemRemaining, { color: toneOf(item.state).ink }]}>
                {item.state === 'overdue'
                  ? 'Overdue'
                  : remainingLabel(item.governing_kind, item.governing_remaining)}
              </Text>
            </View>
            {!item.ever_complied ? (
              // §3.6: "no record" and "overdue" are different claims, and only
              // one of them is about the aeroplane.
              <Text style={styles.meta}>No compliance recorded</Text>
            ) : null}
          </Card>
        ))
      )}
      <Body muted>Full maintenance records are kept by your account admin.</Body>
    </View>
  );
}

function ItemCard({ item }: { item: MaintenanceItemResponse }) {
  const tone = toneOf(item.state);
  return (
    <Pressable
      onPress={() => router.push({ pathname: '/(app)/maintenance-item', params: { id: item.id } })}
      accessibilityRole="button"
      accessibilityLabel={`${item.name}, ${wordFor(item.state)}`}
      style={({ pressed }) => [styles.itemCard, pressed && styles.pressed]}
    >
      <View style={styles.itemHead}>
        <View style={styles.itemNameRow}>
          <Text style={styles.itemName} numberOfLines={1}>
            {item.name}
          </Text>
          {/* §4.5: the lock says this one stops the aeroplane. Paired with the
              word in the accessible label, never the icon alone. */}
          {item.grounds_aircraft ? (
            <Feather name="lock" size={14} color={statusColor.bad.ink} />
          ) : null}
        </View>
        <Text style={[styles.itemRemaining, { color: tone.ink }]}>
          {item.state === 'overdue'
            ? 'Overdue'
            : remainingLabel(item.governing_kind, item.governing_remaining)}
        </Text>
      </View>

      <View style={styles.itemFoot}>
        <Text style={styles.meta} numberOfLines={1}>
          {ruleSummary(item)}
        </Text>
        <Text style={styles.meta}>
          {item.restriction_label && item.state === 'overdue'
            ? item.restriction_label
            : wordFor(item.state)}
        </Text>
      </View>
    </Pressable>
  );
}

function Pill({ state, label }: { state: MaintenanceState; label: string }) {
  const tone = toneOf(state);
  return (
    <View style={[styles.pill, { backgroundColor: tone.surface }]}>
      <Text style={[styles.pillLabel, { color: tone.ink }]}>{label}</Text>
    </View>
  );
}

/**
 * §4.4's four states, four treatments.
 *
 * `upcoming` is a thing to plan for and `due_soon` is a thing to book a shop
 * slot for. One colour for both would waste the split the module is built on.
 */
function toneOf(state: MaintenanceState): { surface: string; ink: string } {
  switch (state) {
    case 'overdue':
      return statusColor.bad;
    case 'due_soon':
      return statusColor.urgent;
    case 'upcoming':
      return statusColor.warn;
    case 'inactive':
      return statusColor.unknown;
    default:
      return statusColor.good;
  }
}

function wordFor(state: MaintenanceState): string {
  switch (state) {
    case 'overdue':
      return 'Overdue';
    case 'due_soon':
      return 'Due soon';
    case 'upcoming':
      return 'Upcoming';
    case 'inactive':
      return 'Archived';
    default:
      return 'OK';
  }
}

/**
 * The remaining, in the governing rule's own units.
 *
 * §4.3's rounding: under a fortnight in days, under ten weeks in weeks, else
 * months. "428 days" is a number nobody holds in their head, and the whole
 * point of this line is that somebody can.
 */
function remainingLabel(kind: string | null, remaining: string | null): string {
  if (remaining === null) return '—';
  const value = Number(remaining);
  if (!Number.isFinite(value)) return '—';

  if (kind === 'tach_hr' || kind === 'hobbs_hr' || kind === 'airframe_hr') {
    return `${value.toFixed(1)} hr`;
  }
  if (kind === 'cycles') return `${value} cycles`;

  const days = Math.round(value);
  if (days < 14) return `${days} days`;
  if (days < 70) return `${Math.round(days / 7)} weeks`;
  return `${Math.round(days / 30)} months`;
}

/** "50.0 tach hr or 4 mo" — what the item is on, in the card's one line. */
function ruleSummary(item: MaintenanceItemResponse): string {
  if (item.rules.length === 0) return 'No interval set';
  return item.rules
    .map((rule) => {
      switch (rule.kind) {
        case 'cal_month':
          return `${rule.every ?? '?'} mo`;
        case 'cal_day':
          return `${rule.every ?? '?'} days`;
        case 'fixed_date':
          return rule.due_on ?? 'fixed date';
        case 'cycles':
          return `${rule.every ?? '?'} cycles`;
        default:
          return `${Number(rule.every ?? 0).toFixed(1)} ${rule.kind.replace('_hr', '')} hr`;
      }
    })
    .join(' or ');
}

const styles = StyleSheet.create({
  container: { padding: space.base, gap: space.md, paddingBottom: space.xxl },
  pressed: { opacity: 0.7 },
  group: { gap: space.md },
  meta: { ...type.supporting, color: color.secondary, flexShrink: 1 },

  head: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  headPicker: { flex: 1 },
  registration: { ...type.sectionHeading, textTransform: 'uppercase' },
  bell: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: color.line,
    backgroundColor: color.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dot: {
    position: 'absolute',
    top: 9,
    right: 10,
    width: 9,
    height: 9,
    borderRadius: 5,
    backgroundColor: statusColor.urgent.ink,
    borderWidth: 2,
    borderColor: color.surface,
  },

  // Navy where the mockup says ink. §11 is the design system; the mockup is
  // the layout.
  statusCard: {
    backgroundColor: color.navy,
    borderRadius: radius.card,
    padding: space.base,
    gap: space.base,
  },
  statusHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  statusMeta: { ...type.supporting, color: color.line },
  meters: { flexDirection: 'row', gap: space.base },
  meter: { flex: 1, gap: space.xs },
  meterLabel: { ...type.supporting, color: color.line, textTransform: 'uppercase' },
  meterValue: { ...type.sectionHeading, color: color.onDark, fontVariant: ['tabular-nums'] },
  statusFoot: {
    borderTopWidth: 1,
    borderTopColor: color.navyHover,
    paddingTop: space.md,
    gap: space.xs,
  },
  statusFootText: { ...type.bodySmall, color: color.onDark },
  statusFootQuiet: { ...type.supporting, color: color.line },
  statusStrong: { ...type.label, color: color.onDark },

  pill: { paddingHorizontal: space.md, paddingVertical: space.xs, borderRadius: 999 },
  pillLabel: { ...type.supporting, textTransform: 'uppercase' },

  filterRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  segmented: {
    flex: 1,
    flexDirection: 'row',
    backgroundColor: color.subtle,
    borderRadius: radius.control,
    padding: 3,
  },
  segment: { flex: 1, paddingVertical: space.sm, borderRadius: 6, alignItems: 'center' },
  segmentOn: { backgroundColor: color.surface },
  segmentLabel: { ...type.supporting, color: color.secondary },
  segmentLabelOn: { color: color.navy },
  add: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    minHeight: 44,
    paddingHorizontal: space.md,
    borderRadius: radius.control,
    borderWidth: 1,
    borderColor: color.control,
    backgroundColor: color.surface,
  },
  addLabel: { ...type.button },

  itemCard: {
    backgroundColor: color.surface,
    borderColor: color.line,
    borderWidth: 1,
    borderRadius: radius.card,
    padding: space.base,
    gap: space.sm,
  },
  itemHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
  },
  itemNameRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flexShrink: 1 },
  itemName: { ...type.cardHeading, flexShrink: 1 },
  itemRemaining: { ...type.label, fontVariant: ['tabular-nums'] },
  itemFoot: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
  },

  defect: { gap: space.sm },
  defectHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
  },
  defectSummary: { ...type.cardHeading, flexShrink: 1 },

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
  optionRegistration: { ...type.cardHeading, textTransform: 'uppercase' },
});
