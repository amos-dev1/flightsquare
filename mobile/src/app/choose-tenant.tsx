import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { Body, Button, Card, Notice, PageTitle } from '@/components/ui';
import { api, messageFor, withAuth } from '@/lib/api';
import { readSession, writeSession } from '@/lib/auth';
import { space, type } from '@/theme';

/**
 * §3.1: one human, one login, many memberships.
 *
 * A club member frequently owns an aeroplane of their own and belongs to two
 * clubs at the field, so which tenant a session acts in is a choice rather
 * than a lookup. The web has had this screen since M1; the phone dead-ended
 * instead — it wrote the tokens, *then* noticed a second membership, and left
 * the account signed in with nowhere to be, told to "choose one on the web".
 *
 * No extra call: the login response already carries the memberships with
 * their names, and sign-in hands them here rather than throwing them away.
 */
export default function ChooseTenant() {
  const params = useLocalSearchParams<{ memberships?: string }>();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const memberships: { tenant_id: string; tenant_name: string }[] = params.memberships
    ? (JSON.parse(params.memberships) as { tenant_id: string; tenant_name: string }[])
    : [];

  async function choose(tenantId: string) {
    setBusy(tenantId);
    setError(null);
    try {
      await withAuth(() => api.selectTenant(tenantId));
      const session = await readSession();
      if (session) await writeSession({ ...session, tenantId });
      router.replace('/(app)');
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(null);
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <PageTitle>Which club?</PageTitle>
      <Body muted>
        You fly with more than one. Pick the one you are at — you can switch by
        signing out and back in.
      </Body>

      {error ? <Notice tone="error">{error}</Notice> : null}

      {memberships.map((membership) => (
        <Card key={membership.tenant_id}>
          <Text style={styles.name}>{membership.tenant_name}</Text>
          <View style={styles.action}>
            <Button
              label="Open"
              variant="secondary"
              busy={busy === membership.tenant_id}
              onPress={() => void choose(membership.tenant_id)}
            />
          </View>
        </Card>
      ))}

      {memberships.length === 0 ? (
        <Body muted>
          This account is not a member of any club yet. An invitation will add
          you to one.
        </Body>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: space.base, gap: space.md, paddingTop: space.xxl },
  name: { ...type.cardHeading },
  action: { marginTop: space.md },
});
