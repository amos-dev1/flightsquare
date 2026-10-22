import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Line, Path, Text as SvgText } from 'react-native-svg';
import type { AircraftFlightStatsResponse } from '@flightsquare/shared';

import { color, font, radius, space, type } from '@/theme';

type Month = AircraftFlightStatsResponse['monthly_hours'][number];

/**
 * How the aeroplane is being used — the phone's copy of the web dashboard's
 * card: hours flown each month as a column chart, this year so far, and fuel
 * burned per hour.
 *
 * Every figure is the server's (§8.2); this only chooses which meter to show
 * and says what each one rests on. Hobbs where the aeroplane has one and tach
 * where it has only that, named on every figure (§11), because "hours" alone
 * is two different numbers (§3.4).
 */
export function AircraftStats({
  stats,
  meter,
}: {
  stats: AircraftFlightStatsResponse;
  meter: 'hobbs' | 'tach';
}) {
  const meterName = meter === 'hobbs' ? 'Hobbs' : 'Tach';
  const { year_to_date: ytd, fuel_burn: burn } = stats;
  const flownInWindow = stats.monthly_hours.some((month) => month.flights > 0);
  const burnRate = meter === 'hobbs' ? burn.per_hobbs_hour : burn.per_tach_hour;
  const fuelUnit = burn.units === 'litres' ? 'L' : 'gal';

  return (
    <View style={styles.card}>
      <View style={styles.block}>
        <Text style={styles.heading}>Hours flown per month</Text>
        <Text style={styles.note}>{meterName} · last 12 months</Text>
        {flownInWindow ? (
          <MonthlyHoursChart months={stats.monthly_hours} meter={meter} asOf={stats.as_of} />
        ) : (
          <Text style={styles.empty}>No flights in the last 12 months.</Text>
        )}
      </View>

      <View style={styles.rule} />

      <Stat
        label="Year to date"
        note={`${meterName} · ${ytd.flights} ${ytd.flights === 1 ? 'flight' : 'flights'} in ${stats.as_of.slice(0, 4)}`}
        value={meter === 'hobbs' ? ytd.hobbs_hours : ytd.tach_hours}
        unit="hrs"
      />

      <View style={styles.rule} />

      {/*
        Said to be an estimate, and what it rests on, because it is: gauge
        readings a pilot wrote down, before and after (§3.4 — pilots estimate,
        gauges lie). Not a fuel-flow measurement and not to be planned on.
      */}
      <Stat
        label="Average fuel burn"
        note={
          burnRate === null
            ? 'Needs fuel recorded before and after on 3 flights'
            : `Estimate · per ${meterName} hour · from ${burn.flights} flights`
        }
        value={burnRate}
        unit={`${fuelUnit}/hr`}
      />
    </View>
  );
}

function Stat({
  label,
  note,
  value,
  unit,
}: {
  label: string;
  note: string;
  value: string | null;
  unit: string;
}) {
  return (
    <View
      style={styles.stat}
      accessible
      accessibilityLabel={`${label}: ${value === null ? 'not enough data' : `${value} ${unit}`}. ${note}`}
    >
      <View style={styles.statText}>
        <Text style={styles.heading}>{label}</Text>
        <Text style={styles.note}>{note}</Text>
      </View>
      <Text style={styles.statValue}>
        {value ?? '—'}
        {value !== null ? <Text style={styles.statUnit}> {unit}</Text> : null}
      </Text>
    </View>
  );
}

const HEIGHT = 150;
const PAD = { top: 20, right: 4, bottom: 22, left: 30 };
const MAX_BAR = 20;

/**
 * Hours flown each month, one column per month, oldest on the left.
 *
 * Teal for the one series (§12), which on white measures about 2.2:1 — under
 * the 3:1 a mark should have on its own — so the figures do not rest on the
 * colour: the busiest month and the current one carry their value, a tap on
 * any column says its hours and flights in words below, and the whole series
 * is read out to a screen reader. There is no hover on a phone, so the tap is
 * the tooltip.
 *
 * Drawn at the measured width rather than scaled, so the labels stay 12px.
 */
