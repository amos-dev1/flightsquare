import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from 'react-native';
import Feather from '@expo/vector-icons/Feather';

// Relative, not via `@/`, which maps to src/ — the artwork lives beside it.
import LogoSymbol from '../../assets/flightsquare-icon.svg';
import LogoWordmark from '../../assets/flightsquare-logo.svg';
import { CONTROL_HEIGHT, color, font, radius, space, type } from '@/theme';

/**
 * §11, as React Native styles. Same tokens as the web theme.
 *
 * Navy carries text and primary actions, white is the card surface, and the
 * screens behind these sit on mist so a card separates from its canvas
 * without a shadow. Nothing here fills with teal: §11 keeps it to selection
 * and emphasis, and explicitly not to a safety or airworthiness signal.
 */

export function Card({ children, style }: { children: ReactNode; style?: object }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function PageTitle({ children }: { children: ReactNode }) {
  return <Text style={styles.pageTitle}>{children}</Text>;
}

export function SectionHeading({ children }: { children: ReactNode }) {
  return <Text style={styles.sectionHeading}>{children}</Text>;
}

/**
 * 16px, for a heading *inside* a card.
 *
 * §11's scale distinguishes a section heading (20-24) from a card heading
 * (16-18), and until now only the first had a component — so every card in the
 * app headed itself with a section heading one step too large. On a form with
 * five cards that is most of a screenful of nothing.
 */
export function CardHeading({ children }: { children: ReactNode }) {
  return <Text style={styles.cardHeading}>{children}</Text>;
}

export function Body({ children, muted }: { children: ReactNode; muted?: boolean }) {
  return <Text style={[styles.body, muted && styles.muted]}>{children}</Text>;
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled,
  busy,
}: {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary';
  disabled?: boolean;
  busy?: boolean;
}) {
  const isPrimary = variant === 'primary';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || busy }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        // §11 §6: the primary action is navy with white text. Teal is never
        // a button fill — it is selection and emphasis.
        isPrimary ? styles.buttonPrimary : styles.buttonSecondary,
        pressed && (isPrimary ? styles.buttonPrimaryPressed : styles.buttonPressed),
        (disabled || busy) && styles.buttonDisabled,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={isPrimary ? color.onDark : color.navy} />
      ) : (
        <Text style={[styles.buttonLabel, isPrimary && styles.buttonLabelPrimary]}>{label}</Text>
      )}
    </Pressable>
  );
}

export function Field({
  label,
  hint,
  required,
  compact,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  /**
   * For a form with a dozen fields on it.
   *
   * A 14px label and an 8px gap is right for a form somebody fills in once.
   * The post-flight entry has ten fields and §3.4 says it is the screen to
   * optimise over everything else — "if it takes more than a minute, people
   * skip it" — and a minute is mostly scrolling. This drops the label to the
   * 13px supporting size and halves the gap, which is 11px a field.
   */
  compact?: boolean;
  children: ReactNode;
}) {
  return (
    <View style={compact ? styles.fieldCompact : styles.field}>
      <Text style={compact ? styles.labelCompact : styles.label}>
        {label}
        {required ? <Text style={styles.labelHint}> (required)</Text> : null}
      </Text>
      {children}
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}

export function Input({
  compact,
  style,
  ...props
}: TextInputProps & { compact?: boolean }) {
  return (
    <TextInput
      placeholderTextColor={color.secondary}
      {...props}
      style={[styles.input, compact && styles.inputCompact, style]}
    />
  );
}

/** A meter value with its unit, tabular so digits line up. */
export function Meter({ value, unit = 'hrs' }: { value: string | null; unit?: string }) {
  if (value === null) return <Text style={styles.muted}>—</Text>;
  return (
    <Text style={styles.meter}>
      {value}
      <Text style={styles.meterUnit}> {unit}</Text>
    </Text>
  );
}

/** Feedback that never depends on colour alone. */
export function Notice({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'error' }) {
  return (
    <View style={[styles.notice, tone === 'error' && styles.noticeError]}>
      <Text style={styles.noticeText}>{children}</Text>
    </View>
  );
}

/**
 * A status, as §11 specifies it: explicit wording and a border, never colour
 * alone. Weight and the outline carry here what an icon carries on the web.
 * The chip sits on mist rather than white so it reads as a chip on a card.
 */
export function Status({ label, emphatic }: { label: string; emphatic?: boolean }) {
  return (
    <View style={[styles.status, emphatic && styles.statusEmphatic]}>
      <Text style={[styles.statusLabel, emphatic && styles.statusLabelEmphatic]}>{label}</Text>
    </View>
  );
}

/**
 * The thing you tap to change which aeroplane you are looking at.
 *
 * A trigger, not a menu: it opens a `Sheet` the caller owns. What it has to do
 * is say, without being read, that it *can* be tapped — which is precisely
 * what the three hand-rolled versions before it did not. Two had no boundary
 * at all and were indistinguishable from the content beside them; the third
 * drew one in `color.line`, the decorative divider.
 *
 * So it borrows the vocabulary §11 §8 already defines for a field, because a
 * control that looks like every other control on the platform needs no
 * explaining: white surface, a `color.control` boundary — the token whose own
 * comment says "where a boundary has to say where a control is; the divider
 * will not" — and a chevron large enough to read at arm's length.
 *
 * **No teal.** §11 §3 keeps it under 5% of a screen and warns off saturated
 * teal backgrounds, and the pale `selected` surface is already spoken for: it
 * marks the chosen row *inside* the sheet this opens. Using it here as well
 * would say "selected" and "changeable" in the same colour.
 *
 * `disabled` is for a club with one aeroplane, and it renders as a plain row —
 * no boundary, no chevron, no press state. A box that looks like a control and
 * does nothing is worse than no box.
 */
export function Picker({
  children,
  onPress,
  label,
  compact,
  disabled,
}: {
  /** Whatever identifies the choice: a thumbnail and two lines, or one word. */
  children: ReactNode;
  onPress: () => void;
  /** What a screen reader says. "N4521G. Change aircraft", not "Picker". */
  label: string;
  /** For a dense filter row, where a full-height labelled control would not fit. */
  compact?: boolean;
  /** Nothing to pick. */
  disabled?: boolean;
}) {
  if (disabled) {
    return (
      <View style={[styles.pickerPlain, compact && styles.pickerCompactPlain]}>{children}</View>
    );
  }

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.picker,
        compact && styles.pickerCompact,
        // A fill change rather than the whole control fading, for the reason
        // the buttons already give: opacity drops the label's contrast with
        // the surface it is sitting on.
        pressed && styles.pickerPressed,
      ]}
    >
      <View style={[styles.pickerBody, compact && styles.pickerBodyCompact]}>{children}</View>
      {/* 24, and the same on every screen it appears on. The three it replaced
          were 22, 20 and 16, which is how a shared affordance stops being one. */}
      <Feather name="chevron-down" size={compact ? 20 : 24} color={color.navy} />
    </Pressable>
  );
}

