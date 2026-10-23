import { StyleSheet, Text, View } from 'react-native';
import type { MaintenanceState } from '@flightsquare/shared';

import { space, statusColor, type } from '@/theme';

/*
  How a maintenance state reads on the phone — its colour, its word, and how
  far away it is — shared by the Maintenance screen and the dashboard, which
  show the same items and must not disagree about what they are called.
*/

export function Pill({ state, label }: { state: MaintenanceState; label: string }) {
  const tone = toneOf(state);
  return (
    <View style={[styles.pill, { backgroundColor: tone.surface, borderColor: tone.line ?? tone.ink }]}>
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
export function toneOf(state: MaintenanceState): { surface: string; ink: string; line?: string } {
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
      return statusColor.clear;
  }
}

export function wordFor(state: MaintenanceState): string {
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
export function remainingLabel(kind: string | null, remaining: string | null): string {
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

const styles = StyleSheet.create({
  pill: { paddingHorizontal: space.md, paddingVertical: space.xs, borderWidth: 1, borderStyle: 'dashed' },
  pillLabel: { ...type.supporting, textTransform: 'uppercase' },
});
