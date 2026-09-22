import {
  Manrope_400Regular,
  Manrope_500Medium,
  Manrope_600SemiBold,
  Manrope_700Bold,
  useFonts,
} from '@expo-google-fonts/manrope';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { View } from 'react-native';

import { openQueue } from '@/lib/queue';
import { color } from '@/theme';

export default function RootLayout() {
  // §11: the actual Manrope, not a fallback that looks close.
  const [fontsLoaded] = useFonts({
    Manrope_400Regular,
    Manrope_500Medium,
    Manrope_600SemiBold,
    Manrope_700Bold,
  });

  useEffect(() => {
    // Open the queue before any screen can write to it: a flight saved
    // before the table exists would be a flight lost.
    void openQueue();
  }, []);

  if (!fontsLoaded) return <View style={{ flex: 1, backgroundColor: color.surface }} />;

  return (
    <>
      <StatusBar style="dark" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: color.surface },
          headerTintColor: color.brandBlack,
          headerTitleStyle: { fontFamily: 'Manrope_600SemiBold' },
          headerShadowVisible: false,
          contentStyle: { backgroundColor: color.surface },
        }}
      >
        <Stack.Screen name="sign-in" options={{ headerShown: false }} />
        <Stack.Screen name="choose-tenant" options={{ headerShown: false }} />
        <Stack.Screen name="(app)" options={{ headerShown: false }} />
      </Stack>
    </>
  );
}
