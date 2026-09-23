import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import {
  ApiError,
  type AircraftAvailabilityResponse,
  type AircraftResponse,
  type MaintenanceItemResponse,
  type ReservationResponse,
  type SquawkResponse,
} from '@flightsquare/shared';

import {
  AircraftThumbnail,
  StatusIndicator,
  maintenanceDetail,
  maintenanceIsOverdue,
  reservationDetail,
  statusesFor,
} from '@/components/aircraft';
import { Body, Button, Card, Notice, SectionHeading } from '@/components/ui';
import { api, withAuth } from '@/lib/api';
import { useMoreThanOnePilot } from '@/lib/entitlements';
import { color, space, type } from '@/theme';

/**
 * One aeroplane.
 *
 * The fleet list used to carry "Log flight" and "Report a defect" on every
 * card, which put four primary actions on a screen of four aircraft (§11 §6
 * asks for one) and left nowhere to put anything else about an aeroplane.
 * They live here now, along with the readings and what is wrong with it.
 *
 * Dispatch state is the server's (§3.3). Nothing on this screen decides
 * whether the aeroplane flies, and nothing reads airworthiness out of the
 * absence of a warning — the grounding reasons are printed as the server
 * gives them, because the booking path is refusing for exactly those.
 */
export default function AircraftDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const shared = useMoreThanOnePilot();

  const [aircraft, setAircraft] = useState<AircraftResponse | null>(null);
  const [dispatch, setDispatch] = useState<AircraftAvailabilityResponse | undefined>(undefined);
  const [items, setItems] = useState<MaintenanceItemResponse[]>([]);
  const [squawks, setSquawks] = useState<SquawkResponse[]>([]);
  const [flying, setFlying] = useState<ReservationResponse[]>([]);
  const [missing, setMissing] = useState(false);
  const [offline, setOffline] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const now = new Date().toISOString();
      const [found, availability, maintenance, defects, inProgress] = await Promise.all([
        withAuth(() => api.getAircraft(id)),
        withAuth(() => api.availability()).catch(() => []),
        withAuth(() => api.listMaintenanceItems({ aircraftId: id })).catch(() => []),
        withAuth(() => api.listSquawks({ aircraftId: id, open: true })).catch(() => []),
        withAuth(() => api.listReservations({ aircraftId: id, from: now, to: now })).catch(
          () => [],
        ),
      ]);

      setAircraft(found);
      setDispatch(availability.find((row) => row.aircraft_id === id));
      setItems(maintenance);
      setSquawks(defects);
      setFlying(inProgress);
      setMissing(false);
      setOffline(false);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 404) setMissing(true);
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
      <View style={styles.empty}>
        <SectionHeading>Aircraft not found</SectionHeading>
        <Body muted>It may belong to another account, or have been archived.</Body>
      </View>
    );
  }

  const overdue = items.filter((item) => item.state === 'overdue' && item.ever_complied);
  const unrecorded = items.filter((item) => item.state === 'overdue' && !item.ever_complied);
  const soon = items.filter((item) => item.state === 'due_soon');

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
      {offline && !aircraft ? (
        <Notice>Offline. This aircraft could not be loaded.</Notice>
      ) : null}
      {offline && aircraft ? <Notice>Offline. Showing the last known readings.</Notice> : null}

      {aircraft ? (
        <>
          <View style={styles.header}>
            <AircraftThumbnail />
            <View style={styles.identity}>
              <Text style={styles.registration}>{aircraft.registration}</Text>
              <Text style={styles.model}>
                {aircraft.type_code ?? 'Type not recorded'}
                {aircraft.year_manufactured ? ` · ${aircraft.year_manufactured}` : ''}
              </Text>
              <View style={styles.badges}>
                {statusesFor({
                  available: dispatch?.available,
                  reservedNow: flying.length > 0,
                  dueSoon: soon.length > 0 || overdue.length > 0,
                }).map((badge) => (
                  <StatusIndicator
                    key={badge}
                    status={badge}
                    label={
                      badge === 'due_soon' && maintenanceIsOverdue(items, aircraft.id)
                        ? 'Overdue'
                        : undefined
                    }
                    // The same two facts the fleet card carries, from the
                    // same helpers, so the two screens cannot word them
                    // differently.
                    detail={
                      badge === 'reserved'
                        ? reservationDetail(flying[0])
                        : badge === 'due_soon'
                          ? maintenanceDetail(items, aircraft.id)
                          : null
                    }
                  />
                ))}
              </View>
            </View>
          </View>

          {/* §3.3: the reasons the booking path is refusing, in its words. */}
          {dispatch && !dispatch.available ? (
            <Notice tone="error">{dispatch.grounding_reasons.join('\n')}</Notice>
          ) : null}

          <Card>
            <SectionHeading>Readings</SectionHeading>
            <Body muted>Recorded as read. Neither meter is worked out from the other.</Body>
            <Line label="Hobbs" value={hours(aircraft.hobbs)} />
            <Line label="Tach" value={hours(aircraft.tach)} />
            <Line label="Airframe" value={hours(aircraft.airframe_hours)} />
            <Line
              label="Location · last arrival"
              value={aircraft.last_location}
              at={aircraft.last_location_at}
            />
            <Line
              label="Fuel · last reported"
              value={fuel(aircraft)}
              at={aircraft.fuel_remaining_at}
            />
            {aircraft.totals_updated_at ? (
              <Text style={styles.stamp}>Meters updated · {stamp(aircraft.totals_updated_at)}</Text>
            ) : null}
          </Card>

          <Card>
            <SectionHeading>Maintenance</SectionHeading>
            {/* "Not recorded" is kept apart from "overdue" the way every
                other screen keeps them apart: an interval seeded with the
                aeroplane that nobody confirmed is unknown, not overdue. */}
            <Line label="Overdue" value={count(overdue.length)} />
            <Line label="Due soon" value={count(soon.length)} />
            <Line label="Never recorded" value={count(unrecorded.length)} />
            <Line label="Open squawks" value={count(squawks.length)} />
            <View style={styles.action}>
              <Button
                label="Open maintenance"
                variant="secondary"
                onPress={() => router.push('/maintenance')}
              />
            </View>
          </Card>

          <Card>
            <SectionHeading>Setup</SectionHeading>
            <Line label="Home base" value={aircraft.home_base} />
            <Line label="Serial number" value={aircraft.serial_number} />
            <Line label="Seats" value={aircraft.seats === null ? null : String(aircraft.seats)} />
            {/* §3.4: which meter drives what is configuration, not a rule —
                and it is frequently not the meter maintenance runs on. */}
            <Line label="Maintenance runs on" value={aircraft.maintenance_meter} />
            <Line label="Billed on" value={aircraft.billing_meter} />
            <Line
              label="Rate basis"
              value={aircraft.rate_basis === 'wet' ? 'Wet — fuel included' : 'Dry — fuel is yours'}
            />
          </Card>

          {/* The two things somebody standing at the aeroplane does. */}
          <Button
            label="Log flight"
            onPress={() =>
              router.push({ pathname: '/log-flight', params: { aircraft: aircraft.id } })
            }
          />
          <Button
            label="Report a defect"
            variant="secondary"
            onPress={() =>
              router.push({ pathname: '/report-squawk', params: { aircraft: aircraft.id } })
            }
          />
          {/* §4.3: nobody to book around means no booking (unused, never
              switched off — the screen behind this still works). */}
          {shared ? (
            <Button
              label="Book it"
              variant="secondary"
              onPress={() =>
                router.push({ pathname: '/schedule', params: { aircraft: aircraft.id } })
              }
            />
          ) : null}
        </>
      ) : null}
    </ScrollView>
  );
}

