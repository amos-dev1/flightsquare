import { router } from 'expo-router';
import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Feather from '@expo/vector-icons/Feather';

import { Body, Button, Field, Input, Logo, Notice } from '@/components/ui';
import { api } from '@/lib/api';
import { readDeviceToken, writeDeviceToken, writeSession } from '@/lib/auth';
import { color, space, type } from '@/theme';

/**
 * Sign in, which is two steps unless this device is already trusted.
 *
 * The password goes first and is never enough on its own (0039). If a code is
 * needed the screen becomes a code screen — same screen, not a second route,
 * because a navigation away from a half-finished sign-in is a challenge id
 * stranded in a param and a back button that lands somewhere meaningless.
 */
type Stage =
  | { step: 'credentials' }
  | { step: 'code'; challengeId: string; sentTo: string };

export default function SignIn() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [stage, setStage] = useState<Stage>({ step: 'credentials' });
  const [code, setCode] = useState('');
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** Whatever the server granted, stored and routed. Shared by both steps. */
  async function land(result: Extract<Awaited<ReturnType<typeof api.login>>, { mfa_required: false }>) {
    if (result.device_token) await writeDeviceToken(result.device_token);

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
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      // A device that has passed a code before offers to skip the next one.
      const result = await api.login(email.trim(), password, await readDeviceToken());

      if (result.mfa_required) {
        setStage({
          step: 'code',
          challengeId: result.challenge_id,
          sentTo: result.sent_to,
        });
        setCode('');
        return;
      }

      await land(result);
    } catch {
      // The API answers a wrong password, an unknown address and a locked
      // account identically, and so does this.
      setError('That email and password do not match an account.');
    } finally {
      setBusy(false);
    }
  }

  async function submitCode() {
    if (stage.step !== 'code') return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.verifyMfa({
        challenge_id: stage.challengeId,
        code: code.trim(),
        remember_device: remember,
      });
      // The server only ever sends `mfa_required: false` here; the guard is
      // for the type rather than for a case that can happen.
      if (result.mfa_required) throw new Error('unexpected challenge');
      await land(result);
    } catch {
      // One sentence for a wrong code, a spent one, and an expired one — the
      // API makes no distinction either, because the difference is what
      // somebody working through six digits wants to learn.
      setError('That code is not right, or it has expired.');
    } finally {
      setBusy(false);
    }
  }

  /** Back to the password, which is also how a fresh code is requested. */
  function startOver() {
    setStage({ step: 'credentials' });
    setCode('');
    setError(null);
  }

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          {/*
            The horizontal lockup rather than the symbol: this is a brand
            presentation, not a compact space, and it is the first thing
            anybody sees of the product (§11).
          */}
          <Logo height={34} />
          {/* §11 uses the tagline sparingly; sign-in is one of the places. */}
          <Text style={styles.tagline}>Aircraft management, simplified.</Text>
        </View>

        {stage.step === 'credentials' ? (
          <>
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
          </>
        ) : (
          <>
            <Body muted>
              We sent a six-digit code to {stage.sentTo}. It works once and expires in ten
              minutes.
            </Body>

            <Field label="Code" required>
              <Input
                value={code}
                onChangeText={setCode}
                keyboardType="number-pad"
                maxLength={6}
                // iOS reads the code out of the notification and offers it
                // above the keyboard, which is the difference between this
                // step being a nuisance and being one tap.
                textContentType="oneTimeCode"
                autoComplete="sms-otp"
                autoFocus
                onSubmitEditing={submitCode}
                style={styles.code}
              />
            </Field>

            {/*
              Asked, not assumed. A shared club laptop is exactly where a
              remembered device should not happen, and the person holding the
              phone is the only one who knows which this is.
            */}
            <Pressable
              onPress={() => setRemember((on) => !on)}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: remember }}
              style={({ pressed }) => [styles.remember, pressed && styles.pressed]}
            >
              <Feather
                name={remember ? 'check-square' : 'square'}
                size={20}
                color={remember ? color.tealText : color.secondary}
              />
              <Text style={styles.rememberLabel}>
                Remember this device for 30 days
              </Text>
            </Pressable>

            {error ? <Notice tone="error">{error}</Notice> : null}

            <Button
              label="Sign in"
              onPress={submitCode}
              busy={busy}
              disabled={code.trim().length !== 6}
            />
            {/* Starting over is how a fresh code is asked for: the password
                step mints a new challenge, which is the only thing that can. */}
            <Button label="Use a different account or resend" variant="secondary" onPress={startOver} />
          </>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: color.mist },
  container: { padding: space.base, gap: space.base, justifyContent: 'center', flexGrow: 1 },
  header: { gap: space.xs, marginBottom: space.sm },
  // Manrope, and the one place on this screen that uses it: §11 §4 keeps
  // the brand face for the tagline and the operational face for everything
  // a pilot actually works in.
  tagline: { ...type.tagline, color: color.secondary },
  // Wide-spaced and large, because six digits are read off one screen and
  // typed into another and every mistyped one costs a round trip.
  code: { fontSize: 24, letterSpacing: 8, textAlign: 'center' },
  remember: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: 44 },
  rememberLabel: { ...type.bodySmall, flexShrink: 1 },
  pressed: { opacity: 0.7 },
});
