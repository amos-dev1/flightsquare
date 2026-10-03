import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { Linking, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { dayLabel } from '@flightsquare/shared/time';
import type {
  AircraftDocumentKind,
  AircraftDocumentResponse,
  AircraftResponse,
} from '@flightsquare/shared';

import { Body, Button, Notice, SectionHeading } from '@/components/ui';
import { Sheet } from '@/components/sheet';
import { api, messageFor, withAuth } from '@/lib/api';
import { usePermission } from '@/lib/entitlements';
import { pickFile, type FileSource } from '@/lib/pick-file';
import { color, radius, space, statusColor, type } from '@/theme';

/**
 * An aeroplane's paperwork (§3.2).
 *
 * The AROW set is the reason it exists: a pilot is responsible for the
 * airworthiness certificate, registration, operating limitations and weight and
 * balance being aboard, and until now had to take it on trust or go and look in
 * the aeroplane. Insurance is not AROW and is here because it is the one a club
 * actually chases.
 *
 * **Pilots read it; filing is the admin's.** `documents: read` has been in the
 * Pilot bundle since `0027` and nothing has used it until now — a pilot needs
 * the weight and balance, and the rest is what they are signing for.
 *
 * **A lapsed document never grounds the aeroplane**, and every line here is
 * worded so nobody concludes otherwise. §11 forbids inferring airworthiness
 * from an absence of warnings and the mirror binds just as hard: the club may
 * have renewed and not uploaded the scan.
 */

const ORDER: AircraftDocumentKind[] = [
  'airworthiness',
  'registration',
  'operating_limitations',
  'weight_balance',
  'insurance',
  'other',
];

const NOUN: Record<AircraftDocumentKind, string> = {
  airworthiness: 'Airworthiness certificate',
  registration: 'Registration',
  operating_limitations: 'Operating limitations',
  weight_balance: 'Weight and balance',
  insurance: 'Insurance',
  other: 'Other',
};

/** Which ones have a date to count down to at all. */
const EXPIRES: Record<AircraftDocumentKind, boolean> = {
  airworthiness: false,
  registration: true,
  operating_limitations: false,
  weight_balance: false,
  insurance: true,
  other: true,
};

export default function AircraftDocuments() {
  const { aircraft: aircraftParam, id: documentParam } = useLocalSearchParams<{
    aircraft?: string;
    id?: string;
  }>();
  const canWrite = usePermission('documents') === 'write';

  const [aircraftId, setAircraftId] = useState(aircraftParam ?? null);
  const [aircraft, setAircraft] = useState<AircraftResponse | null>(null);
  const [documents, setDocuments] = useState<AircraftDocumentResponse[]>([]);
  const [filing, setFiling] = useState<AircraftDocumentKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      // Reached from the bell with a document id and no aeroplane: resolve it
      // once rather than asking every aircraft whether it owns the thing.
      let id = aircraftId;
      if (!id && documentParam) {
        id = (await withAuth(() => api.aircraftDocument(documentParam))).aircraft_id;
        setAircraftId(id);
      }
      if (!id) return;

      const [one, list] = await Promise.all([
        withAuth(() => api.getAircraft(id)),
        withAuth(() => api.listAircraftDocuments(id)),
      ]);
      setAircraft(one);
      setDocuments(list);
      setError(null);
    } catch (problem) {
      setError(messageFor(problem));
    }
  }, [aircraftId, documentParam]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  async function file(kind: AircraftDocumentKind, source: FileSource) {
    setFiling(null);
    if (!aircraftId) return;

    let picked;
    try {
      picked = await pickFile(source);
    } catch (problem) {
      setError(messageFor(problem));
      return;
    }
    // Backed out, or declined the permission. Not a failure.
    if (!picked) return;

    try {
      /*
        The document first, then its file. That is the order the schema
        enforces — the owner exists and the upload names it — and it is the same
        three steps every upload in this product uses: sign a PUT, send the
        bytes straight to storage, record what arrived.

        Online only, deliberately. A certificate arrives as an email attachment
        from a broker and is filed at a desk; the queue exists for writes made
        at a tiedown on one bar, which this is not.
      */
      const document = await withAuth(() =>
        api.createAircraftDocument(aircraftId, { kind, title: picked.name ?? NOUN[kind] }),
      );
      const signed = await withAuth(() =>
        api.createDocumentAttachment(document.id, {
          content_type: picked.contentType,
          byte_size: 1,
        }),
      );

      const body = await fetch(picked.uri).then((response) => response.blob());
      const sent = await fetch(signed.upload_url!, {
        method: 'PUT',
        headers: { 'Content-Type': picked.contentType },
        body,
      });
      if (!sent.ok) throw new Error(`the upload was refused (${sent.status})`);

      await withAuth(() => api.completeDocumentAttachment(document.id, signed.id));
      await load();
    } catch (problem) {
      setError(messageFor(problem));
    }
  }

  const current = documents.filter((one) => one.status === 'active' && !one.superseded);
  const superseded = documents.filter((one) => one.superseded || one.status === 'removed');

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
      {error ? <Notice tone="error">{error}</Notice> : null}

      <View>
        <Text style={styles.registration}>{aircraft?.registration ?? '—'}</Text>
        <Body muted>
          What should be aboard, and what the club has on file. Nothing here affects bookings.
        </Body>
      </View>

      {ORDER.map((kind) => {
        const held = current.filter((one) => one.kind === kind);
        return (
          <View key={kind} style={styles.group}>
            <View style={styles.groupHead}>
              <SectionHeading>{NOUN[kind]}</SectionHeading>
              {canWrite ? (
                <Pressable
                  onPress={() => setFiling(kind)}
                  accessibilityRole="button"
                  accessibilityLabel={`Add a ${NOUN[kind].toLowerCase()}`}
                  style={({ pressed }) => [styles.add, pressed && styles.pressed]}
                >
                  <Feather name="plus" size={16} color={color.navy} />
                  <Text style={styles.addLabel}>Add</Text>
                </Pressable>
              ) : null}
            </View>

            {held.length === 0 ? (
              <Body muted>
                {EXPIRES[kind] ? 'Nothing on file.' : 'Nothing on file. This one does not expire.'}
              </Body>
            ) : (
              held.map((document) => <DocumentCard key={document.id} document={document} />)
            )}
          </View>
        );
      })}

      {superseded.length > 0 ? (
        <View style={styles.group}>
          <SectionHeading>Replaced and removed</SectionHeading>
          {/* Kept, never deleted: last year's certificate is what answers a
              question about last year (§10). */}
          <Body muted>Kept on file. Last year&apos;s certificate is what answers a question about last year.</Body>
          {superseded.map((document) => (
            <DocumentCard key={document.id} document={document} faded />
          ))}
        </View>
      ) : null}

      <Sheet
        visible={filing !== null}
        title={filing ? NOUN[filing] : ''}
        onClose={() => setFiling(null)}
      >
        {(
          [
            { source: 'camera', label: 'Take a photo', icon: 'camera' },
            { source: 'library', label: 'Choose a photo', icon: 'image' },
            { source: 'files', label: 'Choose a file or PDF', icon: 'file-text' },
          ] as const
        ).map((option) => (
          <Pressable
            key={option.source}
            onPress={() => filing && void file(filing, option.source)}
            accessibilityRole="button"
            style={({ pressed }) => [styles.option, pressed && styles.pressed]}
          >
            <Feather name={option.icon} size={20} color={color.navy} />
            <Text style={styles.optionLabel}>{option.label}</Text>
          </Pressable>
        ))}
      </Sheet>
    </ScrollView>
  );
}