function Line({
  label,
  value,
  at,
}: {
  label: string;
  value: string | null;
  at?: string | null;
}) {
  return (
    <View style={styles.line}>
      <Text style={styles.lineLabel}>{label}</Text>
      <View style={styles.lineRight}>
        <Text style={value ? styles.lineValue : styles.lineAbsent}>
          {value ?? 'Not recorded'}
        </Text>
        {/* Each reading carries its own time, because the meters, the fuel
            and the location come from three different moments. */}
        {at && value ? <Text style={styles.lineStamp}>{stamp(at)}</Text> : null}
      </View>
    </View>
  );
}

function count(n: number): string {
  return n === 0 ? 'None' : String(n);
}

function hours(value: string | null): string | null {
  if (value === null) return null;
  return `${Number(value).toLocaleString(undefined, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })} h`;
}

function fuel(aircraft: AircraftResponse): string | null {
  if (aircraft.fuel_remaining === null) return null;
  const unit = aircraft.fuel_units === 'litres' ? 'L' : 'US gal';
  return `${Number(aircraft.fuel_remaining).toLocaleString(undefined, {
    maximumFractionDigits: 1,
  })} ${unit}`;
}

function stamp(instant: string): string {
  return new Date(instant).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

const styles = StyleSheet.create({
  container: { padding: space.base, paddingBottom: space.xxl, gap: space.md },
  empty: { padding: space.base, gap: space.sm },

  header: { flexDirection: 'row', gap: space.md, alignItems: 'flex-start' },
  identity: { flex: 1, gap: space.xs },
  registration: { ...type.pageTitle, textTransform: 'uppercase' },
  model: { ...type.body, color: color.secondary },
  badges: { gap: space.sm, marginTop: space.sm },

  line: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: space.md,
    marginTop: space.md,
  },
  lineLabel: { ...type.supporting, color: color.secondary, flex: 1 },
  lineRight: { flexShrink: 1, alignItems: 'flex-end' },
  lineValue: { ...type.bodySmall, textAlign: 'right', fontVariant: ['tabular-nums'] },
  lineAbsent: { ...type.bodySmall, color: color.secondary, textAlign: 'right' },
  lineStamp: { ...type.supporting, fontSize: 11, color: color.secondary },
  stamp: { ...type.supporting, color: color.secondary, marginTop: space.md },

  action: { marginTop: space.base },
});
