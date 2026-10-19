'use client';

import { useEffect, useRef, useState } from 'react';

import type { AircraftFlightStatsResponse } from '@flightsquare/shared';

type Month = AircraftFlightStatsResponse['monthly_hours'][number];

const HEIGHT = 168;
const PAD = { top: 20, right: 4, bottom: 24, left: 36 };
const MAX_BAR = 24;

/**
 * Hours flown each month, one column per month, oldest on the left.
 *
 * Teal for the one series (§12), which on white measures about 2.2:1 — under
 * the 3:1 a mark should have on its own. So the figures do not rest on the
 * colour: the busiest month and the current one carry their value, every
 * column answers on hover or tap, and a table says all twelve to a screen
 * reader.
 *
 * Drawn at the container's real width rather than scaled from a viewBox, so
 * the labels stay 12px on a phone instead of shrinking with the chart.
 */
export function MonthlyHoursChart({
  months,
  meter,
  asOf,
}: {
  months: Month[];
  meter: 'hobbs' | 'tach';
  asOf: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(480);
  const [active, setActive] = useState<number | null>(null);

  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(240, Math.floor(entry.contentRect.width)));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const meterName = meter === 'hobbs' ? 'Hobbs' : 'Tach';
  const hours = months.map((m) => Number(meter === 'hobbs' ? m.hobbs_hours : m.tach_hours));
  const label = (i: number) => (meter === 'hobbs' ? months[i]?.hobbs_hours : months[i]?.tach_hours);
  const current = months.length - 1;
  const busiest = hours.reduce((best, h, i) => (h > (hours[best] ?? 0) ? i : best), 0);

  const top = niceCeiling(Math.max(...hours, 0));
  const plotW = width - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const band = plotW / Math.max(months.length, 1);
  const barW = Math.min(MAX_BAR, band * 0.6);
  const y = (h: number) => PAD.top + plotH - (top === 0 ? 0 : (h / top) * plotH);
  const ticks = [0, top / 2, top];
  // Every month's name where there is room for it, every other one where not.
  const step = band >= 28 ? 1 : 2;

  const thisMonth = asOf.slice(0, 7);
  const directLabels = new Set(hours[busiest] ? [busiest, current] : [current]);

  return (
    <div ref={box} className="relative w-full min-w-0">
      <svg width={width} height={HEIGHT} aria-hidden className="block overflow-visible">
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              x1={PAD.left}
              x2={width - PAD.right}
              y1={y(tick)}
              y2={y(tick)}
              stroke="var(--color-line)"
              strokeWidth={1}
            />
            <text
              x={PAD.left - 8}
              y={y(tick)}
              dy="0.32em"
              textAnchor="end"
              className="tabular fill-secondary text-xs"
            >
              {formatTick(tick)}
            </text>
          </g>
        ))}

        {months.map((month, i) => {
          const h = hours[i] ?? 0;
          const cx = PAD.left + band * i + band / 2;
          const yTop = y(h);
          return (
            <g key={month.month}>
              {active === i ? (
                <rect
                  x={PAD.left + band * i}
                  y={PAD.top}
                  width={band}
                  height={plotH}
                  fill="var(--color-subtle)"
                />
              ) : null}
              {h > 0 ? (
                <path d={column(cx - barW / 2, yTop, barW, y(0) - yTop)} fill="var(--color-teal)" />
              ) : null}
              {directLabels.has(i) && active === null && h > 0 ? (
                <text
                  x={cx}
                  y={yTop - 6}
                  textAnchor="middle"
                  className="tabular fill-navy text-xs font-semibold"
                >
                  {label(i)}
                </text>
              ) : null}
              {i % step === (current % step) ? (
                <text
                  x={cx}
                  y={HEIGHT - 6}
                  textAnchor="middle"
                  className="fill-secondary text-xs"
                >
                  {monthName(month.month, 'short')}
                </text>
              ) : null}
              {/* The whole column answers, not just the bar: a short month
                  is still worth asking about, and an empty one most of all. */}
              <rect
                x={PAD.left + band * i}
                y={PAD.top}
                width={band}
                height={plotH + PAD.bottom}
                fill="transparent"
                onMouseEnter={() => setActive(i)}
                onMouseLeave={() => setActive(null)}
                onClick={() => setActive(active === i ? null : i)}
              />
            </g>
          );
        })}

        <line
          x1={PAD.left}
          x2={width - PAD.right}
          y1={y(0)}
          y2={y(0)}
          stroke="var(--color-control)"
          strokeWidth={1}
        />
      </svg>

      {active !== null && months[active] ? (
        <Tooltip
          month={months[active]}
          value={label(active) ?? '0'}
          meterName={meterName}
          partial={months[active].month === thisMonth}
          left={PAD.left + band * active + band / 2}
          top={y(hours[active] ?? 0)}
          width={width}
        />
      ) : null}

      <table className="sr-only">
        <caption>Hours flown per month, {meterName}</caption>
        <thead>
          <tr>
            <th scope="col">Month</th>
            <th scope="col">{meterName} hours</th>
            <th scope="col">Flights</th>
          </tr>
        </thead>
        <tbody>
          {months.map((month, i) => (
            <tr key={month.month}>
              <th scope="row">
                {monthName(month.month, 'long')}
                {month.month === thisMonth ? ' (so far)' : ''}
              </th>
              <td>{label(i)}</td>
              <td>{month.flights}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Tooltip({
  month,
  value,
  meterName,
  partial,
  left,
  top,
  width,
}: {
  month: Month;
  value: string;
  meterName: string;
  partial: boolean;
  left: number;
  top: number;
  width: number;
}) {
  // Kept inside the card at either end rather than hanging off it.
  const clamped = Math.min(Math.max(left, 72), width - 72);
  return (
    <div
      className="pointer-events-none absolute z-10 w-36 -translate-x-1/2 -translate-y-full rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-sm"
      style={{ left: clamped, top: top - 8 }}
    >
      <p className="font-semibold">
        {monthName(month.month, 'long')}
        {partial ? ' so far' : ''}
      </p>
      <p className="tabular mt-0.5 text-secondary">
        {value} hrs {meterName} · {month.flights} {month.flights === 1 ? 'flight' : 'flights'}
      </p>
    </div>
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

function formatTick(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/** `2026-10` → "Oct" / "October 2026". Built from parts, never parsed as a
 *  date: `new Date('2026-10')` is UTC midnight and reads as September west
 *  of Greenwich. */
function monthName(month: string, style: 'short' | 'long'): string {
  const [year, index] = month.split('-').map(Number);
  const date = new Date(year ?? 1970, (index ?? 1) - 1, 1);
  return style === 'short'
    ? date.toLocaleString('en-US', { month: 'short' })
    : date.toLocaleString('en-US', { month: 'long', year: 'numeric' });
}
