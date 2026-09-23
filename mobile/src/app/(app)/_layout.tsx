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
          headerTintColor: color.navy,
          headerTitleStyle: { fontFamily: font.semibold },
          // Left, beside the logo, rather than centred. Centred, the title
          // has only the gap between the logo and the menu button to live in,
          // and "Maintenance" came back as "Maintena…" — §11 §15 asks for no
          // clipping, and shrinking the one word that names the screen is the
          // wrong way to get it.
          headerTitleAlign: 'left',
          headerShadowVisible: false,
          // §11: the logo on every screen, the standalone symbol because a
          // phone header is a compact space, and kept apart from the
          // navigation icons rather than sitting among them.
          headerLeft: () => <LogoMark />,
          headerRight: () => <HeaderMenuButton />,
          // Mist is the canvas the white cards sit on (§11 §5).
          sceneStyle: { backgroundColor: color.mist },
          tabBarStyle: { backgroundColor: color.surface, borderTopColor: color.line },
          // §11's one approved use of teal in navigation: a small active
          // marker. The label's weight carries it too, so the state is never
          // colour alone.
          tabBarActiveTintColor: color.tealText,
          tabBarInactiveTintColor: color.secondary,
          // Five labels across a phone, and the longest of them is
          // "Maintenance". 10px with no item padding fits it whole; 11px
          // truncated it. Tab labels sit below §11's supporting-text size by
          // platform convention, and a truncated label is less readable than
          // a small one.
          tabBarLabelStyle: { fontFamily: font.semibold, fontSize: 10 },
          tabBarItemStyle: { paddingHorizontal: 0 },
        }}
      >
        <Tabs.Screen
          name="index"
          options={{
            // The header names the screen; the bar has five labels to fit
            // across a phone and gets the short form.
            title: 'Dashboard',
            tabBarLabel: 'Dash',
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
              <Feather name="send" size={size} color={tint} />
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

        {/*
          Reached from a card or from the menu, never from the bar — and each
          gets a back control in place of the logo.

          A tab bar is a set of places you switch between; these are pushed
          *onto* one, and without the arrow the only way off a read-only
          screen like Flight is to pick a different tab, which loses where you
          came from. §11 keeps the logo on the screens that are destinations;
          on a screen you arrived at from another, the way back is what
          belongs in that corner.
        */}
        <Tabs.Screen name="charges" options={{ href: null, title: 'Charges', headerLeft: Back }} />
        <Tabs.Screen name="flight" options={{ href: null, title: 'Flight', headerLeft: Back }} />
        <Tabs.Screen
          name="log-flight"
          options={{ href: null, title: 'Log flight', headerLeft: Back }}
        />
        <Tabs.Screen
          name="report-squawk"
          options={{ href: null, title: 'Report a defect', headerLeft: Back }}
        />
        <Tabs.Screen
          name="queue"
          options={{ href: null, title: 'Waiting to sync', headerLeft: Back }}
        />
        <Tabs.Screen name="menu" options={{ href: null, title: 'More', headerLeft: Back }} />
      </Tabs>
    </EntitlementsProvider>
  );
}

/**
 * The way back off a pushed screen, where a destination screen shows the
 * logo. Same accessible-name and target-size rules as the menu button.
 */
function Back() {
  return (
    <Pressable
      onPress={() => router.back()}
      accessibilityRole="button"
      accessibilityLabel="Back"
      hitSlop={space.sm}
      style={{ padding: space.md }}
    >
      <Feather name="chevron-left" size={24} color={color.navy} />
    </Pressable>
  );
}

/**
 * The overflow, so the tab bar can stay at five however much gets built.
 *
 * A gear rather than an ellipsis: what is behind it is Charges, the sync
 * queue and signing out, which is what people look for under settings. §11
 * wants an accessible name on an icon-only control and a touch target of at
 * least 44 x 44; the padding is what provides the second.
 */
function HeaderMenuButton() {
  return (
    <Pressable
      onPress={() => router.push('/(app)/menu')}
      accessibilityRole="button"
      accessibilityLabel="Settings"
      hitSlop={space.sm}
      style={{ padding: space.md }}
    >
      <Feather name="settings" size={22} color={color.navy} />
    </Pressable>
  );
}