/**
 * A segmented choice, because a picker wheel for four options is four taps
 * and a scroll on a phone held in one hand at a tiedown.
 *
 * §11 §3 puts teal on selected controls and navy on primary buttons, which
 * settles a fault the Simulator showed earlier: a selected option filled like
 * a primary button reads as a second "Save", and on a form with a real one it
 * competes with it. Selection here is the pale selected surface, a teal
 * boundary and heavier text — three cues, none of them colour alone, and none
 * of them shaped like the action.
 */
export function Choice<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <View style={styles.choice}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            onPress={() => onChange(option.value)}
            style={({ pressed }) => [
              styles.choiceOption,
              selected && styles.choiceOptionSelected,
              pressed && styles.buttonPressed,
            ]}
          >
            <Text style={[styles.choiceLabel, selected && styles.choiceLabelSelected]}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: color.surface,
    borderColor: color.line,
    borderWidth: 1,
    borderRadius: radius.card,
    padding: space.base,
  },
  pageTitle: { ...type.pageTitle, color: color.navy },
  sectionHeading: { ...type.sectionHeading, color: color.navy },
  cardHeading: { ...type.cardHeading, color: color.navy },
  body: { ...type.body, color: color.navy },
  muted: { color: color.secondary },

  button: {
    height: CONTROL_HEIGHT,
    borderRadius: radius.control,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.base,
  },
  buttonPrimary: { backgroundColor: color.navy },
  // The hover token, as a press state — a real colour change rather than the
  // whole control fading, which §11 does not ask for and which drops the
  // label's contrast with it.
  buttonPrimaryPressed: { backgroundColor: color.navyHover },
  buttonSecondary: { backgroundColor: color.surface, borderWidth: 1, borderColor: color.control },
  buttonPressed: { backgroundColor: color.subtle },
  buttonDisabled: { opacity: 0.5 },
  buttonLabel: { ...type.button, color: color.navy },
  buttonLabelPrimary: { color: color.onDark },

  /**
   * The picker trigger. `minHeight` rather than `height`, because the full
   * form holds a thumbnail and two lines and a long registration must be
   * allowed to wrap rather than clip.
   */
  picker: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: 56,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.control,
    borderRadius: radius.control,
  },
  /**
   * §11 §13 asks for 44 even where the control is dense.
   *
   * `flexShrink: 0` because a chip lives in a row beside other controls, and a
   * control squeezed to nothing by its neighbours is the same empty box as one
   * with a zero-width body — just arrived at from the other direction. It
   * keeps its width and the row wraps or scrolls instead.
   */
  pickerCompact: {
    minHeight: 44,
    gap: space.sm,
    paddingHorizontal: space.sm,
    flexShrink: 0,
  },
  pickerPressed: { backgroundColor: color.subtle },
  // `flex: 1` so the chevron is pushed to the far edge of a full-width control,
  // and `flexShrink` so it keeps its place when the registration is long.
  pickerBody: { flex: 1, flexShrink: 1, flexDirection: 'row', alignItems: 'center', gap: space.md },
  /**
   * A chip hugs its content instead: it sits in a row beside other controls,
   * so growing to fill would make it as wide as the screen.
   *
   * `flexBasis: 'auto'` is load-bearing, not tidiness. `flex: 1` above is
   * shorthand for `flexGrow: 1, flexShrink: 1, flexBasis: 0`, so turning the
   * grow off on its own leaves a basis of zero with nothing to grow it — the
   * body collapsed to no width at all and its contents vanished. The border
   * and the chevron still drew, which is what made it look like a blank
   * control rather than a broken one.
   */
  pickerBodyCompact: { flexGrow: 0, flexBasis: 'auto', gap: space.sm },
  // Nothing to pick: content, not a control.
  pickerPlain: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: 56,
    paddingVertical: space.sm,
  },
  pickerCompactPlain: { minHeight: 44, gap: space.sm },

  field: { gap: space.sm },
  fieldCompact: { gap: space.xs },
  label: { ...type.label, color: color.navy },
  labelCompact: { ...type.supporting, color: color.secondary },
  labelHint: { ...type.bodySmall, color: color.secondary },
  hint: { ...type.supporting, color: color.secondary },

  input: {
    height: CONTROL_HEIGHT,
    borderWidth: 1,
    borderColor: color.control,
    borderRadius: radius.control,
    paddingHorizontal: space.md,
    backgroundColor: color.surface,
    ...type.input,
  },
  // 44, which is §11 §13's floor rather than a number picked for looks — the
  // dense form is still a form somebody taps with a thumb. The text stays at
  // 16px, because iOS zooms a field under that and shrinking it to gain four
  // pixels would cost the whole layout.
  inputCompact: { height: 44, paddingHorizontal: space.sm },

  meter: { ...type.body, color: color.navy, fontVariant: ['tabular-nums'] },
  meterUnit: { ...type.supporting, color: color.secondary },

  notice: {
    borderWidth: 1,
    borderColor: color.line,
    backgroundColor: color.subtle,
    borderRadius: radius.control,
    padding: space.md,
  },
  noticeError: { borderColor: color.navy },
  noticeText: { ...type.bodySmall, color: color.navy },

  status: {
    alignSelf: 'flex-start',
    borderRadius: radius.control,
    backgroundColor: color.mist,
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
    // A transparent border on the ordinary chip, so the emphatic one is not
    // 2px wider than its neighbour in a column of them.
    borderWidth: 1,
    borderColor: 'transparent',
  },
  statusEmphatic: { borderColor: color.navy },
  statusLabel: { ...type.supporting, color: color.secondary },
  statusLabelEmphatic: { color: color.navy, fontFamily: font.semibold },

  choice: { gap: space.sm },
  choiceOption: {
    minHeight: CONTROL_HEIGHT,
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: color.control,
    borderRadius: radius.control,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  choiceOptionSelected: { backgroundColor: color.selected, borderColor: color.teal, borderWidth: 2 },
  choiceLabel: { ...type.body },
  choiceLabelSelected: { fontFamily: font.semibold },
});