function MonthlyHoursChart({
  months,
  meter,
  asOf,
}: {
  months: Month[];
  meter: 'hobbs' | 'tach';
  asOf: string;
}) {
  const [width, setWidth] = useState(0);
  const [active, setActive] = useState<number | null>(null);

  const meterName = meter === 'hobbs' ? 'Hobbs' : 'Tach';
  const label = (m: Month) => (meter === 'hobbs' ? m.hobbs_hours : m.tach_hours);
  const hours = months.map((m) => Number(label(m)));
  const current = months.length - 1;
  const busiest = hours.reduce((best, h, i) => (h > (hours[best] ?? 0) ? i : best), 0);
  const thisMonth = asOf.slice(0, 7);

  const top = niceCeiling(Math.max(...hours, 0));
  const plotW = Math.max(width - PAD.left - PAD.right, 0);
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const band = plotW / Math.max(months.length, 1);
  const barW = Math.min(MAX_BAR, band * 0.6);
  const y = (h: number) => PAD.top + plotH - (top === 0 ? 0 : (h / top) * plotH);
  // Every other month's name on a phone: twelve three-letter months at 12px
  // do not fit in 340 points.
  const step = band >= 30 ? 1 : 2;
  const direct = new Set(hours[busiest] ? [busiest, current] : [current]);

  const summary = months
    .map((m) => `${monthName(m.month, 'long')}${m.month === thisMonth ? ' so far' : ''}: ${label(m)} hours`)
    .join(', ');

  const chosen = active !== null ? months[active] : undefined;

  return (
    <View>
      <View
        onLayout={(event) => setWidth(Math.floor(event.nativeEvent.layout.width))}
        accessible
        accessibilityRole="image"
        accessibilityLabel={`Hours flown per month, ${meterName}. ${summary}.`}
        style={styles.chart}
      >
        {width > 0 ? (
          <Svg width={width} height={HEIGHT}>
            {[0, top / 2, top].map((tick) => (
              <Line
                key={`grid-${tick}`}
                x1={PAD.left}
                x2={width - PAD.right}
                y1={y(tick)}
                y2={y(tick)}
                stroke={tick === 0 ? color.control : color.line}
                strokeWidth={1}
              />
            ))}
            {[0, top / 2, top].map((tick) => (
              <SvgText
                key={`tick-${tick}`}
                x={PAD.left - 6}
                y={y(tick) + 4}
                textAnchor="end"
                fontSize={12}
                fontFamily={font.regular}
                fill={color.secondary}
              >
                {Number.isInteger(tick) ? String(tick) : tick.toFixed(1)}
              </SvgText>
            ))}

            {months.map((month, i) => {
              const h = hours[i] ?? 0;
              const cx = PAD.left + band * i + band / 2;
              const yTop = y(h);
              return (
                <Path
                  key={`bar-${month.month}`}
                  d={h > 0 ? column(cx - barW / 2, yTop, barW, y(0) - yTop) : ''}
                  // The chosen column steps up to navy, so "which one did I
                  // tap" is answered by the mark as well as the words below.
                  fill={active === i ? color.navy : color.teal}
                />
              );
            })}

            {months.map((month, i) =>
              direct.has(i) && active === null && (hours[i] ?? 0) > 0 ? (
                <SvgText
                  key={`value-${month.month}`}
                  x={PAD.left + band * i + band / 2}
                  y={y(hours[i] ?? 0) - 6}
                  textAnchor="middle"
                  fontSize={12}
                  fontFamily={font.semibold}
                  fill={color.navy}
                >
                  {label(month)}
                </SvgText>
              ) : null,
            )}

            {months.map((month, i) =>
              i % step === current % step ? (
                <SvgText
                  key={`month-${month.month}`}
                  x={PAD.left + band * i + band / 2}
                  y={HEIGHT - 6}
                  textAnchor="middle"
                  fontSize={12}
                  fontFamily={font.regular}
                  fill={color.secondary}
                >
                  {monthName(month.month, 'short')}
                </SvgText>
              ) : null,
            )}
          </Svg>
        ) : null}

        {/* Each whole column answers a tap, not just its bar: a short month is
            still worth asking about, and an empty one most of all. */}
        {width > 0 ? (
          <View style={[StyleSheet.absoluteFill, styles.hits, { left: PAD.left, right: PAD.right }]}>
            {months.map((month, i) => (
              <Pressable
                key={`hit-${month.month}`}
                onPress={() => setActive(active === i ? null : i)}
                accessibilityElementsHidden
                importantForAccessibility="no"
                style={styles.hit}
              />
            ))}
          </View>
        ) : null}
      </View>

      <Text style={styles.caption}>
        {chosen
          ? `${monthName(chosen.month, 'long')}${chosen.month === thisMonth ? ' so far' : ''} · ${label(chosen)} hrs ${meterName} · ${chosen.flights} ${chosen.flights === 1 ? 'flight' : 'flights'}`
          : 'Tap a month for its hours and flights.'}
      </Text>
    </View>
  );
}

/** A column with 4px rounded ends at the top and square at the baseline. */
function column(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h);
  return [
    `M${x},${y + h}`,
    `V${y + r}`,
    `Q${x},${y} ${x + r},${y}`,
    `H${x + w - r}`,
    `Q${x + w},${y} ${x + w},${y + r}`,
    `V${y + h}`,
    'Z',
  ].join(' ');
}

/** Round the top of the scale up to something a person would mark an axis with. */
function niceCeiling(max: number): number {
  if (max <= 0) return 0;
  for (const step of [1, 2, 4, 5, 10, 20, 25, 50, 100, 200, 500]) {
    if (max <= step * 2) return step * 2;
  }
  return Math.ceil(max / 500) * 500;
}

/** `2026-10` → "Oct" / "October 2026", built from parts rather than parsed:
 *  `new Date('2026-10')` is UTC midnight and reads as September west of it. */
function monthName(month: string, style: 'short' | 'long'): string {
  const [year, index] = month.split('-').map(Number);
  const date = new Date(year ?? 1970, (index ?? 1) - 1, 1);
  return style === 'short'
    ? date.toLocaleString('en-US', { month: 'short' })
    : date.toLocaleString('en-US', { month: 'long', year: 'numeric' });
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: color.surface,
    borderColor: color.line,
    borderWidth: 1,
    borderRadius: radius.card,
  },
  block: { padding: space.base, gap: 2 },
  heading: { ...type.cardHeading },
  note: { ...type.supporting, color: color.secondary },
  empty: { ...type.bodySmall, color: color.secondary, marginTop: space.sm },
  rule: { height: 1, backgroundColor: color.line },
  chart: { marginTop: space.md, height: HEIGHT },
  hits: { flexDirection: 'row' },
  hit: { flex: 1 },
  caption: { ...type.supporting, color: color.secondary, marginTop: space.xs },
  stat: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.base,
  },
  statText: { flex: 1, gap: 2 },
  statValue: { ...type.sectionHeading },
  statUnit: { ...type.bodySmall, color: color.secondary },
});
