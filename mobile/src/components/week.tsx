import { Pressable, StyleSheet, Text, View } from 'react-native';

import { color, radius, space, type } from '@/theme';

/**
 * Seven days, Monday first.
 *
 * The week is the unit a club thinks in — "who has it Saturday" — and this is
 * the part that has to survive a phone's width. Seven columns of *time* would
 * not: a 50pt column can hold about four characters, and §11 §9 asks dense
 * tables to adapt rather than to hide or shrink what they say. So the strip
 * carries only which days have something on them, and the day below carries
 * the detail.
 *
 * Nothing here is coloured-only. Today is a ring and the selected day is a
 * fill — different shapes, not different hues — and the exact counts are in
 * the accessible label rather than left to whoever can resolve three dots.
 */

export interface DayMarks {
  bookings: number;
  blackouts: number;
}

/** More than this and the dots stop counting and start being a texture. */
const MAX_DOTS = 3;

export function WeekStrip({
  days,
  selected,
  today,
  marksFor,
  onSelect,
}: {
  /** Seven `YYYY-MM-DD`, Monday first. */
  days: string[];
  selected: string;
  /** Today in the club's zone, which need not be today on this phone. */
  today: string;
  marksFor: (day: string) => DayMarks;
  onSelect: (day: string) => void;
}) {
  return (
    <View style={styles.strip}>
      {days.map((day) => {
        const marks = marksFor(day);
        const isToday = day === today;
        const isSelected = day === selected;
        const total = marks.bookings + marks.blackouts;

        return (
          <Pressable
            key={day}
            onPress={() => onSelect(day)}
            accessibilityRole="button"
            accessibilityState={{ selected: isSelected }}
            accessibilityLabel={describe(day, isToday, marks)}
            style={({ pressed }) => [styles.cell, pressed && styles.pressed]}
          >
            <Text style={[styles.weekday, isSelected && styles.weekdaySelected]}>
              {weekdayLetter(day)}
            </Text>

            <View
              style={[
                styles.box,
                // A ring for today, a fill for the day being shown. Two
                // different shapes, so the pair survives without colour.
                isToday && !isSelected && styles.boxToday,
                isSelected && styles.boxSelected,
              ]}
            >
              <Text style={[styles.date, isSelected && styles.dateSelected]}>
                {day.slice(8)}
              </Text>
            </View>

            {/* A texture, not a number — the number is in the label. */}
            <View style={styles.dots}>
              {Array.from({ length: Math.min(total, MAX_DOTS) }, (_, index) => (
                <View
                  key={index}
                  style={[
                    styles.dot,
                    isSelected && styles.dotSelected,
                    // Blackouts are counted last, so the trailing dots are
                    // the ones that are not somebody's booking.
                    index >= marks.bookings && styles.dotBlackout,
                  ]}
                />
              ))}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

/** The whole cell in one sentence, because seven of these are a lot to hear. */
function describe(day: string, isToday: boolean, marks: DayMarks): string {
  const full = new Intl.DateTimeFormat(undefined, {
    timeZone: 'UTC',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(new Date(`${day}T12:00:00Z`));

  const parts: string[] = [full];
  if (isToday) parts.push('today');
  if (marks.bookings > 0) {
    parts.push(`${marks.bookings} ${marks.bookings === 1 ? 'booking' : 'bookings'}`);
  }
  if (marks.blackouts > 0) {
    parts.push(`${marks.blackouts} unavailable`);
  }
  if (marks.bookings === 0 && marks.blackouts === 0) parts.push('nothing booked');
  return parts.join(', ');
}

/**
 * "M", "T", "W"… in whatever language the phone is in.
 *
 * Formatted as UTC: the argument is a plain calendar date with no zone of its
 * own, and rendering the noon anchor in a far-eastern zone would name the
 * following day.
 */
function weekdayLetter(day: string): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: 'UTC',
    weekday: 'narrow',
  }).format(new Date(`${day}T12:00:00Z`));
}

const styles = StyleSheet.create({
  strip: { flexDirection: 'row', justifyContent: 'space-between' },
  // §11 §13 asks for 44 x 44; the cell is the touch target, not the box.
  cell: { flex: 1, minHeight: 64, alignItems: 'center', gap: space.xs, paddingVertical: space.xs },
  pressed: { opacity: 0.6 },

  weekday: { ...type.supporting, fontSize: 12, color: color.secondary },
  weekdaySelected: { color: color.navy },

  box: {
    width: 34,
    height: 34,
    borderRadius: radius.control,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: 'transparent',
  },
  boxToday: { borderColor: color.teal },
  boxSelected: { backgroundColor: color.navy, borderColor: color.navy },

  date: { ...type.label, fontSize: 15, fontVariant: ['tabular-nums'] },
  dateSelected: { color: color.onDark },

  // Reserved whether or not there are dots, so the boxes stay in a row.
  dots: { flexDirection: 'row', gap: 3, height: 5, alignItems: 'center' },
  dot: { width: 5, height: 5, borderRadius: 2.5, backgroundColor: color.navy },
  dotSelected: { backgroundColor: color.navy },
  dotBlackout: { backgroundColor: color.slate },
});
