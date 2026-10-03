import DateTimePicker from '@react-native-community/datetimepicker';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import Svg, { Circle } from 'react-native-svg';
import { dayLabel, plainDate } from '@flightsquare/shared/time';
import type {
  ComplianceRecordResponse,
  MaintenanceItemHistoryResponse,
  MaintenanceItemResponse,
  MaintenanceNextFrom,
  MaintenanceRuleResponse,
  MaintenanceState,
  PreviewMaintenanceResponse,
} from '@flightsquare/shared';

import { Body, Button, Choice, Field, Input, Notice, SectionHeading } from '@/components/ui';
import { Sheet } from '@/components/sheet';
import { api, messageFor, withAuth } from '@/lib/api';
import { pickFile, type FileSource } from '@/lib/pick-file';
import { saveAttachment } from '@/lib/sync';
import { uuidv7 } from '@flightsquare/shared/uuidv7';
import { usePermission } from '@/lib/entitlements';
import { color, radius, space, statusColor, type } from '@/theme';

/**
 * One tracked item (mockup 04), and the sheet that completes it (mockup 05).
 *
 * The numbers on this screen are the server's. Every one of them — the
 * remaining, the projected date, what the next due point would be — arrives
 * resolved, and §8.2 is the reason: "the client never computes anything that
 * matters", and a maintenance countdown is the clearest case of mattering in
 * the product. The only arithmetic here is the geometry of a ring.
 *
 * The screen is behind `maintenance.items: read`, which a pilot does not hold.
 * Anybody who gets here from a notification without it sees the 403 as a
 * not-found, which is §1.6 working rather than a dead end to paper over.
 */

const todayIso = () => new Date().toISOString().slice(0, 10);

