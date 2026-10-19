import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet } from 'react-native';

import { Body, Button, Field, Input, Notice } from '@/components/ui';
import { api } from '@/lib/api';
import { color, space } from '@/theme';

/**
 * Asking for a password-reset email, from the phone.
 *
 * Only the asking. The link in the email opens the web app's reset page,
 * where the new password is chosen — the same page every reset already uses —
 * so the phone has no token to handle and no deep link to register. After
 * that, signing in here works with the new password.
 *
 * The answer is the same whether or not the address has an account: telling
 * the two apart is exactly what somebody enumerating accounts wants (the API
 * answers 202 either way, for the same reason).
 */
export default function ForgotPassword() {
  const params = useLocalSearchParams<{ email?: string }>();
  const [email, setEmail] = useState(params.email ?? '');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.requestPasswordReset(email.trim());
      setSent(true);
    } catch (caught) {
      // A rate limit is the one refusal worth naming: it is why trying again
      // straight away will not help.
      const status = (caught as { status?: unknown }).status;
      setError(
        status === 429
          ? 'Too many requests from here. Wait a minute and try again.'
          : 'That did not go through. Check the connection and try again.',
      );
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
        {sent ? (
          <>
            <Notice>
              If {email.trim()} has an account, a link to choose a new password is on its way. It
              works once and expires.
            </Notice>
            <Body muted>
              Open the link, choose a new password, then come back here and sign in with it.
              Resetting signs this account out everywhere else.
            </Body>
            <Button label="Back to sign in" onPress={() => router.back()} />
          </>
        ) : (
          <>
            <Body muted>
              Enter the email you sign in with, and we will send a link to choose a new password.
            </Body>

            <Field label="Email" required>
              <Input
                value={email}
                onChangeText={setEmail}
                autoCapitalize="none"
                autoComplete="email"
                keyboardType="email-address"
                textContentType="emailAddress"
                autoFocus={!email}
                onSubmitEditing={submit}
              />
            </Field>

            {error ? <Notice tone="error">{error}</Notice> : null}

            <Button
              label="Send reset link"
              onPress={submit}
              busy={busy}
              disabled={!email.trim()}
            />
          </>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: color.mist },
  container: { padding: space.base, gap: space.base },
});