function DocumentCard({
  document,
  faded,
}: {
  document: AircraftDocumentResponse;
  faded?: boolean;
}) {
  const expiry = expiryWording(document.expires_on);

  return (
    <View style={[styles.card, faded && styles.cardFaded]}>
      <View style={styles.cardHead}>
        <Text style={styles.cardTitle} numberOfLines={1}>
          {document.title}
        </Text>
        {expiry ? (
          <Text style={[styles.expiry, { color: expiry.ink }]}>{expiry.label}</Text>
        ) : (
          <Text style={styles.meta}>No expiry</Text>
        )}
      </View>

      {document.reference ? <Text style={styles.meta}>{document.reference}</Text> : null}
      {document.status === 'removed' ? (
        <Text style={styles.meta}>Removed — {document.removed_reason}</Text>
      ) : document.superseded ? (
        <Text style={styles.meta}>Replaced by a newer one</Text>
      ) : null}
      {document.notes ? <Text style={styles.meta}>{document.notes}</Text> : null}

      {document.attachments.length === 0 ? (
        <Text style={styles.meta}>Recorded, not scanned yet</Text>
      ) : (
        document.attachments.map((item) => (
          <Pressable
            key={item.id}
            onPress={() => item.url && void Linking.openURL(item.url)}
            disabled={!item.url}
            accessibilityRole="button"
            accessibilityLabel="Open this file"
            style={({ pressed }) => [styles.fileRow, pressed && styles.pressed]}
          >
            <Feather
              name={item.content_type === 'application/pdf' ? 'file-text' : 'image'}
              size={14}
              color={color.tealText}
            />
            <Text style={styles.fileLabel}>Open</Text>
          </Pressable>
        ))
      )}
    </View>
  );
}

