import { router } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Button, Field, Input, Notice, PageTitle } from '@/components/ui';
import { api } from '@/lib/api';
import { writeSession } from '@/lib/auth';
import { color, space, type } from '@/theme';

export default function SignIn() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const result = await api.login(email.trim(), password);

      // §3.1: one human, many memberships. A solo owner has exactly one and
      // should not be asked; anyone with more chooses.
      const only = result.memberships.length === 1 ? result.memberships[0] : undefined;

      await writeSession({
        accessToken: result.access_token,
        refreshToken: result.refresh_token,
        expiresAt: result.expires_at,
        // No tenantId yet, on purpose. The boot redirect keys on it, so a
        // session written with one before a tenant is actually selected
        // looks complete and is not — which is how a multi-club account used
        // to get bounced back here on every launch.
      });

      if (!only) {
        router.replace({
          pathname: '/choose-tenant',
          // The login response already carries the names, so the picker
          // needs no call of its own — and cannot make one usefully, since
          // /me/memberships wants a session that has chosen.
          params: { memberships: JSON.stringify(result.memberships) },
        });
        return;
      }

      await api.selectTenant(only.tenant_id);
      await writeSession({
        accessToken: result.access_token,
        refreshToken: result.refresh_token,
        expiresAt: result.expires_at,
        tenantId: only.tenant_id,
      });
      router.replace('/(app)');
    } catch {
      // The API answers a wrong password, an unknown address and a locked
      // account identically, and so does this.
      setError('That email and password do not match an account.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <PageTitle>Sign in</PageTitle>
          {/* §11 uses the tagline sparingly; sign-in is one of the places. */}
          <Text style={styles.tagline}>Aircraft management, simplified.</Text>
        </View>

        <Field label="Email" required>
          <Input
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            autoComplete="email"
            keyboardType="email-address"
            textContentType="emailAddress"
          />
        </Field>

        <Field label="Password" required>
          <Input
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoComplete="current-password"
            textContentType="password"
            onSubmitEditing={submit}
          />
        </Field>

        {error ? <Notice tone="error">{error}</Notice> : null}

        <Button label="Sign in" onPress={submit} busy={busy} disabled={!email || !password} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: color.surface },
  container: { padding: space.base, gap: space.base, justifyContent: 'center', flexGrow: 1 },
  header: { gap: space.xs, marginBottom: space.sm },
  tagline: { ...type.bodySmall, color: color.secondary },
});
