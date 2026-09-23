import { StyleSheet, Text, View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import Svg, { Path } from 'react-native-svg';
import type { MaintenanceItemResponse, ReservationResponse } from '@flightsquare/shared';

import { color, radius, space, statusColor, type } from '@/theme';

/**
 * The pieces a fleet list and an aircraft's own screen both need.
 *
 * Kept here rather than inside either screen so the badge that says
 * "Grounded" says it identically wherever it appears — a status that reads
 * one way on one screen and another way on the next is how somebody ends up
 * walking out to an aeroplane nobody meant them to fly.
 */

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/**
 * The statuses this product can actually assert, and nothing more.
 *
 * `available` comes from §3.3's `aircraft_availability` — the one resolved
 * view the booking path itself consults — and is a claim about the *records*,
 * not about the aeroplane. §11 forbids reading airworthiness out of the
 * absence of a warning, and `unknown` exists so that silence has somewhere to
 * go instead of quietly becoming "Available".
 *
 * They are not mutually exclusive. An aeroplane that is grounded and has an
 * annual coming due is both, and a card shows both.
 */
export type FleetStatus = 'available' | 'reserved' | 'grounded' | 'due_soon' | 'unknown';

/**
 * How each one is drawn.
 *
 * **Severity is in the marker, not in the fill.** Two of these are conditions
 * somebody has to act on and two are not, so only the two that matter carry a
 * marker — a short bar with square ends standing at the left edge of the line.
 * That makes the severe ones scannable down a column of cards by shape and
 * position as well as by colour, which is what §11 §13 asks for and what a
 * row of identical capsules could not do.
 *
 * Colour is confined to the icon and that marker. The word is always navy,
 * always present, and always the thing actually carrying the meaning.
 */
const STATUS: Record<
  FleetStatus,
  {
    label: string;
    icon: keyof typeof Feather.glyphMap;
    ink: string;
    /** Only the conditions that want acting on. */
    marker: boolean;
  }
> = {
  available: { label: 'Available', icon: 'check-circle', ink: statusColor.good.ink, marker: false },
  // A state of the calendar rather than of the aeroplane: nothing is wrong
  // with an aircraft somebody is out flying, so it gets no marker and its
  // icon stays navy.
  reserved: { label: 'Reserved', icon: 'calendar', ink: color.navy, marker: false },
  grounded: { label: 'Grounded', icon: 'slash', ink: statusColor.bad.ink, marker: true },
  due_soon: { label: 'Due soon', icon: 'clock', ink: statusColor.warn.ink, marker: true },
  // Nothing has told us. Said out loud rather than guessed at, and not
  // marked, because an unknown is not yet a problem.
  unknown: {
    label: 'Status unknown',
    icon: 'help-circle',
    ink: statusColor.unknown.ink,
    marker: false,
  },
};

/**
 * A status, unboxed.
 *
 * No capsule, no fill, no border, no shadow — the indicator is a marker, an
 * icon and a word sitting directly on the card. A pill would be a second
 * rounded container inside a rounded container, and four of them down a list
 * read as decoration rather than as the one thing a pilot is scanning for.
 *
 * `detail` is a second line, and only ever a fact that already exists: when a
 * booking ends, or which maintenance item is coming due and by how much.
 * Nothing here computes or guesses one — if the data is not there, the line
 * is not there.
 */
export function StatusIndicator({
  status,
  detail,
  label: override,
}: {
  status: FleetStatus;
  detail?: string | null;
  /**
   * The one case where the word is not the status's own: an item that is
   * already past its deadline says "Overdue" rather than "Due soon", which
   * would otherwise sit above a second line reading "overdue" and contradict
   * it. Same status, same threshold, same marker and icon — only the word
   * tells the truth about which side of the deadline this is.
   */
  label?: string;
}) {
  const { label, icon, ink, marker } = STATUS[status];
  const word = override ?? label;

  return (
    <View
      style={styles.indicator}
      // One label for the whole line, so a screen reader says "Grounded,
      // annual overdue" rather than spelling out an icon it cannot name.
      accessibilityRole="text"
      accessibilityLabel={detail ? `${word}. ${detail}` : word}
    >
      {/*
        The severity marker: 3 x 20, square ends, hard against the left edge.
        Its gutter is reserved on every indicator, marked or not, so the icons
        line up in one column and the markers are the only thing that breaks
        it — which is what makes them scannable rather than just coloured.
      */}
      <View style={styles.gutter}>
        {marker ? <View style={[styles.marker, { backgroundColor: ink }]} /> : null}
      </View>

      <View style={styles.indicatorText}>
        <View style={styles.indicatorLine}>
          <Feather name={icon} size={14} color={ink} />
          {/* Always the word as well as the colour and the icon (§11 §13). */}
          <Text style={styles.indicatorLabel}>{word}</Text>
        </View>
        {detail ? <Text style={styles.indicatorDetail}>{detail}</Text> : null}
      </View>
    </View>
  );
}

/**
 * Whether the nearest maintenance item is already past its deadline.
 *
 * The same set `statusesFor` counts as due — no new threshold — asked a
 * second way so the indicator can pick the honest word.
 */
export function maintenanceIsOverdue(
  items: MaintenanceItemResponse[],
  aircraftId: string,
): boolean {
  return items.some(
    (item) =>
      item.aircraft_id === aircraftId && item.state === 'overdue' && item.ever_complied,
  );
}

/**
 * Which badges an aeroplane wears.
 *
 * Order is deliberate and the rules are the product's, not this component's:
 *
 * - **Grounded wins the first slot and is never hidden.** §3.3 routes a
 *   grounding squawk and an overdue grounding item through
 *   `aircraft_availability`, and something the booking path will refuse must
 *   not be sitting behind a calendar badge.
 * - **Reserved is a second badge, not a replacement.** A grounded aeroplane
 *   with a booking on it is exactly the case a club needs to see.
 * - **Due soon can accompany either**, because §3.6 intervals tick down
 *   whatever the aeroplane is doing today.
 * - **Unknown when nothing has told us.** Not "Available".
 */
export function statusesFor(input: {
  available: boolean | undefined;
  reservedNow: boolean;
  dueSoon: boolean;
}): FleetStatus[] {
  const badges: FleetStatus[] = [];

  if (input.available === undefined) badges.push('unknown');
  else if (input.available) badges.push('available');
  else badges.push('grounded');

  if (input.reservedNow) badges.push('reserved');
  if (input.dueSoon) badges.push('due_soon');

  return badges;
}

/**
 * When the aeroplane is free again.
 *
 * The booking's own `ends_at`, formatted — nothing is worked out here. A
 * reservation that runs past today says which day as well, because "until
 * 09:00" on a Tuesday evening would read as ten hours from now when it is
 * really thirty-four.
 */
export function reservationDetail(reservation: ReservationResponse | undefined): string | null {
  if (!reservation) return null;
  const ends = new Date(reservation.ends_at);
  const sameDay = ends.toDateString() === new Date().toDateString();
  return `Until ${ends.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })}${sameDay ? '' : ` on ${ends.toLocaleDateString(undefined, { weekday: 'short' })}`}`;
}

/**
 * Which item is closest, and by how much.
 *
 * Both numbers come off the server (§8.2): `days_remaining` and
 * `hours_remaining` are computed there against whichever meter the item
 * specifies, and this only picks the nearest of them and names it. §3.6 says
 * an item can be due on more than one basis at once and the earliest wins,
 * which is why days and hours are compared separately rather than converted
 * into one another — an hour of flying is not a day of calendar.
 *
 * `overdue` with `ever_complied === false` is excluded here exactly as it is
 * from the badge: an interval seeded with the aeroplane that nobody has
 * confirmed is unknown rather than due, and naming a deadline for it would
 * assert something nothing supports.
 */
export function maintenanceDetail(
  items: MaintenanceItemResponse[],
  aircraftId: string,
): string | null {
  const due = items.filter(
    (item) =>
      item.aircraft_id === aircraftId &&
      (item.state === 'due_soon' || (item.state === 'overdue' && item.ever_complied)),
  );
  if (due.length === 0) return null;

  // Overdue first, then whichever is closest on either basis.
  const nearest = due.reduce((closest, item) =>
    rank(item) < rank(closest) ? item : closest,
  );

  // Just the name: the indicator above already says "Overdue", and saying
  // it twice in two lines is noise where the useful fact is *which item*.
  if (nearest.state === 'overdue') return nearest.name;

  const days = nearest.days_remaining;
  const hours = nearest.hours_remaining === null ? null : Number(nearest.hours_remaining);

  if (days !== null && (hours === null || days <= hours)) {
    return `${nearest.name} · ${days} ${days === 1 ? 'day' : 'days'}`;
  }
  if (hours !== null) return `${nearest.name} · ${hours.toFixed(1)} h`;
  return nearest.name;
}

/** Smaller is closer. Overdue sorts ahead of everything still to come. */
function rank(item: MaintenanceItemResponse): number {
  if (item.state === 'overdue') return -1;
  const days = item.days_remaining ?? Number.POSITIVE_INFINITY;
  const hours =
    item.hours_remaining === null ? Number.POSITIVE_INFINITY : Number(item.hours_remaining);
  return Math.min(days, hours);
}

// ---------------------------------------------------------------------------
// Thumbnail
// ---------------------------------------------------------------------------

/**
 * A placeholder, not a photograph.
 *
 * **Nothing in the schema stores an aircraft image.** `aircraft_documents`
 * holds the airworthiness certificate, the registration, insurance and weight
 * and balance; none of those is a picture of the aeroplane. So this is a
 * marked, honest space — never stock imagery standing in for a real one.
 *
 * Drawn here rather than taken from the icon set because the icon set has no
 * aeroplane, and §11 is explicit that the official logo is never used as one.
 * This is a plain top-down outline that looks nothing like the mark.
 *
 * When photographs exist this component takes an `<Image>` and the callers do
 * not change.
 */
export function AircraftThumbnail({ size = 'large' }: { size?: 'large' | 'small' }) {
  const box = size === 'large' ? styles.thumbLarge : styles.thumbSmall;
  const glyph = size === 'large' ? 44 : 26;

  return (
    <View style={[styles.thumb, box]} accessibilityElementsHidden importantForAccessibility="no">
      <Svg width={glyph} height={glyph} viewBox="0 0 24 24" fill="none">
        <Path
          d="M12 2.5c.9 0 1.5 1.2 1.5 3v3.2l7.5 4.3v2.1l-7.5-2.3v3.8l2.4 1.7v1.6L12 19l-3.9.9v-1.6l2.4-1.7v-3.8L3 15.1V13l7.5-4.3V5.5c0-1.8.6-3 1.5-3Z"
          stroke={color.secondary}
          strokeWidth={1.4}
          strokeLinejoin="round"
        />
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  // flex-start, not centre: a two-line indicator must keep its marker beside
  // the status it marks rather than floating down between the two lines.
  indicator: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm },
  gutter: { width: 3, alignItems: 'center' },
  marker: {
    width: 3,
    height: 20,
    // Square ends: a rounded cap would read as another small pill, which is
    // the thing this treatment exists to avoid.
    borderRadius: 0,
  },
  indicatorText: { flex: 1, gap: 1 },
  // 6, not a scale step: §11's 4/8/12 scale sets layout rhythm, and this is
  // the optical gap inside a single compound label.
  indicatorLine: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 20 },
  indicatorLabel: { ...type.label, fontSize: 14, color: color.navy },
  indicatorDetail: { ...type.supporting, fontSize: 12, color: color.secondary },

  thumb: {
    backgroundColor: color.mist,
    // A boundary, because the tile is mist and so is the page behind the
    // aircraft's own screen — without it the placeholder vanishes into the
    // canvas and the glyph looks like it is floating.
    borderWidth: 1,
    borderColor: color.line,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  thumbLarge: { width: 84, height: 84, borderRadius: radius.card },
  thumbSmall: { width: 56, height: 56, borderRadius: 8 },
});