/**
 * How an expiry reads — and what it deliberately never says.
 *
 * Amber rather than red when it has passed, and the word is "Expired" and not
 * "Grounded". A lapsed certificate is a thing to renew: the aeroplane's dispatch
 * state comes from squawks and overdue maintenance items, and nothing here
 * touches it.
 */
function expiryWording(expiresOn: string | null): { label: string; ink: string } | null {
  if (expiresOn === null) return null;

  const days = Math.round(
    (new Date(`${expiresOn}T12:00:00`).getTime() - Date.now()) / 86_400_000,
  );
  if (days < 0) return { label: `Expired ${dayLabel(expiresOn)}`, ink: statusColor.warn.ink };
  if (days === 0) return { label: 'Expires today', ink: statusColor.warn.ink };
  if (days <= 60) return { label: `Expires in ${days} days`, ink: statusColor.warn.ink };
  return { label: `Expires ${dayLabel(expiresOn)}`, ink: color.secondary };
}

const styles = StyleSheet.create({
  container: { padding: space.base, gap: space.lg, paddingBottom: space.xxl },
  pressed: { opacity: 0.7 },
  group: { gap: space.sm },
  groupHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  meta: { ...type.supporting, color: color.secondary, fontFamily: type.body.fontFamily },
  registration: { ...type.pageTitle, textTransform: 'uppercase' },

  add: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    minHeight: 44,
    paddingHorizontal: space.md,
    borderRadius: radius.control,
    borderWidth: 1,
    borderColor: color.control,
    backgroundColor: color.surface,
  },
  addLabel: { ...type.button },

  card: {
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.line,
    borderRadius: radius.card,
    padding: space.base,
    gap: space.xs,
  },
  cardFaded: { backgroundColor: color.subtle },
  cardHead: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: space.sm,
  },
  cardTitle: { ...type.cardHeading, flexShrink: 1 },
  expiry: { ...type.supporting },

  fileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    minHeight: 32,
    alignSelf: 'flex-start',
  },
  fileLabel: { ...type.supporting, color: color.tealText, textDecorationLine: 'underline' },

  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.base,
    borderWidth: 1,
    borderColor: color.line,
    borderRadius: radius.card,
    minHeight: 56,
  },
  optionLabel: { ...type.bodySmall },
});
