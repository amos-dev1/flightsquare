import { Tabs, router } from 'expo-router';
import Feather from '@expo/vector-icons/Feather';
import { Pressable } from 'react-native';

import { LogoMark } from '@/components/ui';
import { EntitlementsProvider } from '@/lib/entitlements';
import { useBackgroundSync } from '@/lib/use-sync';
import { color, font, space } from '@/theme';

/**
 * Five tabs, and a menu for everything after them.
 *
 * `docs/mobile-app-pages.md` puts the Dashboard first, and it is the group's
 * index — so "after signing in, default to DASHBOARD" is true without the
 * three places that redirect to `/(app)` knowing anything about it.
 *
 * Five is the ceiling: iOS collapses a sixth into a "More" list, and a tab
 * bar that changes shape by plan — Charges disappears on Free — is worse
 * than one that never moves. So Charges, and everything built after this,
 * lives behind the header menu instead.
 *
 * Log flight and reporting a defect are not tabs and never will be. Both are
 * done *to an aeroplane*, and a tab for either would have to ask "which
 * one?" first, which the Aircraft screen has already answered.
 */
export default function AppLayout() {
  /**
   * Here rather than on a screen, because the whole point is that it does
   * not depend on which screen somebody happens to open (§8.2).
   */
  useBackgroundSync();

  return (
    <EntitlementsProvider>
      <Tabs
        screenOptions={{
          headerStyle: { backgroundColor: color.surface },
          headerTintColor: color.brandBlack,
          headerTitleStyle: { fontFamily: font.semibold },
          headerTitleAlign: 'center',
          headerShadowVisible: false,
          // §11: the logo on every screen, the standalone symbol because a
          // phone header is a compact space, and kept apart from the
          // navigation icons rather than sitting among them.
          headerLeft: () => <LogoMark />,
          headerRight: () => <HeaderMenuButton />,
          sceneStyle: { backgroundColor: color.surface },
          tabBarStyle: { backgroundColor: color.surface, borderTopColor: color.line },
          // §11's one approved use of teal in navigation: a small active
          // marker. The label's weight carries it too, so the state is never
          // colour alone.
          tabBarActiveTintColor: color.accentInk,
          tabBarInactiveTintColor: color.secondary,
          tabBarLabelStyle: { fontFamily: font.semibold, fontSize: 11 },
        }}
      >
        <Tabs.Screen
          name="index"
          options={{
            title: 'Dash',
            tabBarIcon: ({ color: tint, size }) => (
              <Feather name="grid" size={size} color={tint} />
            ),
          }}
        />
        <Tabs.Screen
          name="aircraft"
          options={{
            title: 'Aircraft',
            tabBarIcon: ({ color: tint, size }) => (
              <Feather name="airplay" size={size} color={tint} />
            ),
          }}
        />
        <Tabs.Screen
          name="schedule"
          options={{
            title: 'Schedule',
            tabBarIcon: ({ color: tint, size }) => (
              <Feather name="calendar" size={size} color={tint} />
            ),
          }}
        />
        <Tabs.Screen
          name="logs"
          options={{
            title: 'Logs',
            tabBarIcon: ({ color: tint, size }) => (
              <Feather name="book-open" size={size} color={tint} />
            ),
          }}
        />
        <Tabs.Screen
          name="maintenance"
          options={{
            title: 'Maintenance',
            tabBarIcon: ({ color: tint, size }) => (
              <Feather name="alert-triangle" size={size} color={tint} />
            ),
          }}
        />

        {/* Reached from a card or from the menu, never from the bar. */}
        <Tabs.Screen name="charges" options={{ href: null, title: 'Charges' }} />
        <Tabs.Screen name="log-flight" options={{ href: null, title: 'Log flight' }} />
        <Tabs.Screen name="report-squawk" options={{ href: null, title: 'Report a defect' }} />
        <Tabs.Screen name="queue" options={{ href: null, title: 'Waiting to sync' }} />
        <Tabs.Screen name="menu" options={{ href: null, title: 'More' }} />
      </Tabs>
    </EntitlementsProvider>
  );
}

/**
 * The overflow, so the tab bar can stay at five however much gets built.
 *
 * §11 wants an accessible name on an icon-only control and a touch target of
 * at least 44 x 44; the padding is what provides the second.
 */
function HeaderMenuButton() {
  return (
    <Pressable
      onPress={() => router.push('/(app)/menu')}
      accessibilityRole="button"
      accessibilityLabel="More"
      hitSlop={space.sm}
      style={{ padding: space.md }}
    >
      <Feather name="more-horizontal" size={22} color={color.brandBlack} />
    </Pressable>
  );
}
