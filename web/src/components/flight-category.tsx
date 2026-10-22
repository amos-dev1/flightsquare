import type { FlightCategory } from '@flightsquare/shared';

const CATEGORIES: { value: FlightCategory; label: string }[] = [
  { value: 'personal', label: 'Personal' },
  { value: 'business', label: 'Business' },
  { value: 'maintenance', label: 'Maintenance' },
];

export function categoryLabel(category: FlightCategory | null | undefined): string | null {
  return CATEGORIES.find((one) => one.value === category)?.label ?? null;
}

/**
 * What the aeroplane was doing — the phone's "What this flight was", on the web.
 *
 * Native radios rather than buttons, so it submits with the form, keyboards
 * move through it with the arrow keys, and it needs no client state. Selection
 * is the pale surface, a heavier weight and a teal marker together (§11 §7):
 * never the colour alone.
 *
 * Descriptive only (shared `FlightCategory`): a maintenance flight still costs
 * what it costs, and the hint says so for the same reason the phone does.
 */
export function FlightCategoryChoice({ defaultValue }: { defaultValue?: string | null }) {
  const initial = CATEGORIES.some((one) => one.value === defaultValue)
    ? (defaultValue as FlightCategory)
    : 'personal';

  return (
    <fieldset className="space-y-2">
      <legend className="sr-only">What this flight was</legend>
      <div className="grid grid-cols-3 gap-2">
        {CATEGORIES.map((one) => (
          <label
            key={one.value}
            className="relative flex h-11 cursor-pointer items-center justify-center rounded-lg border border-control bg-surface px-3 text-sm font-medium text-navy transition-colors duration-150 hover:bg-subtle has-[:checked]:border-navy has-[:checked]:bg-selected has-[:checked]:font-semibold has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-navy"
          >
            <input
              type="radio"
              name="category"
              value={one.value}
              defaultChecked={one.value === initial}
              className="peer sr-only"
            />
            <span
              aria-hidden
              className="absolute inset-x-3 bottom-1 hidden h-0.5 rounded-full bg-teal peer-checked:block"
            />
            {one.label}
          </label>
        ))}
      </div>
      <p className="text-sm text-secondary">
        Recorded on the flight. It does not change what this costs.
      </p>
    </fieldset>
  );
}