export default function MaintenanceItem() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const canWrite = usePermission('maintenance.items') === 'write';

  const [item, setItem] = useState<MaintenanceItemResponse | null>(null);
  const [completions, setCompletions] = useState<ComplianceRecordResponse[]>([]);
  const [history, setHistory] = useState<MaintenanceItemHistoryResponse[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [completing, setCompleting] = useState(false);
  const [voiding, setVoiding] = useState<ComplianceRecordResponse | null>(null);

  const load = useCallback(async () => {
    try {
      const fresh = await withAuth(() => api.maintenanceItem(id));
      setItem(fresh);
      setError(null);
      const [logged, changes] = await Promise.all([
        withAuth(() => api.maintenanceItemCompletions(id)).catch(() => []),
        withAuth(() => api.maintenanceItemHistory(id)).catch(() => []),
      ]);
      setCompletions(logged);
      setHistory(changes);
    } catch (problem) {
      setError(messageFor(problem));
    }
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  if (item === null) {
    return (
      <View style={styles.centre}>
        {error ? <Notice tone="error">{error}</Notice> : <Body muted>Loading…</Body>}
      </View>
    );
  }

  const tone = toneOf(item.state);
  const governing = item.rules.find((rule) => rule.id === item.governing_rule_id) ?? null;

  return (
    <ScrollView contentContainerStyle={styles.container}>
      {error ? <Notice tone="error">{error}</Notice> : null}

      <View style={styles.titleBlock}>
        <View style={styles.titleRow}>
          <Text style={styles.name}>{item.name}</Text>
          {canWrite ? (
            <Pressable
              onPress={() =>
                router.push({
                  pathname: '/(app)/add-maintenance-item',
                  params: { aircraft: item.aircraft_id, item: item.id },
                })
              }
              accessibilityRole="button"
              accessibilityLabel="Edit this item"
              style={({ pressed }) => [styles.edit, pressed && styles.pressed]}
            >
              <Text style={styles.editLabel}>Edit</Text>
            </Pressable>
          ) : null}
        </View>
        <Text style={styles.meta}>
          {CATEGORY[item.category]}
          {item.regulatory_reference ? ` · ${item.regulatory_reference}` : ''}
        </Text>
        {item.description ? <Body muted>{item.description}</Body> : null}
      </View>

      {/* The countdown ----------------------------------------------- */}
      <View style={styles.countdown}>
        <Ring state={item.state} remaining={item.governing_remaining} every={governing?.every ?? null} />
        <View style={styles.countdownText}>
          <View style={[styles.pill, { backgroundColor: tone.surface }]}>
            <Text style={[styles.pillLabel, { color: tone.ink }]}>{wordFor(item.state)}</Text>
          </View>
          {/* §3.6's distinction, and the one claim this screen must not make
              casually: nobody has recorded this being done is not overdue. */}
          {!item.ever_complied ? (
            <Body muted>No compliance recorded. Log one to start the countdown.</Body>
          ) : item.projected_date ? (
            <Text style={styles.projected}>
              About <Text style={styles.strong}>{untilLabel(item.projected_date)}</Text> at current
              pace
            </Text>
          ) : (
            // §4.3 is explicit: no forecast rather than a misleading one.
            <Body muted>Not enough recent flying to project a date.</Body>
          )}
          {item.current_hours ? (
            <Text style={styles.meta}>
              Now at {item.current_hours} {item.hours_meter}
            </Text>
          ) : null}
        </View>
      </View>

      {/* Every basis it is due on ------------------------------------ */}
      <SectionHeading>Due on</SectionHeading>
      <View style={styles.rows}>
        {item.rules.length === 0 ? (
          <View style={styles.row}>
            <Body muted>No interval set. This item is tracked but never comes due.</Body>
          </View>
        ) : (
          item.rules.map((rule) => (
            <View key={rule.id} style={styles.row}>
              <View style={styles.rowText}>
                <Text style={styles.rowTitle}>{ruleLabel(rule)}</Text>
                <Text style={styles.meta}>{duePointLabel(rule)}</Text>
              </View>
              {rule.id === item.governing_rule_id ? (
                // Which rule is deciding, said out loud. Three rules and one
                // number is how somebody concludes the app is wrong.
                <Text style={[styles.governs, { color: toneOf(rule.state).ink }]}>Governs</Text>
              ) : (
                <Text style={styles.rowValue}>{remainingLabel(rule.kind, rule.remaining)}</Text>
              )}
            </View>
          ))
        )}

        <Setting
          label="Ground if overdue"
          value={item.grounds_aircraft ? 'Yes' : 'No'}
          hint={
            item.grounds_aircraft
              ? 'Overdue blocks new bookings for this aircraft.'
              : item.restriction_label
                ? `Overdue shows: ${item.restriction_label}`
                : undefined
          }
        />
        <Setting label="Next interval starts from" value={NEXT_FROM[item.next_from]} />
        {item.tolerance_hours ? (
          <Setting
            label="Tolerance"
            value={`${item.tolerance_hours} hr`}
            hint="Counted as due, not overdue, within this much."
          />
        ) : null}
        {item.last_complied_on ? (
          <Setting label="Last done" value={dayLabel(item.last_complied_on)} />
        ) : null}
      </View>

      {canWrite ? (
        <Button
          label="Mark complete"
          onPress={() => setCompleting(true)}
          disabled={item.status !== 'active'}
        />
      ) : null}

      {/* What has been logged --------------------------------------- */}
      <SectionHeading>History</SectionHeading>
      {completions.length === 0 ? (
        <Body muted>Nothing logged against this item yet.</Body>
      ) : (
        <View style={styles.rows}>
          {completions.map((record) => (
            <View
              key={record.id}
              style={[styles.row, (record.voided ?? false) && styles.rowVoided]}
            >
              <View style={styles.rowText}>
                <Text style={styles.rowTitle}>
                  {dayLabel(record.complied_on)}
                  {record.complied_at_hours
                    ? ` · ${record.complied_at_hours} ${record.hours_meter ?? ''}`
                    : ''}
                </Text>
                {record.signed_by ? <Text style={styles.meta}>{record.signed_by}</Text> : null}
                {record.note ? <Text style={styles.meta}>{record.note}</Text> : null}
                {/* Labelled, never hidden (§3.6). A retracted completion is
                    part of the trail, and so is why it was retracted. */}
                {record.voided ? (
                  <Text style={styles.voided}>Voided — {record.void_reason}</Text>
                ) : record.superseded ? (
                  <Text style={styles.meta}>Corrected by a later record</Text>
                ) : null}

                {/*
                  Mockup 04's paperclip. The files come inline with the history,
                  so a list of ten does not make ten more requests on a tiedown.
                */}
                {(record.attachments ?? []).map((file) => (
                  <Pressable
                    key={file.id}
                    onPress={() => file.url && void Linking.openURL(file.url)}
                    disabled={!file.url}
                    accessibilityRole="button"
                    accessibilityLabel={`Open the ${LABEL[file.kind ?? 'document']}`}
                    style={({ pressed }) => [styles.fileRow, pressed && styles.pressed]}
                  >
                    <Feather
                      name={file.content_type === 'application/pdf' ? 'file-text' : 'paperclip'}
                      size={14}
                      color={color.tealText}
                    />
                    <Text style={styles.fileLabel}>{LABEL[file.kind ?? 'document']}</Text>
                  </Pressable>
                ))}
              </View>
              {canWrite && !record.voided && !record.superseded ? (
                <Pressable
                  onPress={() => setVoiding(record)}
                  accessibilityRole="button"
                  accessibilityLabel={`Void the completion of ${dayLabel(record.complied_on)}`}
                  style={({ pressed }) => [styles.void, pressed && styles.pressed]}
                >
                  <Text style={styles.voidLabel}>Void</Text>
                </Pressable>
              ) : null}
            </View>
          ))}
        </View>
      )}

      {/* The edit log, which is a different thing from the above ----- */}
      {history.length > 0 ? (
        <>
          <Pressable
            onPress={() => setShowHistory((on) => !on)}
            accessibilityRole="button"
            accessibilityState={{ expanded: showHistory }}
            style={({ pressed }) => [styles.disclose, pressed && styles.pressed]}
          >
            <Text style={styles.discloseLabel}>
              {showHistory ? 'Hide' : 'Show'} changes to this item ({history.length})
            </Text>
            <Feather
              name={showHistory ? 'chevron-up' : 'chevron-down'}
              size={18}
              color={color.navy}
            />
          </Pressable>
          {showHistory ? (
            <View style={styles.rows}>
              {history.map((entry) => (
                <View key={entry.id} style={styles.row}>
                  <View style={styles.rowText}>
                    <Text style={styles.rowTitle}>{ACTION[entry.action]}</Text>
                    <Text style={styles.meta}>
                      {new Date(entry.at).toLocaleString()}
                      {/* Null actor means the database did it, not a person —
                          a roll-forward after a completion (§7). */}
                      {entry.actor_email ? ` · ${entry.actor_email}` : ' · automatic'}
                    </Text>
                    {Object.entries(entry.changed).map(([field, move]) => (
                      <Text key={field} style={styles.meta}>
                        {field}: {String(move.from ?? '—')} → {String(move.to ?? '—')}
                      </Text>
                    ))}
                  </View>
                </View>
              ))}
            </View>
          ) : null}
        </>
      ) : null}

      <CompleteSheet
        visible={completing}
        item={item}
        onClose={() => setCompleting(false)}
        onDone={(fresh) => {
          setItem(fresh);
          setCompleting(false);
          void load();
        }}
      />

      <VoidSheet
        record={voiding}
        onClose={() => setVoiding(null)}
        onDone={(fresh) => {
          setItem(fresh);
          setVoiding(null);
          void load();
        }}
      />
    </ScrollView>
  );
}

/**
 * Mockup 05: date, meters, who did it, and what it resets to.
 *
 * The footer is a `preview` call rather than a local sum, and §13 asks for
 * exactly that — the preview has to match what saving produces. It does by
 * construction: this and the completion trigger call the same two database
 * functions.
 */
function CompleteSheet({
  visible,
  item,
  onClose,
  onDone,
}: {
  visible: boolean;
  item: MaintenanceItemResponse;
  onClose: () => void;
  onDone: (item: MaintenanceItemResponse) => void;
}) {
  const [doneOn, setDoneOn] = useState(todayIso());
  const [pickingDate, setPickingDate] = useState(false);
  const [tach, setTach] = useState('');
  const [hobbs, setHobbs] = useState('');
  const [performedBy, setPerformedBy] = useState('');
  const [certNo, setCertNo] = useState('');
  const [notes, setNotes] = useState('');
  const [nextFrom, setNextFrom] = useState<MaintenanceNextFrom>(item.next_from);
  const [preview, setPreview] = useState<PreviewMaintenanceResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Mockup 05's two tiles: what was picked, and which tile picked it. */
  const [files, setFiles] = useState<
    { key: string; uri: string; contentType: string; name?: string; fileKind: 'invoice' | 'logbook_entry' }[]
  >([]);
  const [picking, setPicking] = useState<'invoice' | 'logbook_entry' | null>(null);

  // Prefilled with the latest reading, and editable: work is logged days late
  // more often than not, and the meters then were not the meters now.
  useEffect(() => {
    if (!visible) return;
    setDoneOn(todayIso());
    setTach(item.hours_meter === 'tach' ? (item.current_hours ?? '') : '');
    setHobbs(item.hours_meter === 'hobbs' ? (item.current_hours ?? '') : '');
    setNextFrom(item.next_from);
    setFiles([]);
    setError(null);
  }, [visible, item]);

  // What it would reset to. Debounced, because it follows a text field.
  useEffect(() => {
    if (!visible || item.rules.length === 0) return;
    const hours = tach.trim() || hobbs.trim();
    const timer = setTimeout(() => {
      void withAuth(() =>
        api.previewMaintenance({
          aircraft_id: item.aircraft_id,
          rules: item.rules.map((rule) => ({
            kind: rule.kind,
            ...(rule.every ? { every: rule.every } : {}),
            end_of_month: rule.end_of_month,
          })),
          anchor_on: doneOn,
          ...(hours ? { anchor_hours: hours } : {}),
          ...(item.tolerance_hours ? { tolerance_hours: item.tolerance_hours } : {}),
        }),
      )
        .then(setPreview)
        .catch(() => setPreview(null));
    }, 350);
    return () => clearTimeout(timer);
  }, [visible, item, doneOn, tach, hobbs]);

  async function submit() {
    setBusy(true);
    setError(null);

    /*
      The completion names itself (§8.2), and the key makes a retry safe.

      Both exist for the paperwork. The invoices queue — a mark-complete is
      filled in beside an open cowling and a hangar at the far end of a field is
      worse for signal than a tiedown — and a queued upload has to be able to
      name the completion before the server has heard of it. The key is what
      stops the retry that follows a dropped connection from rolling an annual
      forward twice, in a table §3.6 will not let anybody correct by editing.

      The completion itself is sent rather than queued, because this sheet's
      footer is a live preview and the screen it returns to shows the new due
      date — both of which the server computes (§8.2). A fully offline
      mark-complete is its own piece of work.
    */
    const completionId = uuidv7();
    const recordedAt = new Date().toISOString();

    try {
      const result = await withAuth(() =>
        api.logCompletion(
          item.id,
          {
            id: completionId,
            done_on: doneOn,
            ...(tach.trim() ? { tach: tach.trim() } : {}),
            ...(hobbs.trim() ? { hobbs: hobbs.trim() } : {}),
            ...(performedBy.trim() ? { performed_by: performedBy.trim() } : {}),
            ...(certNo.trim() ? { cert_no: certNo.trim() } : {}),
            ...(notes.trim() ? { notes: notes.trim() } : {}),
            next_from: nextFrom,
          },
          completionId,
        ),
      );

      // Each file is its own queue entry, ordered just behind the completion it
      // belongs to, so the record exists by the time the upload names it.
      for (const file of files) {
        await saveAttachment({
          owner: { kind: 'completion', complianceRecordId: result.id },
          uri: file.uri,
          contentType: file.contentType,
          fileKind: file.fileKind,
          after: recordedAt,
        });
      }

      onDone(result.maintenance_item);
    } catch (problem) {
      setError(messageFor(problem));
    } finally {
      setBusy(false);
    }
  }

  async function attach(source: FileSource) {
    const kind = picking;
    setPicking(null);
    if (!kind) return;

    try {
      const picked = await pickFile(source);
      // Backed out, or declined the permission. Not a failure.
      if (!picked) return;

      setFiles((current) => [
        ...current,
        {
          key: `${picked.uri}-${current.length}`,
          uri: picked.uri,
          contentType: picked.contentType,
          ...(picked.name ? { name: picked.name } : {}),
          fileKind: kind,
        },
      ]);
    } catch (problem) {
      // A picker that fails silently is indistinguishable from a dead button,
      // which is exactly how the file chooser presented itself.
      setError(messageFor(problem));
    }
  }

  return (
    <Sheet visible={visible} title="Mark complete" onClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.form}>
          {error ? <Notice tone="error">{error}</Notice> : null}

          <Field label="Date done" compact required>
            <Pressable
              onPress={() => setPickingDate(true)}
              accessibilityRole="button"
              accessibilityLabel={`Done ${dayLabel(doneOn)}. Change the date`}
              style={({ pressed }) => [styles.dateControl, pressed && styles.pressed]}
            >
              <Feather name="calendar" size={16} color={color.secondary} />
              <Text style={styles.dateText}>
                {doneOn === todayIso() ? 'Today' : dayLabel(doneOn)}
              </Text>
            </Pressable>
          </Field>

          {pickingDate ? (
            <DateTimePicker
              value={new Date(`${doneOn}T12:00:00`)}
              mode="date"
              display={Platform.OS === 'ios' ? 'spinner' : 'default'}
              // Work is logged late, never early.
              maximumDate={new Date()}
              onValueChange={(_, picked) => {
                if (Platform.OS !== 'ios') setPickingDate(false);
                if (picked) setDoneOn(plainDate(picked));
              }}
              onDismiss={() => setPickingDate(false)}
            />
          ) : null}

          {/* Named explicitly, always. §11: Hobbs and tach are never left to
              be inferred, and an interval on the wrong one is a wrong number
              for the next year. */}
          <View style={styles.pair}>
            <View style={styles.half}>
              <Field label="Tach" compact>
                <Input
                  compact
                  value={tach}
                  onChangeText={setTach}
                  keyboardType="decimal-pad"
                  placeholder="0.0"
                />
              </Field>
            </View>
            <View style={styles.half}>
              <Field label="Hobbs" compact>
                <Input
                  compact
                  value={hobbs}
                  onChangeText={setHobbs}
                  keyboardType="decimal-pad"
                  placeholder="0.0"
                />
              </Field>
            </View>
          </View>

          <Field label="Performed by" compact>
            <Input compact value={performedBy} onChangeText={setPerformedBy} placeholder="Shop or mechanic" />
          </Field>
          <Field label="A&P / IA certificate no." compact>
            <Input compact value={certNo} onChangeText={setCertNo} autoCapitalize="characters" />
          </Field>
          <Field label="Logbook entry" compact hint="What was done, in the words the logbook uses.">
            <Input
              compact
              value={notes}
              onChangeText={setNotes}
              multiline
              style={styles.multiline}
            />
          </Field>

          {/*
            Mockup 05's two dashed tiles. Kinds, not sources — the chooser below
            asks where the file is, and photographing a paper invoice at the
            aeroplane is the common case.
          */}
          <Field label="Paperwork" compact hint="Optional. It stays with this completion.">
            <View style={styles.tiles}>
              {(['invoice', 'logbook_entry'] as const).map((kind) => (
                <Pressable
                  key={kind}
                  onPress={() => setPicking(kind)}
                  accessibilityRole="button"
                  accessibilityLabel={kind === 'invoice' ? 'Attach an invoice' : 'Attach a logbook entry'}
                  style={({ pressed }) => [styles.tile, pressed && styles.pressed]}
                >
                  <Feather
                    name={kind === 'invoice' ? 'file-text' : 'book-open'}
                    size={20}
                    color={color.secondary}
                  />
                  <Text style={styles.tileLabel}>
                    {kind === 'invoice' ? 'Attach invoice' : 'Logbook entry'}
                  </Text>
                </Pressable>
              ))}
            </View>
          </Field>

          {files.length > 0 ? (
            <View style={styles.rows}>
              {files.map((file) => (
                <View key={file.key} style={styles.row}>
                  <Feather
                    name={file.contentType === 'application/pdf' ? 'file-text' : 'image'}
                    size={16}
                    color={color.secondary}
                  />
                  <View style={styles.rowText}>
                    <Text style={styles.rowTitle} numberOfLines={1}>
                      {file.name ?? (file.fileKind === 'invoice' ? 'Invoice' : 'Logbook entry')}
                    </Text>
                    <Text style={styles.meta}>
                      {file.fileKind === 'invoice' ? 'Invoice' : 'Logbook entry'} · uploads after
                      saving
                    </Text>
                  </View>
                  <Pressable
                    onPress={() => setFiles((all) => all.filter((one) => one.key !== file.key))}
                    accessibilityRole="button"
                    accessibilityLabel="Remove this file"
                    style={({ pressed }) => [styles.void, pressed && styles.pressed]}
                  >
                    <Feather name="x" size={18} color={color.secondary} />
                  </Pressable>
                </View>
              ))}
            </View>
          ) : null}

          <Field
            label="Next interval starts from"
            compact
            hint="Previous due point keeps the schedule on its original dates."
          >
            <Choice
              value={nextFrom}
              onChange={setNextFrom}
              options={[
                { value: 'completion', label: 'This completion' },
                { value: 'previous_due', label: 'Previous due point' },
              ]}
            />
          </Field>

          {preview ? (
            <View style={styles.preview}>
              <Text style={styles.previewText}>
                Resets to <Text style={styles.strong}>{resetLabel(preview)}</Text>
                {preview.rules.length > 1 ? ', whichever first.' : '.'}
              </Text>
            </View>
          ) : null}

          <Button label="Save and reset counter" onPress={submit} busy={busy} />
          <Button label="Cancel" variant="secondary" onPress={onClose} />
        </View>
      </KeyboardAvoidingView>

      <Sheet
        visible={picking !== null}
        title={picking === 'logbook_entry' ? 'Logbook entry' : 'Invoice'}
        onClose={() => setPicking(null)}
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
            onPress={() => void attach(option.source)}
            accessibilityRole="button"
            style={({ pressed }) => [styles.option, pressed && styles.pressed]}
          >
            <Feather name={option.icon} size={20} color={color.navy} />
            <Text style={styles.optionLabel}>{option.label}</Text>
          </Pressable>
        ))}
      </Sheet>
    </Sheet>
  );
}

