import { AlertTriangle, Ban, CalendarClock, Check, Clock, Info, Plane } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';

/**
 * Shared components, owned outright — no component-library runtime and
 * nothing to theme around.
 *
 * Inter throughout — §11 §4 makes it the whole operational interface, and
 * Manrope is kept for the brand roles it names. The §11 type scale lives here
 * rather than being retyped per screen:
 *
 *   page title      text-3xl font-semibold    (30px / 600)
 *   section heading text-xl font-semibold     (20px / 600)
 *   card heading    text-base font-semibold   (16px / 600)
 *   body            text-sm / text-base       (14–16px / 400)
 *   form input      text-base                 (16px — also stops iOS zooming
 *                                              the page on focus)
 *   button, label   text-sm font-semibold     (14px / 600)
 *   supporting      text-xs                   (12px)
 *   key metric      text-3xl font-semibold    (30px / 600)
 *
 * Radii: 8px on buttons and inputs, 12px on cards and dialogs. Borders rather
 * than shadows, with elevation kept for things that genuinely float.
 */

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border border-line bg-surface ${className}`}>{children}</div>
  );
}

export function PageTitle({ children }: { children: ReactNode }) {
  // 600, not 700: §11's scale tops out at semibold for a page title, and
  // Inter at 700 is heavier than Manrope was at the same weight.
  return <h1 className="text-3xl font-semibold tracking-tight">{children}</h1>;
}

export function SectionHeading({ children }: { children: ReactNode }) {
  return <h2 className="text-xl font-semibold tracking-tight">{children}</h2>;
}

export function Button({
  variant = 'primary',
  className = '',
  ...props
}: ComponentProps<'button'> & { variant?: 'primary' | 'secondary' | 'tertiary' }) {
  // §11 §6: the primary action is navy with white text, and teal is never a
  // button fill — it is selection and emphasis. One dominant primary per
  // workflow.
  const styles = {
    primary: 'bg-navy text-on-dark hover:bg-navy-hover disabled:bg-slate',
    secondary: 'border border-control bg-surface text-navy hover:bg-subtle',
    tertiary: 'text-navy hover:bg-subtle',
  }[variant];

  return (
    <button
      {...props}
      className={`inline-flex h-11 items-center justify-center gap-2 rounded-lg px-4 text-sm font-semibold transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-60 ${styles} ${className}`}
    />
  );
}

export function Field({
  label,
  hint,
  required,
  error,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  error?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-2 block text-sm font-semibold">
        {label}
        {/* Required is marked with a word, not a colour or a bare asterisk. */}
        {required ? <span className="ml-1 font-normal text-secondary">(required)</span> : null}
      </span>
      {children}
      {hint ? <span className="mt-1.5 block text-xs text-secondary">{hint}</span> : null}
      {error ? (
        <span className="mt-1.5 flex items-center gap-1.5 text-xs font-medium">
          {/* Icon as well as text: never meaning through colour alone. */}
          <AlertTriangle aria-hidden size={14} strokeWidth={2} />
          {error}
        </span>
      ) : null}
    </label>
  );
}

/**
 * §11 §8: white fields, navy text, a boundary that actually says where the
 * field is. `border-control` rather than the decorative divider token,
 * because the guideline is explicit that the subtle border is not enough
 * when the boundary identifies the control.
 */
const controlStyles =
  'h-11 w-full rounded-lg border border-control bg-surface px-3 text-base text-navy ' +
  'transition-colors duration-150 placeholder:text-secondary ' +
  'disabled:bg-subtle disabled:text-secondary read-only:bg-subtle ' +
  'aria-[invalid=true]:border-navy aria-[invalid=true]:border-2';

export function Input({ className = '', ...props }: ComponentProps<'input'>) {
  return <input {...props} className={`${controlStyles} ${className}`} />;
}

export function Select({ className = '', ...props }: ComponentProps<'select'>) {
  return <select {...props} className={`${controlStyles} ${className}`} />;
}

export function Textarea({ className = '', ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      {...props}
      className={`${controlStyles} h-auto min-h-22 py-2.5 ${className}`}
    />
  );
}

/** Form-level feedback, distinguished by an icon rather than by colour. */
export function Alert({ children, tone = 'error' }: { children: ReactNode; tone?: 'error' | 'info' }) {
  const Icon = tone === 'error' ? AlertTriangle : Info;
  return (
    <p
      role={tone === 'error' ? 'alert' : 'status'}
      className="flex items-start gap-2 rounded-lg border border-navy bg-subtle px-3 py-2.5 text-sm"
    >
      <Icon aria-hidden size={16} strokeWidth={2} className="mt-0.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-line px-6 py-12 text-center">
      <p className="text-base font-semibold">{title}</p>
      {children ? <div className="mt-2 text-sm text-secondary">{children}</div> : null}
    </div>
  );
}

/**
 * The aeroplane's picture (0043), or a quiet placeholder where there is none.
 *
 * A placeholder rather than nothing so a fleet list keeps its alignment; it is
 * a generic outline icon on mist, never the logo (§11 §10). Not next/image:
 * the host is object storage and the URL is signed and expires. The picture is
 * decoration beside a registration that is always printed, so its alt text is
 * empty unless the caller says otherwise.
 */
export function AircraftPhoto({
  photo,
  size = 'sm',
  alt = '',
  className = '',
}: {
  photo?: { url: string } | null;
  size?: 'sm' | 'md' | 'lg';
  alt?: string;
  className?: string;
}) {
  const box = {
    sm: 'h-12 w-16 rounded-lg',
    md: 'h-16 w-24 rounded-lg',
    lg: 'aspect-[4/3] w-full max-w-sm rounded-xl',
  }[size];

  if (!photo) {
    return (
      <div
        aria-hidden
        className={`flex shrink-0 items-center justify-center border border-line bg-mist text-slate ${box} ${className}`}
      >
        <Plane size={size === 'lg' ? 24 : 20} strokeWidth={1.75} />
      </div>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={photo.url}
      alt={alt}
      className={`shrink-0 border border-line bg-mist object-cover ${box} ${className}`}
    />
  );
}

/**
 * A meter value, or an honest dash when nothing has been read yet.
 *
 * §11: Hobbs and tach are distinguished explicitly, and units are named — so
 * the label always travels with the number rather than being implied by
 * column position.
 */
export function Meter({ value, unit = 'hrs' }: { value: string | null; unit?: string }) {
  if (value === null) return <span className="text-secondary">—</span>;
  return (
    <span className="tabular">
      {value}
      <span className="ml-1 text-xs font-normal text-secondary">{unit}</span>
    </span>
  );
}

export function KeyMetric({
  label,
  value,
  unit,
  note,
}: {
  label: string;
  value: string | null;
  unit?: string;
  /** A short second line under the figure, such as how full the tanks are. */
  note?: string | null;
}) {
  return (
    <div className="bg-surface px-5 py-4">
      <p className="text-xs font-medium text-secondary">{label}</p>
      <p className="mt-1 text-3xl font-semibold">
        {value === null ? (
          <span className="text-secondary">—</span>
        ) : (
          <span className="tabular">
            {value}
            {unit ? <span className="ml-1 text-sm font-normal text-secondary">{unit}</span> : null}
          </span>
        )}
      </p>
      {note && value !== null ? <p className="mt-0.5 text-sm text-secondary">{note}</p> : null}
    </div>
  );
}

/**
 * Status, as §11 specifies it: an icon and explicit wording, never colour
 * alone, and never an airworthiness claim inferred from silence.
 */
export type StatusKind =
  | 'available'
  | 'upcoming'
  | 'due_soon'
  | 'overdue'
  | 'grounded'
  | 'neutral';

type Tone = 'ok' | 'warn' | 'danger' | 'quiet';

const STATUS: Record<StatusKind, { icon: typeof Check; label: string; tone: Tone }> = {
  available: { icon: Check, label: 'Available', tone: 'ok' },
  /*
    SPEC §4.4 has four states, and `upcoming` is the one the web was missing:
    something to plan around rather than to book a shop slot for. Collapsing it
    into `due_soon` would put an annual twenty-nine days out in the same
    register as an oil change two hours out.
  */
  upcoming: { icon: CalendarClock, label: 'Upcoming', tone: 'ok' },
  due_soon: { icon: Clock, label: 'Due soon', tone: 'warn' },
  overdue: { icon: AlertTriangle, label: 'Overdue', tone: 'danger' },
  grounded: { icon: Ban, label: 'Grounded', tone: 'danger' },
  neutral: { icon: Info, label: '', tone: 'quiet' },
};

/*
  Green, orange, red by threshold — the colours are defined, and measured, in
  globals.css. Every chip carries a dashed line in its own tone: the surfaces
  alone are not a boundary against a white card, and the dashed, square-cornered
  frame keeps a status from reading as one more rounded button.
*/
const TONE: Record<Tone, string> = {
  // The charts' teal at a quarter strength, by the owner's call (2026-10-22):
  // the same hue without shouting. Navy on it, never white, and the line is
  // teal-text so the chip keeps an edge against white.
  ok: 'border-teal-text bg-teal/25 text-on-teal',
  warn: 'border-warn-line bg-warn-surface text-warn',
  danger: 'border-danger-line bg-danger-surface text-danger',
  quiet: 'border-control bg-mist text-secondary',
};

export function Status({ kind, children }: { kind: StatusKind; children?: ReactNode }) {
  const { icon: Icon, label, tone } = STATUS[kind];
  /*
    Coloured by where the thing stands — green, orange, red — and still never
    by colour alone (§11): every chip keeps its icon and its word, so the
    colour is the third signal, for the glance from across a hangar. Neutral
    stays mist grey, because it is a label rather than a threshold.

    This used to be monochrome apart from the plain "Available" chip, on the
    reading that §11 keeps routine statuses quiet. It kept them too quiet: an
    oil change two tach hours out wore the same grey as one forty hours out,
    and the difference is the one thing the chip is there to say.
  */
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-none border border-dashed px-2 py-1 text-xs font-semibold ${TONE[tone]}`}
    >
      <Icon aria-hidden size={14} strokeWidth={2} />
      {children ?? label}
    </span>
  );
}

