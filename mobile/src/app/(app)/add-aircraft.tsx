import { router } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';

import { Body, Button, Card, Field, Input, Notice, SectionHeading } from '@/components/ui';
import { api, messageFor, withAuth } from '@/lib/api';
import { useEntitlements } from '@/lib/entitlements';
import { space } from '@/theme';

/**
 * Adding an aeroplane.
 *
 * Registration is the only thing the API insists on; everything else here is
 * optional because §3.4's rule about the post-flight form applies to any form
 * somebody fills in standing up — the rest can be filled in later on the web,
 * where there is a keyboard and the whole configuration screen.
 *
 * **The gates are the server's, and this screen does not duplicate them.**
 * §1.6 orders them feature, permission, quota; the entitlement fetch decides
 * whether the button that reaches this screen exists at all (§8.1: the client
 * hiding a button is cosmetics), and `assert_quota` decides whether the write
 * lands. A 402 arriving here is shown in the server's own words.
 *
 * §8.3: it says what the limit is and stops. No price, no link, nothing that
 * reads as a route to a purchase — that is what keeps this app inside Apple's
 * 3.1.3(f).
 */
export default function AddAircraft() {
  const { refresh } = useEntitlements();

  const [registration, setRegistration] = useState('');
  const [typeCode, setTypeCode] = useState('');
  const [homeBase, setHomeBase] = useState('');
  const [hobbs, setHobbs] = useState('');
  const [tach, setTach] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    const tail = registration.trim().toUpperCase();
    if (!tail) {
      setError('Enter the registration.');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await withAuth(() =>
        api.createAircraft({
          registration: tail,
          ...(typeCode.trim() ? { type_code: typeCode.trim().toUpperCase() } : {}),
          ...(homeBase.trim() ? { home_base: homeBase.trim().toUpperCase() } : {}),
          // §3.4: even the opening numbers are written as a reading, so the
          // totals stay derived from the log rather than set behind it.
          ...(hobbs.trim() ? { hobbs: hobbs.trim() } : {}),
          ...(tach.trim() ? { tach: tach.trim() } : {}),
        }),
      );
      // The count in the header and the fleet list both read this.
      await refresh();
      router.back();
    } catch (caught) {
      // The server's own words: a registration already in use, a type
      // designator it does not know, or the plan limit (§1.6's 402).
      setError(messageFor(caught));
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
        <Card style={styles.group}>
          <SectionHeading>The aircraft</SectionHeading>
          <Field label="Registration" required hint="The tail number, as it is painted on.">
            <Input
              value={registration}
              onChangeText={setRegistration}
              placeholder="N2435C"
              autoCapitalize="characters"
              autoCorrect={false}
              maxLength={16}
              autoFocus
            />
          </Field>

          <Field label="Type" hint="The ICAO designator — C172, SR22, P28A.">
            <Input
              value={typeCode}
              onChangeText={setTypeCode}
              placeholder="C172"
              autoCapitalize="characters"
              autoCorrect={false}
              maxLength={16}
            />
          </Field>

          <Field label="Home base" hint="Where it normally lives.">
            <Input
              value={homeBase}
              onChangeText={setHomeBase}
              placeholder="KPAO"
              autoCapitalize="characters"
              autoCorrect={false}
              maxLength={16}
            />
          </Field>
        </Card>

        <Card style={styles.group}>
          <SectionHeading>Where the meters stand</SectionHeading>
          {/* The one time these are set rather than advanced. Optional, and
              a correction later is a new reading rather than an edit. */}
          <Body muted>
            Optional. Today’s readings, so the first flight counts from the
            right place.
          </Body>
          <View style={styles.pair}>
            <View style={styles.half}>
              <Field label="Hobbs">
                <Input value={hobbs} onChangeText={setHobbs} keyboardType="decimal-pad" />
              </Field>
            </View>
            <View style={styles.half}>
              <Field label="Tach">
                <Input value={tach} onChangeText={setTach} keyboardType="decimal-pad" />
              </Field>
            </View>
          </View>
        </Card>

        {error ? <Notice tone="error">{error}</Notice> : null}

        <Button label="Add aircraft" onPress={() => void submit()} busy={busy} />
        <Body muted>
          Maintenance intervals for the type are created with it. You can
          change any of this later.
        </Body>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { padding: space.base, gap: space.base, paddingBottom: space.xxl },
  group: { gap: space.base },
  pair: { flexDirection: 'row', gap: space.md },
  half: { flex: 1 },
});