/** §4.7: a reason, not a delete. The reason is required and the API enforces it. */
function VoidSheet({
  record,
  onClose,
  onDone,
}: {
  record: ComplianceRecordResponse | null;
  onClose: () => void;
  onDone: (item: MaintenanceItemResponse) => void;
}) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (record) {
      setReason('');
      setError(null);
    }
  }, [record]);

  async function submit() {
    if (!record) return;
    if (reason.trim().length < 5) {
      setError('Say why in a few words. This stays on the record.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onDone(await withAuth(() => api.voidCompletion(record.id, { reason: reason.trim() })));
    } catch (problem) {
      setError(messageFor(problem));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet visible={record !== null} title="Void this completion" onClose={onClose}>
      <View style={styles.form}>
        {error ? <Notice tone="error">{error}</Notice> : null}
        <Body muted>
          The record stays and is marked voided, with your name and this reason. The item goes
          back to whatever was logged before it.
        </Body>
        <Field label="Why" compact required>
          <Input
            compact
            value={reason}
            onChangeText={setReason}
            multiline
            style={styles.multiline}
            placeholder="Logged against the wrong aircraft"
          />
        </Field>
        <Button label="Void completion" onPress={submit} busy={busy} />
        <Button label="Keep it" variant="secondary" onPress={onClose} />
      </View>
    </Sheet>
  );
}

/**
 * The ring from mockup 04.
 *
 * Pure decoration over a number the server sent, which is why computing the
 * fraction here is allowed: if the arithmetic is wrong the ring is a slightly
 * wrong length and the figure in the middle is still right.
 */
function Ring({
  state,
  remaining,
  every,
}: {
  state: MaintenanceState;
  remaining: string | null;
  every: string | null;
}) {
  const size = 104;
  const stroke = 9;
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;

  const left = remaining === null ? null : Number(remaining);
  const span = every === null ? null : Number(every);
  const fraction =
    left === null || span === null || span <= 0 ? 1 : Math.max(0, Math.min(1, left / span));
  const tone = toneOf(state);

  return (
    <View style={{ width: size, height: size }}>
      <Svg width={size} height={size} accessibilityElementsHidden importantForAccessibility="no">
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={color.subtle}
          strokeWidth={stroke}
          fill="none"
        />
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={tone.ink}
          strokeWidth={stroke}
          strokeLinecap="round"
          fill="none"
          strokeDasharray={`${circumference * fraction} ${circumference}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </Svg>
      <View style={styles.ringCentre}>
        <Text style={[styles.ringValue, { color: tone.ink }]}>
          {left === null ? '—' : Math.abs(left) % 1 === 0 ? left : left.toFixed(1)}
        </Text>
        <Text style={styles.ringUnit}>{left !== null && left < 0 ? 'over' : 'left'}</Text>
      </View>
    </View>
  );
}

function Setting({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <View style={styles.row}>
      <View style={styles.rowText}>
        <Text style={styles.settingLabel}>{label}</Text>
        {hint ? <Text style={styles.meta}>{hint}</Text> : null}
      </View>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

/** What a file is called where it is listed, which is all `kind` is for. */
const LABEL: Record<string, string> = {
  invoice: 'Invoice',
  logbook_entry: 'Logbook entry',
  document: 'Document',
  photo: 'Photo',
};

const CATEGORY: Record<MaintenanceItemResponse['category'], string> = {
  airframe: 'Airframe',
  engine: 'Engine',
  prop: 'Propeller',
  avionics: 'Avionics',
  other: 'Other',
};

const NEXT_FROM: Record<MaintenanceNextFrom, string> = {
  completion: 'Completion',
  previous_due: 'Previous due point',
};

const ACTION: Record<MaintenanceItemHistoryResponse['action'], string> = {
  created: 'Created',
  edited: 'Edited',
  archived: 'Archived',
  restored: 'Restored',
  rolled_forward: 'Rolled forward after a completion',
};

function ruleLabel(rule: MaintenanceRuleResponse): string {
  switch (rule.kind) {
    case 'cal_month':
      return `Calendar · every ${rule.every ?? '?'} months${rule.end_of_month ? ', to month end' : ''}`;
    case 'cal_day':
      return `Calendar · every ${rule.every ?? '?'} days`;
    case 'fixed_date':
      return 'Fixed date';
    case 'cycles':
      return `Cycles · every ${rule.every ?? '?'}`;
    case 'tach_hr':
      return `Tach · every ${Number(rule.every ?? 0).toFixed(1)} hr`;
    case 'hobbs_hr':
      return `Hobbs · every ${Number(rule.every ?? 0).toFixed(1)} hr`;
    default:
      return `Airframe · every ${Number(rule.every ?? 0).toFixed(1)} hr`;
  }
}

function duePointLabel(rule: MaintenanceRuleResponse): string {
  if (rule.due_at_hours) return `Due at ${rule.due_at_hours}`;
  if (rule.due_at_cycles !== null) return `Due at ${rule.due_at_cycles} cycles`;
  if (rule.due_on) return `Due ${dayLabel(rule.due_on)}`;
  return 'No due point yet';
}

function resetLabel(preview: PreviewMaintenanceResponse): string {
  const parts = preview.rules.map((rule) => {
    if (rule.due_at_hours) return `${rule.due_at_hours} ${rule.kind.replace('_hr', '')}`;
    if (rule.due_at_cycles !== null) return `${rule.due_at_cycles} cycles`;
    if (rule.due_on) return dayLabel(rule.due_on);
    return '—';
  });
  return parts.join(' or ');
}

function toneOf(state: MaintenanceState): { surface: string; ink: string } {
  switch (state) {
    case 'overdue':
      return statusColor.bad;
    case 'due_soon':
      return statusColor.urgent;
    case 'upcoming':
      return statusColor.warn;
    case 'inactive':
      return statusColor.unknown;
    default:
      return statusColor.good;
  }
}

function wordFor(state: MaintenanceState): string {
  switch (state) {
    case 'overdue':
      return 'Overdue';
    case 'due_soon':
      return 'Due soon';
    case 'upcoming':
      return 'Upcoming';
    case 'inactive':
      return 'Archived';
    default:
      return 'OK';
  }
}

/** §4.3's rounding, so nobody has to hold "428 days" in their head. */
function remainingLabel(kind: string, remaining: string | null): string {
  if (remaining === null) return '—';
  const value = Number(remaining);
  if (!Number.isFinite(value)) return '—';
  if (kind === 'cycles') return `${value} cycles`;
  if (kind.endsWith('_hr')) return `${value.toFixed(1)} hr`;

  const days = Math.round(value);
  if (days < 0) return `${Math.abs(days)} days over`;
  if (days < 14) return `${days} days`;
  if (days < 70) return `${Math.round(days / 7)} weeks`;
  return `${Math.round(days / 30)} months`;
}

function untilLabel(iso: string): string {
  const days = Math.round((new Date(`${iso}T12:00:00`).getTime() - Date.now()) / 86_400_000);
  if (days <= 0) return 'now';
  if (days < 14) return `${days} days`;
  if (days < 70) return `${Math.round(days / 7)} weeks`;
  return `${Math.round(days / 30)} months`;
}

const styles = StyleSheet.create({
  container: { padding: space.base, gap: space.md, paddingBottom: space.xxl },
  centre: { flex: 1, padding: space.base, justifyContent: 'center' },
  pressed: { opacity: 0.7 },
  strong: { fontFamily: type.label.fontFamily },
  meta: { ...type.supporting, color: color.secondary, fontFamily: type.body.fontFamily },

  titleBlock: { gap: space.xs },
  titleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm },
  name: { ...type.pageTitle, flex: 1 },
  edit: { minHeight: 44, justifyContent: 'center', paddingHorizontal: space.sm },
  editLabel: { ...type.button, color: color.tealText, textDecorationLine: 'underline' },

  countdown: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.base,
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.line,
    borderRadius: radius.card,
    padding: space.base,
  },
  countdownText: { flex: 1, gap: space.sm },
  projected: { ...type.bodySmall },
  ringCentre: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ringValue: { ...type.sectionHeading, fontVariant: ['tabular-nums'] },
  ringUnit: { ...type.supporting, color: color.secondary },

  pill: { alignSelf: 'flex-start', paddingHorizontal: space.md, paddingVertical: space.xs, borderRadius: 999 },
  pillLabel: { ...type.supporting, textTransform: 'uppercase' },

  rows: {
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.line,
    borderRadius: radius.card,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.base,
    paddingVertical: space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.line,
    minHeight: 56,
  },
  rowVoided: { backgroundColor: color.subtle },
  rowText: { flex: 1, gap: 2 },
  rowTitle: { ...type.bodySmall, fontFamily: type.label.fontFamily },
  rowValue: { ...type.bodySmall, color: color.secondary, fontVariant: ['tabular-nums'] },
  settingLabel: { ...type.bodySmall, color: color.secondary },
  governs: { ...type.supporting },
  voided: { ...type.supporting, color: statusColor.bad.ink },
  void: { minHeight: 44, justifyContent: 'center', paddingHorizontal: space.sm },
  fileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    minHeight: 32,
    alignSelf: 'flex-start',
  },
  fileLabel: { ...type.supporting, color: color.tealText, textDecorationLine: 'underline' },
  voidLabel: { ...type.button, color: statusColor.bad.ink, textDecorationLine: 'underline' },

  disclose: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 44,
  },
  discloseLabel: { ...type.button },

  form: { gap: space.md },
  tiles: { flexDirection: 'row', gap: space.md },
  tile: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
    minHeight: 72,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: color.control,
    borderRadius: radius.card,
    backgroundColor: color.surface,
  },
  tileLabel: { ...type.supporting },
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
  pair: { flexDirection: 'row', gap: space.md },
  half: { flex: 1 },
  multiline: { minHeight: 72, paddingTop: space.md, textAlignVertical: 'top' },
  dateControl: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: 44,
    paddingHorizontal: space.md,
    borderWidth: 1,
    borderColor: color.control,
    borderRadius: radius.control,
    backgroundColor: color.surface,
  },
  dateText: { ...type.input },
  preview: {
    backgroundColor: color.selected,
    borderRadius: radius.control,
    padding: space.md,
  },
  previewText: { ...type.bodySmall },
});
