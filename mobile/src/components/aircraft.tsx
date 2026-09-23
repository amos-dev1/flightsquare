import { StyleSheet, Text, View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import Svg, { Path } from 'react-native-svg';

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

const STATUS: Record<
  FleetStatus,
  { label: string; icon: keyof typeof Feather.glyphMap; tone: keyof typeof statusColor }
> = {
  available: { label: 'Available', icon: 'check-circle', tone: 'good' },
  // A state of the calendar rather than of the aeroplane, which is why it is
  // the neutral tone: nothing is wrong with an aircraft somebody is flying.
  reserved: { label: 'Reserved', icon: 'calendar', tone: 'neutral' },
  grounded: { label: 'Grounded', icon: 'slash', tone: 'bad' },
  due_soon: { label: 'Due soon', icon: 'clock', tone: 'warn' },
  unknown: { label: 'Status unknown', icon: 'help-circle', tone: 'unknown' },
};

export function StatusBadge({ status, small }: { status: FleetStatus; small?: boolean }) {
  const { label, icon, tone } = STATUS[status];
  const { surface, ink } = statusColor[tone];

  return (
    <View
      style={[styles.badge, small && styles.badgeSmall, { backgroundColor: surface }]}
      // One label for the whole pill, so a screen reader says "Grounded"
      // rather than spelling out an icon it cannot name.
      accessibilityRole="text"
      accessibilityLabel={label}
    >
      <Feather name={icon} size={small ? 13 : 15} color={ink} />
      {/* Always the word as well as the colour and the icon (§11 §13). */}
      <Text style={[small ? styles.badgeLabelSmall : styles.badgeLabel, { color: ink }]}>
        {label}
      </Text>
    </View>
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
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: 999,
  },
  badgeSmall: { paddingHorizontal: space.sm, paddingVertical: space.xs },
  badgeLabel: { ...type.button },
  badgeLabelSmall: { ...type.supporting, fontSize: 12 },

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