/**
 * The approved logo, used as supplied.
 *
 * §11: never stretched, rotated, redrawn or given effects, and never
 * recreated in CSS or from an icon library. These are the same two files the
 * web serves from `public/`, imported as components by the SVG transformer
 * (see metro.config.js) so the artwork stays one file rather than path data
 * copied into code.
 *
 * Both are pure black artwork for light backgrounds. There is no colour to
 * set: §11 forbids teal here, and the artwork is black rather than navy on
 * purpose — it is the logo, not interface colour.
 *
 * Intrinsic ratios: 1864 x 380 for the horizontal lockup, 394 x 394 for the
 * standalone symbol.
 */

/** Symbol height in a header, from §11's 28-32px range. */
const HEADER_SYMBOL_HEIGHT = 30;
const HORIZONTAL_RATIO = 1864 / 380;

/** The horizontal lockup, for a centred brand presentation like sign-in. */
export function Logo({ height = HEADER_SYMBOL_HEIGHT }: { height?: number }) {
  return (
    <View
      // Clear space of at least a quarter of the symbol height, per §11.
      style={{ padding: height / 4 }}
      accessibilityRole="image"
      accessibilityLabel="FlightSquare"
    >
      <LogoWordmark height={height} width={Math.round(height * HORIZONTAL_RATIO)} />
    </View>
  );
}

/** The standalone symbol, which §11 asks for in compact spaces like a header. */
export function LogoMark({ size = HEADER_SYMBOL_HEIGHT }: { size?: number }) {
  return (
    <View
      style={{ padding: size / 4 }}
      accessibilityRole="image"
      accessibilityLabel="FlightSquare"
    >
      <LogoSymbol height={size} width={size} />
    </View>
  );
}
