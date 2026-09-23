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
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>
        {label}
        {required ? <Text style={styles.labelHint}> (required)</Text> : null}
      </Text>
      {children}
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}

export function Input({ style, ...props }: TextInputProps) {
  return (
    <TextInput
      placeholderTextColor={color.secondary}
      {...props}
      style={[styles.input, style]}
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

  field: { gap: space.sm },
  label: { ...type.label, color: color.navy },
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
