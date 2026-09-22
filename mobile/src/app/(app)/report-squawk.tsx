import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { AircraftResponse, SquawkSeverity } from '@flightsquare/shared';

import { Body, Button, Card, Choice, Field, Input, Notice, SectionHeading } from '@/components/ui';
import { api, messageFor, withAuth } from '@/lib/api';
import { saveSquawk } from '@/lib/sync';
import { color, space, type } from '@/theme';

/**
 * Reporting a defect, from the ramp.
 *
 * §1.5 makes this a different permission from maintenance, and the screen
 * says as much: a pilot writes down what they found and somebody qualified
 * decides what happens next. Nothing here closes, defers, or signs anything
 * off, and the API would refuse it if it tried.
 *
 * Offline like the post-flight entry, and for a sharper reason (§8.2): a
 * flight that syncs late leaves the meters stale for an hour, but a squawk
 * that was never filed because the form wanted a network leaves the next
 * pilot walking out to an aircraft nobody warned them about.
 */

const SEVERITIES: { value: SquawkSeverity; label: string }[] = [
  { value: 'advisory', label: 'Advisory — worth knowing' },
  { value: 'minor', label: 'Minor — airworthy, needs attention' },
  { value: 'major', label: 'Major — get it looked at' },
  { value: 'grounding', label: 'Grounding — do not fly' },
];

export default function ReportSquawk() {
  const { aircraft: aircraftId } = useLocalSearchParams<{ aircraft: string }>();

  const [aircraft, setAircraft] = useState<AircraftResponse | null>(null);
  const [summary, setSummary] = useState('');
  const [details, setDetails] = useState('');
  const [severity, setSeverity] = useState<SquawkSeverity>('minor');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Only to put the registration at the top of the screen. If there is no
    // signal the form still works — that is the point of it.
    void withAuth(() => api.getAircraft(aircraftId))
      .then(setAircraft)
      .catch(() => undefined);
  }, [aircraftId]);

  async function submit() {
    if (!summary.trim()) {
      setError('Describe the defect in a few words.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await saveSquawk({
        aircraft_id: aircraftId,
        summary: summary.trim(),
        ...(details.trim() ? { details: details.trim() } : {}),
        severity,
        // 'grounding' severity always grounds. The two are separate columns
        // because they are separate judgements — a mechanic can ground
        // something reported as minor once they have looked at it — but a
        // pilot only ever sets the one they are qualified to set.
        grounding: severity === 'grounding',
      });
      router.back();
    } catch (error) {
      // The server's own words where it has them — a plan limit in
      // particular, which this app states and never offers to fix (§8.3).
      setError(messageFor(error));
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
        {aircraft ? <Text style={styles.registration}>{aircraft.registration}</Text> : null}

        <Card style={styles.group}>
          <Field label="What is wrong" required>
            <Input
              value={summary}
              onChangeText={setSummary}
              placeholder="Left brake soft"
              maxLength={200}
              autoFocus
            />
          </Field>

          <Field label="Details" hint="What you saw, heard or felt.">
            <Input
              value={details}
              onChangeText={setDetails}
              placeholder="Pedal travels most of the way before it bites."
              multiline
              maxLength={4000}
              style={styles.details}
            />
          </Field>
        </Card>

        <Card style={styles.group}>
          <SectionHeading>How bad is it</SectionHeading>
          <Choice options={SEVERITIES} value={severity} onChange={setSeverity} />
          {severity === 'grounding' ? (
            <Notice tone="error">
              This stops the aircraft being booked until somebody with maintenance access
              resolves or defers it.
            </Notice>
          ) : null}
        </Card>

        {/*
          §3.6: the squawk log is one of the records read back after an
          accident, so it is not something anyone edits later. Said before
          the tap, not after it.
        */}
        <Body muted>What you report here stays as written. Anything further is a new squawk.</Body>

        {error ? <Notice tone="error">{error}</Notice> : null}

        <Button label="File squawk" onPress={submit} busy={busy} />
        <Body muted>Saved on this phone first, and sent when there is signal.</Body>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: color.surface },
  container: { padding: space.base, gap: space.base, paddingBottom: space.xxl },
  registration: { ...type.pageTitle, color: color.brandBlack },
  group: { gap: space.base },
  details: { height: 96, paddingTop: space.sm, textAlignVertical: 'top' },
});
