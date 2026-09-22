import { Tabs } from 'expo-router';
import Feather from '@expo/vector-icons/Feather';
import { useEffect, useState } from 'react';

import { api, withAuth } from '@/lib/api';
import { useBackgroundSync } from '@/lib/use-sync';
import { color, font } from '@/theme';

/**
 * A pilot's five jobs, and where each one lives.
 *
 * V1_SCOPE names five screens: schedule, log flight, aircraft status,
 * squawks, my charges. Four of them are places you go — a tab each. The
 * fifth, logging a flight, is something you do *to an aeroplane*, so it
 * stays a pushed route reached from the aircraft you just flew, along with
 * reporting a defect. A tab for it would have to ask "which one?" first,
 * which is a question the Fleet screen has already answered.
 *
 * Feather rather than Lucide: §11 asks for a consistent outline family with
 * concise text labels and says to use Lucide where nothing exists, but the
 * web's Lucide does not run here. Feather is the same drawing at the same
 * stroke weight, and it is the family Expo ships.
 */
export default function AppLayout() {
  /**
   * The first thing on this phone to read §1.4's resolved entitlements.
   *
   * §8.1: fetched, never compiled in — a table of what Pro includes would go
   * stale on the App Store and could not be corrected without a release. The
   * only thing it decides here is whether the Charges tab exists, because
   * member billing is Pro and up and on a free tenant the endpoint answers
   * 404 (§1.6).
   *
   * Absence, not an upsell. §8.3 keeps this app inside Apple's 3.1.3(f),
   * which exempts a free companion to a paid web tool from in-app purchase
   * *provided there is no call to action to purchase outside it* — so a tab
   * a club has not paid for is simply not there, with no price, no link and
   * no explanation.
   *
   * Undefined until the answer arrives, and hidden while it is: showing the
   * tab and taking it away a second later is worse than a beat of patience.
   */
  const [billing, setBilling] = useState<boolean | undefined>(undefined);

  /**
   * Here rather than on a screen, because the whole point is that it does
   * not depend on which screen somebody happens to open (§8.2).
   */
  useBackgroundSync();

  useEffect(() => {
    void withAuth(() => api.entitlements())
      .then((entitlements) => setBilling(entitlements.flags.member_billing === true))
      // Offline at launch. Leave it hidden rather than guessing — the tab
      // appears on the next foreground, and nothing is lost meanwhile.
      .catch(() => setBilling(false));
  }, []);

  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: color.surface },
        headerTintColor: color.brandBlack,
        headerTitleStyle: { fontFamily: font.semibold },
        headerShadowVisible: false,
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
          title: 'Fleet',
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
        name="squawks"
        options={{
          title: 'Squawks',
          tabBarIcon: ({ color: tint, size }) => (
            <Feather name="alert-triangle" size={size} color={tint} />
          ),
        }}
      />
      <Tabs.Screen
        name="charges"
        options={{
          title: 'Charges',
          href: billing ? undefined : null,
          tabBarIcon: ({ color: tint, size }) => (
            <Feather name="file-text" size={size} color={tint} />
          ),
        }}
      />

      {/*
        Done to an aeroplane, not navigated to. Both are pushed from a
        Fleet card, which is where the aircraft is already chosen.
      */}
      <Tabs.Screen name="log-flight" options={{ href: null, title: 'Log flight' }} />
      <Tabs.Screen name="report-squawk" options={{ href: null, title: 'Report a defect' }} />
      <Tabs.Screen name="queue" options={{ href: null, title: 'Waiting to sync' }} />
    </Tabs>
  );
}
