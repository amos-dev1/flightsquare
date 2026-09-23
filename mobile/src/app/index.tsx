import { Redirect } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { readSession } from '@/lib/auth';
import { color } from '@/theme';

export default function Index() {
  const [target, setTarget] = useState<string | null>(null);

  useEffect(() => {
    void readSession().then((session) => {
      setTarget(session?.tenantId ? '/(app)' : '/sign-in');
    });
  }, []);

  if (!target) return <View style={{ flex: 1, backgroundColor: color.mist }} />;
  return <Redirect href={target as '/sign-in'} />;
}
