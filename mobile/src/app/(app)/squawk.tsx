import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import {
  Image, Linking, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View,
} from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { ApiError, type SquawkResponse } from '@flightsquare/shared';

import { Body, Card, CardHeading, Notice, SectionHeading, Status } from '@/components/ui';
import { Pill } from '@/components/maintenance';
import { api, withAuth } from '@/lib/api';
import { color, radius, space, type } from '@/theme';

const SEVERITY: Record<SquawkResponse['severity'], string> = {
  advisory: 'Advisory — worth knowing',
  minor: 'Minor — airworthy, needs attention',
  major: 'Major — get it looked at',
  grounding: 'Grounding — do not fly',
};

/**
 * One defect, and everything said about it.
 *
 * The phone had a list of squawks it could not open: a card with a summary
 * and nothing behind it, while the photographs, the deferral history and the
 * resolution sat on the server. This is the read — resolving and deferring
 * stay on the web and need `maintenance.items: write` (§1.5), which a Pilot
 * does not hold and the API would refuse anyway (§8.1).
 *
 * The whole deferral history, not just the current one: §7.2 names it among
 * the records read back after an accident, which is also why lifting a
 * deferral leaves its row exactly where it was.
 */
export default function Squawk() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [squawk, setSquawk] = useState<SquawkResponse | null>(null);
  const [missing, setMissing] = useState(false);
  const [offline, setOffline] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      setSquawk(await withAuth(() => api.getSquawk(id)));
      setMissing(false);
      setOffline(false);
    } catch (error) {
      // §6: another tenant's squawk and one that never existed read the same.
      if (error instanceof ApiError && error.status === 404) setMissing(true);
      else setOffline(true);
    }
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  if (missing) {
    return (
      <View style={styles.container}>
        <Notice>That squawk could not be found.</Notice>
      </View>
    );
  }

  return (
    <ScrollView
      contentContainerStyle={styles.container}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true);
            void load().finally(() => setRefreshing(false));
          }}
        />
      }
    >
      {offline ? <Notice>Showing what loaded last. No connection.</Notice> : null}

      {squawk ? (
        <>
          <View style={styles.head}>
            <Text style={styles.summary}>{squawk.summary}</Text>
            {/*
              Grounding is said in words and kept apart from severity, because
              it is a separate judgement (§3.6) — and it only stops the
              aeroplane while the squawk is open; a deferral lifts it.
            */}
            <View style={styles.chips}>
              {squawk.grounding && squawk.status === 'open' ? (
                <Pill state="overdue" label="Grounding" />
              ) : null}
              {squawk.status === 'deferred' ? <Status label="Deferred" /> : null}
              {squawk.status === 'resolved' ? <Status label="Resolved" /> : null}
              {squawk.status === 'open' && !squawk.grounding ? <Status label="Open" /> : null}
            </View>
          </View>

          <Card style={styles.facts}>
            {/* Registrations stay uppercase: §11 reserves it for exactly this. */}
            <Fact label="Aircraft" value={squawk.aircraft_registration} />
            <Fact label="Severity" value={SEVERITY[squawk.severity]} />
            <Fact
              label="Reported"
              value={`${dateOf(squawk.reported_at)} · ${squawk.reported_by_email ?? 'a member'}`}
            />
            {squawk.resolved_at ? (
              <Fact label="Resolved" value={dateOf(squawk.resolved_at)} />
            ) : null}
          </Card>

          {squawk.details ? (
            <View style={styles.group}>
              <SectionHeading>What was found</SectionHeading>
              <Card>
                <Body>{squawk.details}</Body>
              </Card>
            </View>
          ) : null}

          {/*
            What the pilot photographed at the aircraft. Full size in the
            browser: the URL is signed and short-lived, so opening it is the
            whole of what a bigger view needs.
          */}
          {squawk.attachments.some((photo) => photo.url) ? (
            <View style={styles.group}>
              <SectionHeading>Photos</SectionHeading>
              <View style={styles.photos}>
                {squawk.attachments.map((photo, index) =>
                  photo.url ? (
                    <Pressable
                      key={photo.id}
                      onPress={() => void Linking.openURL(photo.url!)}
                      accessibilityRole="imagebutton"
                      accessibilityLabel={`Open photo ${index + 1} of this defect`}
                    >
                      {photo.content_type === 'application/pdf' ? (
                        <View style={[styles.thumb, styles.pdf]}>
                          <Feather name="file-text" size={20} color={color.secondary} />
                          <Text style={styles.pdfLabel}>PDF</Text>
                        </View>
                      ) : (
                        <Image source={{ uri: photo.url }} style={styles.thumb} />
                      )}
                    </Pressable>
                  ) : null,
                )}
              </View>
            </View>
          ) : null}

          {squawk.deferrals.length > 0 ? (
            <View style={styles.group}>
              <SectionHeading>Deferrals</SectionHeading>
              {squawk.deferrals.map((deferral) => (
                <Card key={deferral.id} style={styles.deferral}>
                  <CardHeading>
                    {deferral.basis === 'far_91_213'
                      ? '14 CFR 91.213'
                      : deferral.basis.toUpperCase()}
                    {deferral.reference ? ` (${deferral.reference})` : ''}
                  </CardHeading>
                  <Text style={styles.meta}>
                    Deferred {dateOf(deferral.deferred_at)}
                    {deferral.expires_on ? ` · until ${deferral.expires_on}` : ''}
                  </Text>
                  {deferral.note ? <Body muted>{deferral.note}</Body> : null}
                </Card>
              ))}
            </View>
          ) : null}

          {squawk.resolution_note ? (
            <View style={styles.group}>
              <SectionHeading>Resolution</SectionHeading>
              <Card>
                <Body>{squawk.resolution_note}</Body>
              </Card>
            </View>
          ) : null}
        </>
      ) : null}
    </ScrollView>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.fact}>
      <Text style={styles.factLabel}>{label}</Text>
      <Text style={styles.factValue}>{value}</Text>
    </View>
  );
}

function dateOf(instant: string): string {
  return new Date(instant).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

const styles = StyleSheet.create({
  container: { padding: space.base, gap: space.base },
  head: { gap: space.sm },
  summary: { ...type.sectionHeading },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  group: { gap: space.sm },
  facts: { gap: space.md },
  fact: { gap: 2 },
  factLabel: { ...type.supporting, color: color.secondary },
  factValue: { ...type.body },
  photos: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  thumb: {
    width: 88,
    height: 88,
    borderRadius: radius.control,
    borderWidth: 1,
    borderColor: color.line,
    backgroundColor: color.subtle,
  },
  pdf: { alignItems: 'center', justifyContent: 'center', gap: space.xs },
  pdfLabel: { ...type.supporting, color: color.secondary },
  deferral: { gap: space.xs },
  meta: { ...type.supporting, color: color.secondary },
});
