import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import type { NotificationResponse } from '@flightsquare/shared';

import { Body, Notice, SectionHeading } from '@/components/ui';
import { api, withAuth } from '@/lib/api';
import { color, radius, space, statusColor, type } from '@/theme';

/**
 * The feed behind the bell (§3.8).
 *
 * Every notice points somewhere, because a notice a pilot cannot act on trains
 * them to ignore the bell. The target arrives as a kind and an id rather than a
 * path — §8.1: a path written into a row outlives the build that could route it,
 * and this screen is the thing doing the routing.
 *
 * Opening one marks it read. Not a separate gesture: the dot exists to say
 * "there is something you have not seen", and tapping through is seeing it.
 */

export default function Notifications() {
  const [rows, setRows] = useState<NotificationResponse[]>([]);
  const [offline, setOffline] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      setRows(await withAuth(() => api.listNotifications()));
      setOffline(false);
    } catch {
      setOffline(true);
    } finally {
      setLoaded(true);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  async function open(row: NotificationResponse) {
    // Optimistic, and deliberately so: the read mark is a convenience, and a
    // tiedown with no signal should still get the screen it asked for.
    setRows((current) =>
      current.map((one) =>
        one.id === row.id ? { ...one, read_at: one.read_at ?? new Date().toISOString() } : one,
      ),
    );
    void withAuth(() => api.markNotificationRead(row.id)).catch(() => undefined);

    const to = destinationFor(row);
    if (to) router.push(to);
  }

  async function readAll() {
    const now = new Date().toISOString();
    setRows((current) => current.map((one) => ({ ...one, read_at: one.read_at ?? now })));
    await withAuth(() => api.markAllNotificationsRead()).catch(() => undefined);
  }

  const unread = rows.filter((row) => row.read_at === null).length;

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

      {unread > 0 ? (
        <View style={styles.head}>
          <SectionHeading>
            {unread} unread
          </SectionHeading>
          <Pressable
            onPress={() => void readAll()}
            accessibilityRole="button"
            accessibilityLabel="Mark everything read"
            style={({ pressed }) => [styles.readAll, pressed && styles.pressed]}
          >
            <Text style={styles.readAllLabel}>Mark all read</Text>
          </Pressable>
        </View>
      ) : null}

      {rows.length === 0 ? (
        loaded && !offline ? (
          <View style={styles.empty}>
            <Feather name="bell" size={24} color={color.secondary} />
            <SectionHeading>Nothing here</SectionHeading>
            <Body muted>
              Maintenance coming due, an aircraft going down, and a booking that needs a second
              look all land here.
            </Body>
          </View>
        ) : null
      ) : (
        rows.map((row) => {
          const tone = toneOf(row.kind);
          return (
            <Pressable
              key={row.id}
              onPress={() => void open(row)}
              accessibilityRole="button"
              accessibilityLabel={`${row.title}. ${row.read_at === null ? 'Unread' : 'Read'}`}
              style={({ pressed }) => [
                styles.row,
                row.read_at === null && styles.rowUnread,
                pressed && styles.pressed,
              ]}
            >
              <View style={[styles.icon, { backgroundColor: tone.surface }]}>
                <Feather name={iconFor(row.kind)} size={16} color={tone.ink} />
              </View>
              <View style={styles.body}>
                <Text style={row.read_at === null ? styles.titleUnread : styles.title}>
                  {row.title}
                </Text>
                {row.body ? <Text style={styles.detail}>{row.body}</Text> : null}
                <Text style={styles.when}>{when(row.created_at)}</Text>
              </View>
              {destinationFor(row) ? (
                <Feather name="chevron-right" size={18} color={color.secondary} />
              ) : null}
            </Pressable>
          );
        })
      )}
    </ScrollView>
  );
}

/**
 * Where a notice goes, from its kind and subject.
 *
 * Returns nothing rather than guessing when this build does not know the kind.
 * A new `kind` is additive (§8.1) and a shipped app will meet one — showing the
 * title and going nowhere is the honest outcome, and better than routing to a
 * screen that is not about it.
 */
function destinationFor(
  row: NotificationResponse,
):
  | {
      pathname: '/(app)/maintenance-item' | '/(app)/reservation' | '/(app)/aircraft-documents';
      params: { id: string } | { aircraft: string };
    }
  | null {
  if (row.subject_id === null) return null;
  switch (row.subject_type) {
    case 'maintenance_item':
      return { pathname: '/(app)/maintenance-item', params: { id: row.subject_id } };
    case 'reservation':
      return { pathname: '/(app)/reservation', params: { id: row.subject_id } };
    case 'aircraft_document':
      // The list rather than the row: a renewal is filed beside the one it
      // replaces, and that is what somebody needs to see.
      return { pathname: '/(app)/aircraft-documents', params: { id: row.subject_id } };
    default:
      // `aircraft` and `squawk` have no detail screen a pilot can reach yet.
      return null;
  }
}

function iconFor(
  kind: NotificationResponse['kind'],
): 'alert-triangle' | 'clock' | 'calendar' | 'tool' | 'file-text' {
  switch (kind) {
    case 'maintenance_overdue':
    case 'aircraft_grounded':
      return 'alert-triangle';
    case 'booking_needs_review':
      return 'calendar';
    case 'squawk_filed':
      return 'tool';
    case 'document_expiring':
      return 'file-text';
    default:
      return 'clock';
  }
}

function toneOf(kind: NotificationResponse['kind']): { surface: string; ink: string } {
  switch (kind) {
    case 'maintenance_overdue':
    case 'aircraft_grounded':
      return statusColor.bad;
    case 'maintenance_due_soon':
    case 'booking_needs_review':
      return statusColor.urgent;
    /*
      Amber, never red, and this is deliberate.

      A lapsed certificate is a thing to renew, not a grounding — §11 forbids
      inferring airworthiness from a filing gap, and a red dot beside an
      aeroplane is exactly how somebody would infer one.
    */
    case 'document_expiring':
      return statusColor.warn;
    case 'aircraft_returned':
      return statusColor.good;
    default:
      return statusColor.neutral;
  }
}

/** Relative, because "3 hours ago" is what somebody wants from a feed. */
function when(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} days ago`;
  return new Date(iso).toLocaleDateString();
}

const styles = StyleSheet.create({
  container: { padding: space.base, gap: space.sm, paddingBottom: space.xxl },
  pressed: { opacity: 0.7 },

  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: space.xs,
  },
  readAll: { minHeight: 44, justifyContent: 'center', paddingHorizontal: space.sm },
  readAllLabel: { ...type.button, color: color.tealText, textDecorationLine: 'underline' },

  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.md,
    padding: space.base,
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.line,
    borderRadius: radius.card,
  },
  // An unread row is marked by its border and by the weight of its title, not
  // by a colour alone (§11 §13).
  rowUnread: { borderColor: color.teal, borderLeftWidth: 3 },
  icon: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  body: { flex: 1, gap: 2 },
  title: { ...type.bodySmall },
  titleUnread: { ...type.bodySmall, fontFamily: type.label.fontFamily },
  detail: { ...type.supporting, color: color.secondary, fontFamily: type.body.fontFamily },
  when: { ...type.supporting, color: color.secondary, marginTop: 2 },

  empty: { alignItems: 'center', gap: space.sm, paddingVertical: space.xl },
});
