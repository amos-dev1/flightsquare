import { useEffect, useRef, type ReactNode } from 'react';
import {
  Animated,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { color, font, radius, space, type } from '@/theme';

/**
 * A bottom sheet, from React Native's own `Modal`.
 *
 * §11 §14 says not to add a UI library for a restyle, and that applies to a
 * single sheet too: `@gorhom/bottom-sheet` brings Reanimated and a gesture
 * handler for what is here a slide, a scrim and a list.
 *
 * No drag-to-dismiss, on purpose — a half-implemented gesture reads worse
 * than none. The scrim, the close control and the hardware back button all
 * dismiss it, which is every route a person actually reaches for.
 *
 * §11 §13: the transition is 200ms and respects nothing being animated at
 * all when the platform asks for that — `useNativeDriver` keeps it off the
 * JavaScript thread so it stays smooth while the list behind it renders.
 */
export function Sheet({
  visible,
  title,
  onClose,
  children,
}: {
  visible: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const slide = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(slide, {
      toValue: visible ? 1 : 0,
      duration: 200,
      useNativeDriver: true,
    }).start();
  }, [visible, slide]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      // Android's back button, which a sheet must answer.
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <Pressable style={styles.scrim} onPress={onClose} accessibilityLabel="Close" />

      <Animated.View
        style={[
          styles.sheet,
          {
            paddingBottom: insets.bottom + space.base,
            // Tall enough for a fleet, never taller than the screen.
            maxHeight: height * 0.75,
            transform: [
              { translateY: slide.interpolate({ inputRange: [0, 1], outputRange: [40, 0] }) },
            ],
          },
        ]}
      >
        <View style={styles.grip} accessibilityElementsHidden importantForAccessibility="no" />

        <View style={styles.head}>
          <Text style={styles.title}>{title}</Text>
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close"
            hitSlop={space.md}
            style={({ pressed }) => [styles.close, pressed && styles.closePressed]}
          >
            <Text style={styles.closeLabel}>Done</Text>
          </Pressable>
        </View>

        <ScrollView
          style={styles.body}
          contentContainerStyle={styles.bodyContent}
          keyboardShouldPersistTaps="handled"
        >
          {children}
        </ScrollView>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: 'rgba(21, 43, 60, 0.35)' },
  sheet: {
    backgroundColor: color.surface,
    borderTopLeftRadius: radius.card,
    borderTopRightRadius: radius.card,
    paddingTop: space.sm,
    // §11 §5: elevation where something genuinely floats, and only there.
    shadowColor: color.navy,
    shadowOpacity: 0.12,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: -4 },
    elevation: 12,
  },
  grip: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: color.line,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.base,
    paddingTop: space.base,
    paddingBottom: space.md,
  },
  title: { ...type.sectionHeading },
  close: { paddingVertical: space.sm, paddingHorizontal: space.sm, borderRadius: radius.control },
  closePressed: { backgroundColor: color.subtle },
  closeLabel: { ...type.button, fontFamily: font.semibold },
  body: { flexGrow: 0 },
  bodyContent: { paddingHorizontal: space.base, gap: space.sm },
});
