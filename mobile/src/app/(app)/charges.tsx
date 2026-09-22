import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { StatementResponse } from '@flightsquare/shared';

import { Body, Card, Notice, SectionHeading } from '@/components/ui';
import { api, withAuth } from '@/lib/api';
import { formatBalance, formatMoney } from '@/lib/format';
import { color, space, type } from '@/theme';

/**
 * What this pilot owes their club — member billing (§3.7), never the
 * subscription. The two money systems share no wording anywhere, and on this
 * screen in particular: a pilot has no idea what the club pays FlightSquare
 * and no reason to.
 *
 * Their own statement and nothing else. The shared client does not expose the
 * `member` parameter the treasurer's web view uses, and if it did the policy
 * on the ledger would return an empty statement anyway — §10 decision 3 put
 * row scoping in RLS precisely so a client cannot get this wrong.
 *
 * Read-only, and it stops there. §8.3 keeps every purchase off this app;
 * settling up with a club is cash, a cheque or a transfer, and v1 records it
 * as an adjustment somebody makes on the web.
 */
export default function Charges() {
  const [statement, setStatement] = useState<StatementResponse | null>(null);
  const [offline, setOffline] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatement(await withAuth(() => api.statement()));
      setOffline(false);
    } catch {
      setOffline(true);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  // Newest first here, unlike the web statement, because a phone is opened to
  // answer "what did that flight cost me" rather than to reconcile a month.
  const lines = [...(statement?.lines ?? [])].reverse();

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
      {offline ? <Notice>Offline. Showing the balance loaded last.</Notice> : null}

      {statement ? (
        <Card>
          <Text style={styles.balanceLabel}>Balance</Text>
          <Text style={styles.balance}>
            {formatBalance(statement.balance_cents, statement.currency)}
          </Text>
          <Body muted>
            Charges less fuel credited, plus anything your club has recorded by
            hand. Settle up with them however you normally do.
          </Body>
        </Card>
      ) : null}

      {statement !== null && lines.length === 0 ? (
        <View style={styles.empty}>
          <SectionHeading>Nothing charged yet</SectionHeading>
          <Body muted>Charges appear here when a flight is logged against you.</Body>
        </View>
      ) : null}

      {lines.map((line) => (
        <Card key={line.id}>
          <View style={styles.row}>
            <Text style={styles.date}>{line.occurred_on}</Text>
            <Text style={styles.amount}>{formatMoney(line.amount_cents, line.currency)}</Text>
          </View>

          <Text style={styles.description}>
            {line.description}
            {line.reversed ? ' · reversed' : ''}
            {line.reverses_id ? ' · correction' : ''}
          </Text>

          {line.kind === 'charge' && line.rate_cents !== null ? (
            <Text style={styles.meta}>
              {/*
                §3.7 rule 1 wrote the hours, the rate and which rule supplied
                it onto the charge itself, so a line can explain itself
                without anybody going back to the rate tables.
              */}
              {line.meter_hours} {line.meter} hours at{' '}
              {formatMoney(line.rate_cents, line.currency)}
              {line.rate_source === 'member' ? ' (your rate)' : ' (club rate)'}
            </Text>
          ) : null}
        </Card>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: space.base, gap: space.md },
  empty: { gap: space.sm, paddingVertical: space.lg },
  balanceLabel: { ...type.supporting, color: color.secondary },
  balance: { ...type.metric, marginTop: space.xs, marginBottom: space.sm },
  row: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' },
  date: { ...type.supporting, color: color.secondary },
  amount: { ...type.cardHeading },
  description: { ...type.bodySmall, marginTop: space.xs },
  meta: { ...type.supporting, color: color.secondary, marginTop: space.xs },
});
