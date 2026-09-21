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

import { CONTROL_HEIGHT, color, radius, space, type } from '@/theme';

/** §11, as React Native styles. Same tokens as the web theme. */

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
        // §11: the primary action is black with white text. Teal is never a
        // button fill.
        isPrimary ? styles.buttonPrimary : styles.buttonSecondary,
        pressed && styles.buttonPressed,
        (disabled || busy) && styles.buttonDisabled,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={isPrimary ? color.surface : color.brandBlack} />
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

const styles = StyleSheet.create({
  card: {
    backgroundColor: color.surface,
    borderColor: color.line,
    borderWidth: 1,
    borderRadius: radius.card,
    padding: space.base,
  },
  pageTitle: { ...type.pageTitle, color: color.brandBlack },
  sectionHeading: { ...type.sectionHeading, color: color.brandBlack },
  body: { ...type.body, color: color.brandBlack },
  muted: { color: color.secondary },

  button: {
    height: CONTROL_HEIGHT,
    borderRadius: radius.control,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.base,
  },
  buttonPrimary: { backgroundColor: color.brandBlack },
  buttonSecondary: { backgroundColor: color.surface, borderWidth: 1, borderColor: color.control },
  buttonPressed: { opacity: 0.85 },
  buttonDisabled: { opacity: 0.5 },
  buttonLabel: { ...type.button, color: color.brandBlack },
  buttonLabelPrimary: { color: color.surface },

  field: { gap: space.sm },
  label: { ...type.label, color: color.brandBlack },
  labelHint: { ...type.bodySmall, color: color.secondary },
  hint: { ...type.supporting, color: color.secondary },

  input: {
    height: CONTROL_HEIGHT,
    borderWidth: 1,
    borderColor: color.control,
    borderRadius: radius.control,
    paddingHorizontal: space.md,
    backgroundColor: color.surface,
    color: color.brandBlack,
    ...type.input,
  },

  meter: { ...type.body, color: color.brandBlack, fontVariant: ['tabular-nums'] },
  meterUnit: { ...type.supporting, color: color.secondary },

  notice: {
    borderWidth: 1,
    borderColor: color.line,
    backgroundColor: color.subtle,
    borderRadius: radius.control,
    padding: space.md,
  },
  noticeError: { borderColor: color.brandBlack },
  noticeText: { ...type.bodySmall, color: color.brandBlack },
});
