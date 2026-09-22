import { router } from 'expo-router';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { Pressable } from 'react-native';

import { Body, Logo, SectionHeading } from '@/components/ui';
import { clearSession } from '@/lib/auth';
import { useFlag } from '@/lib/entitlements';
import { color, space, type } from '@/theme';

/**
 * Everything that does not fit five tabs.
 *
 * The bar is full and will stay full — a sixth tab becomes an iOS "More"
 * list, and a bar that changes shape depending on the plan is worse than one
 * that never moves. So this is where anything built after the five lands,
 * and it is deliberately a plain list rather than a screen with a design of
 * its own.
 */
export default function Menu() {
  const billing = useFlag('member_billing');

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <View style={styles.brand}>
        <Logo height={28} />
      </View>

      {billing ? (
        <Item
          icon="file-text"
          label="Charges"
          hint="What you owe your club, and the flights behind it"
          onPress={() => {
            router.back();
            router.push('/(app)/charges');
          }}
        />
      ) : null}

      <Item
        icon="upload-cloud"
        label="Waiting to sync"
        hint="Anything logged without a signal, and anything that was refused"
        onPress={() => {
          router.back();
          router.push('/(app)/queue');
        }}
      />

      <View style={styles.footer}>
        <SectionHeading>Account</SectionHeading>
        <Item
          icon="log-out"
          label="Sign out"
          hint="This phone forgets the session. Nothing queued is lost."
          onPress={() => {
            void clearSession().then(() => router.replace('/sign-in'));
          }}
        />
      </View>
    </ScrollView>
  );
}

function Item({
  icon,
  label,
  hint,
  onPress,
}: {
  icon: 'file-text' | 'upload-cloud' | 'log-out';
  label: string;
  hint: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.item, pressed && styles.itemPressed]}
    >
      <Feather name={icon} size={20} color={color.brandBlack} />
      <View style={styles.itemText}>
        <Text style={styles.itemLabel}>{label}</Text>
        <Body muted>{hint}</Body>
      </View>
      <Feather name="chevron-right" size={18} color={color.secondary} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { padding: space.base, gap: space.sm },
  brand: { alignItems: 'center', paddingVertical: space.md },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    // §11: at least 44 x 44, and this is a whole row.
    minHeight: 56,
    paddingVertical: space.md,
    paddingHorizontal: space.base,
    borderWidth: 1,
    borderColor: color.line,
    borderRadius: 12,
    backgroundColor: color.surface,
  },
  itemPressed: { backgroundColor: color.subtle },
  itemText: { flex: 1, gap: space.xs },
  itemLabel: { ...type.cardHeading },
  footer: { marginTop: space.lg, gap: space.sm },
});