/**
 * The approved logo, used as supplied.
 *
 * §11: never stretched, rotated, redrawn or given effects, and never
 * recreated in CSS or from an icon library. Both assets are pure black
 * artwork for light backgrounds, so they are rendered as images rather than
 * inlined and recoloured — there is no colour to set, and teal is forbidden
 * here regardless.
 *
 * Intrinsic sizes are declared so the aspect ratio is exact and the header
 * does not shift while the file loads: 1864 x 380 for the horizontal lockup,
 * 394 x 394 for the standalone symbol.
 */

/** Symbol height in the header, from §11's 28-32px range. */
const HEADER_SYMBOL_HEIGHT = 30;
const HORIZONTAL_RATIO = 1864 / 380;

export function Logo({ height = HEADER_SYMBOL_HEIGHT }: { height?: number }) {
  return (
    <img
      src="/flightsquare-logo.svg"
      alt="FlightSquare"
      height={height}
      width={Math.round(height * HORIZONTAL_RATIO)}
      /*
        §11's clear space is **external** — "at least one-quarter of symbol
        height" around the mark — and `box-sizing: border-box` makes padding
        internal. Tailwind's preflight sets border-box on everything, so this
        padding was being subtracted from the height instead of added around
        it: `height={36}` drew the lockup at 18px, and the header's default 30
        drew it at 15px. Half size, everywhere, for as long as this existed.

        `content-box` restores the meaning the padding was written to have: the
        artwork is `height` tall and the clear space sits outside it.
      */
      style={{ height, width: 'auto', padding: height / 4, boxSizing: 'content-box' }}
    />
  );
}

/** The standalone symbol, for compact spaces. */
export function LogoMark({ size = HEADER_SYMBOL_HEIGHT }: { size?: number }) {
  return (
    <img
      src="/flightsquare-icon.svg"
      alt="FlightSquare"
      height={size}
      width={size}
      // Same correction as Logo: the clear space goes outside the mark.
      style={{ height: size, width: size, padding: size / 4, boxSizing: 'content-box' }}
    />
  );
}
