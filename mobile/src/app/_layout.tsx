import { Inter_400Regular, Inter_500Medium, Inter_600SemiBold } from '@expo-google-fonts/inter';
import { Manrope_400Regular, Manrope_600SemiBold } from '@expo-google-fonts/manrope';
import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { View } from 'react-native';

import { openQueue } from '@/lib/queue';
import { color, font } from '@/theme';

export default function RootLayout() {
  /**
   * §11 §4: Inter runs the operational interface, Manrope is the brand voice.
   * The real fonts, not a fallback that looks close — and only the weights
   * the type scale actually names, because each one is a file the app
   * downloads before it will render anything.
   */
  const [fontsLoaded] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Manrope_400Regular,
    Manrope_600SemiBold,
  });

  useEffect(() => {
    // Open the queue before any screen can write to it: a flight saved
    // before the table exists would be a flight lost.
    void openQueue();
  }, []);

  if (!fontsLoaded) return <View style={{ flex: 1, backgroundColor: color.mist }} />;

  return (
    <>
      <StatusBar style="dark" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: color.surface },
          headerTintColor: color.navy,
          headerTitleStyle: { fontFamily: font.semibold },
          headerShadowVisible: false,
          // Mist is the canvas; white belongs to the cards on it (§11 §5).
          contentStyle: { backgroundColor: color.mist },
        }}
      >
        <Stack.Screen name="sign-in" options={{ headerShown: false }} />
        <Stack.Screen name="choose-tenant" options={{ headerShown: false }} />
        <Stack.Screen name="(app)" options={{ headerShown: false }} />
      </Stack>
    </>
  );
}
