import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import type {
  AircraftResponse,
  MaintenanceItemResponse,
  SquawkResponse,
} from '@flightsquare/shared';

import { Body, Button, Card, Notice, SectionHeading, Status } from '@/components/ui';
import { api, withAuth } from '@/lib/api';
import { color, space, type } from '@/theme';

/**
 * What the fleet owes and what is wrong with it.
 *
 * Reading defects was the half that did not exist: a pilot could file one
 * from the phone and never see one, which makes the walk-around check — "has
 * anybody else found this?" — impossible in the place it is actually done.
 *
 * Two lists, because the dashboard counts both and a screen that showed only
 * one would contradict the number that sent you here. §1.5 keeps them
 * separate resources for a reason — filing a defect and signing off the work
 * are different acts done by different people — so they are separate
 * sections rather than one merged list.
 *
 * Nothing here closes anything. §1.5 puts every status change behind
 * `maintenance: write`, which a Pilot does not hold, and offering a button
 * the server would refuse is worse than not offering it.
 */
export default function Maintenance() {
  const [squawks, setSquawks] = useState<SquawkResponse[] | null>(null);
  const [items, setItems] = useState<MaintenanceItemResponse[]>([]);
  // A maintenance item carries `aircraft_id` and no registration, and a
  // card that cannot name the aeroplane is not worth showing.
  const [fleet, setFleet] = useState<AircraftResponse[]>([]);
  const [offline, setOffline] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [defects, due, aircraft] = await Promise.all([
        withAuth(() => api.listSquawks()),
        // Every tier has maintenance tracking (§4.3), so this does not 404
        // for entitlement reasons — but a tenant override could switch it
        // off, and the defects are worth showing either way.
        withAuth(() => api.listMaintenanceItems()).catch(() => []),
        withAuth(() => api.listAircraft()).catch(() => []),
      ]);
      setSquawks(defects);
      setItems(due);
      setFleet(aircraft);
      setOffline(false);
    } catch {
      // Same as the aircraft screen: whatever was loaded last stays up. An
      // empty defect list is a dangerous thing to show by accident.
      setOffline(true);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const open = squawks?.filter((squawk) => squawk.status !== 'resolved') ?? [];
  // Overdue before due-soon, and within each the aeroplane's own order.
  const attention = items
    .filter((item) => item.state === 'overdue' || item.state === 'due_soon')
    .sort((a, b) => {
      if (a.state !== b.state) return a.state === 'overdue' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  const registrationOf = (aircraftId: string): string =>
    fleet.find((aircraft) => aircraft.id === aircraftId)?.registration ?? 'Aircraft';
  // Grounding first, then most recently reported. §3.6's severity order is
  // advisory; what stops an aeroplane flying is the boolean.
  const sorted = [...open].sort((a, b) => {
    if (a.grounding !== b.grounding) return a.grounding ? -1 : 1;
    return b.reported_at.localeCompare(a.reported_at);
  });

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
      {offline ? <Notice>Offline. Showing what loaded last.</Notice> : null}

      {/*
        Maintenance first, because it is what the aeroplane is due rather
        than what somebody noticed, and the three states are kept apart on
        purpose. §11 forbids asserting something the records do not support:
        an interval seeded with the aircraft that nobody has confirmed is
        "not recorded", which is a different sentence from "overdue" and the
        one the rest of the product uses.
      */}
      {attention.length > 0 ? (
        <View style={styles.group}>
          <SectionHeading>Due</SectionHeading>
          {attention.map((item) => (
            <Card key={item.id}>
              <View style={styles.headline}>
                <Text style={styles.registration}>{registrationOf(item.aircraft_id)}</Text>
                <Status label={labelFor(item)} emphatic={isOverdue(item)} />
              </View>
              <Text style={styles.summary}>{item.name}</Text>
              <Text style={styles.meta}>{describe(item)}</Text>
            </Card>
          ))}
        </View>
      ) : null}

      {attention.length > 0 && sorted.length > 0 ? (
        <SectionHeading>Reported defects</SectionHeading>
      ) : null}

      {squawks !== null && sorted.length === 0 && attention.length === 0 ? (
        <View style={styles.empty}>
          <SectionHeading>Nothing outstanding</SectionHeading>
          <Body muted>
            {/*
              §11: never infer airworthiness from the absence of a warning.
              This says what the list contains, not what the aeroplane is.
            */}
            No open defects have been reported. That is not the same as an
            aircraft being airworthy — the Fleet tab has the dispatch answer.
          </Body>
        </View>
      ) : null}

      {sorted.map((squawk) => (
        <Card key={squawk.id}>
          <View style={styles.headline}>
            <Text style={styles.registration}>{squawk.aircraft_registration}</Text>
            {squawk.grounding ? <Status label="Grounding" emphatic /> : null}
            {squawk.status === 'deferred' ? <Status label="Deferred" /> : null}
          </View>

          <Text style={styles.summary}>{squawk.summary}</Text>
          {squawk.details ? <Body muted>{squawk.details}</Body> : null}

          <Text style={styles.meta}>
            {squawk.reported_by_email ?? 'a member'} · {squawk.reported_at.slice(0, 10)}
          </Text>

          {squawk.deferrals.length > 0 ? (
            <Text style={styles.meta}>
              {/* A deferral lifts the grounding and leaves the defect open,
                  so saying which basis it was deferred under is the whole
                  content of the line. */}
              Deferred under {squawk.deferrals[0]!.basis}
              {squawk.deferrals[0]!.expires_on
                ? ` until ${squawk.deferrals[0]!.expires_on}`
                : ''}
            </Text>
          ) : null}
        </Card>
      ))}

      <View style={styles.action}>
        <Button
          label="Report a defect"
          onPress={() => router.push('/(app)/report-squawk')}
        />
      </View>
    </ScrollView>
  );
}

/**
 * The three states, named the way every other screen names them.
 *
 * `state === 'overdue'` with `ever_complied === false` means the item was
 * created with the aeroplane and nobody has entered when it was last done.
 * That is not overdue — it is unknown — and §11 does not allow the stronger
 * claim.
 */
function isOverdue(item: MaintenanceItemResponse): boolean {
  return item.state === 'overdue' && item.ever_complied;
}

function labelFor(item: MaintenanceItemResponse): string {
  if (!item.ever_complied) return 'No record';
  return item.state === 'overdue' ? 'Overdue' : 'Due soon';
}

function describe(item: MaintenanceItemResponse): string {
  if (!item.ever_complied) {
    return 'Created with the aircraft. Record when it was last done and the countdown starts from the real date.';
  }

  const parts: string[] = [];
  if (item.days_remaining !== null) {
    const days = Number(item.days_remaining);
    parts.push(days < 0 ? `${Math.abs(days)} days over` : `${days} days left`);
  }
  if (item.hours_remaining !== null) {
    const hours = Number(item.hours_remaining);
    parts.push(
      hours < 0 ? `${Math.abs(hours).toFixed(1)} hours over` : `${hours.toFixed(1)} hours left`,
    );
  }
  /**
   * Both bases at once is normal, and they disagree constantly — §3.6 says
   * an item can be due on more than one and the earliest wins. So each one
   * says whether it is time left or time past: "131 days · 1106.7 hours
   * over" reads as though the days were over too, which is the opposite of
   * what it means.
   */
  return parts.length > 0 ? parts.join(' · ') : 'Due';
}

const styles = StyleSheet.create({
  container: { padding: space.base, gap: space.md },
  group: { gap: space.sm },
  empty: { gap: space.sm, paddingVertical: space.lg },
  headline: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  registration: { ...type.cardHeading, flex: 1 },
  summary: { ...type.body, marginTop: space.xs },
  meta: { ...type.supporting, color: color.secondary, marginTop: space.xs },
  action: { marginTop: space.sm },
});
