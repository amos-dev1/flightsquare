import { Stack } from 'expo-router';

import { color } from '@/theme';

export default function AppLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: color.surface },
        headerTintColor: color.brandBlack,
        headerTitleStyle: { fontFamily: 'Manrope_600SemiBold' },
        headerShadowVisible: false,
        headerBackButtonDisplayMode: 'minimal',
        contentStyle: { backgroundColor: color.surface },
      }}
    >
      <Stack.Screen name="index" options={{ title: 'Fleet' }} />
      <Stack.Screen name="log-flight" options={{ title: 'Log flight' }} />
    </Stack>
  );
}
