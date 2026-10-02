import DateTimePicker from '@react-native-community/datetimepicker';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { dayLabel, plainDate } from '@flightsquare/shared/time';
import type {
  MaintenanceCategory,
  MaintenanceRuleInput,
  MaintenanceRuleKind,
  MaintenanceState,
  PreviewMaintenanceResponse,
} from '@flightsquare/shared';

import { Body, Button, Choice, Field, Input, Notice, SectionHeading } from '@/components/ui';
import { Sheet } from '@/components/sheet';
import { api, messageFor, withAuth } from '@/lib/api';
import { color, radius, space, statusColor, type } from '@/theme';

/**
 * Adding or editing a tracked item (mockup 03).
 *
 * The screen's whole job is the footer. Somebody typing "every 50 tach hours"
 * has a question — when does that land — and §13 requires the answer shown here
 * to be the answer saving produces. It is the same two database functions either
 * way (`/maintenance-items/preview`), so there is no second implementation to
 * drift: §8.2's "the client never computes anything that matters", applied to
 * the one screen most tempted to.
 *
 * Nothing is instantiated behind anybody's back. The decision recorded in the
 * plan was **empty by default** — an aeroplane arriving with fifteen red items
 * nobody approved is the app asserting obligations it cannot know apply — so
 * this form is how an item comes to exist.
 */

const PRESETS = ['Oil change', 'Annual', '100-hour', 'ELT battery', 'Transponder'];

const CATEGORIES: { value: MaintenanceCategory; label: string }[] = [
  { value: 'airframe', label: 'Airframe' },
  { value: 'engine', label: 'Engine' },
  { value: 'prop', label: 'Prop' },
  { value: 'avionics', label: 'Avionics' },
  { value: 'other', label: 'Other' },
];

const KINDS: { value: MaintenanceRuleKind; label: string; unit: string }[] = [
  { value: 'tach_hr', label: 'Tach hours', unit: 'hr' },
  { value: 'hobbs_hr', label: 'Hobbs hours', unit: 'hr' },
  { value: 'airframe_hr', label: 'Airframe hours', unit: 'hr' },
  { value: 'cal_month', label: 'Calendar months', unit: 'months' },
  { value: 'cal_day', label: 'Calendar days', unit: 'days' },
  { value: 'cycles', label: 'Cycles', unit: 'cycles' },
  { value: 'fixed_date', label: 'One fixed date', unit: '' },
];

/** A rule as this form holds it: strings, because that is what was typed. */
interface Draft {
  key: string;
  kind: MaintenanceRuleKind;
  every: string;
  endOfMonth: boolean;
  fixedDate: string;
  anchorOn: string;
  anchorHours: string;
}

const todayIso = () => new Date().toISOString().slice(0, 10);

function blankRule(kind: MaintenanceRuleKind): Draft {
  return {
    key: `${kind}-${Date.now()}`,
    kind,
    every: '',
    // §4.2: a 12-month annual signed 12 March is due 31 March. On by default
    // for months, because that is how an annual actually works and the pilot
    // who has to undo it is rarer than the one who would never find it.
    endOfMonth: kind === 'cal_month',
    fixedDate: todayIso(),
    anchorOn: todayIso(),
    anchorHours: '',
  };
}

export default function AddMaintenanceItem() {
  const { aircraft: aircraftId, item: itemId } = useLocalSearchParams<{
    aircraft: string;
    item?: string;
  }>();
  const editing = typeof itemId === 'string' && itemId.length > 0;

  const [name, setName] = useState('');
  const [category, setCategory] = useState<MaintenanceCategory>('airframe');
  const [reference, setReference] = useState('');
  const [rules, setRules] = useState<Draft[]>([blankRule('tach_hr')]);
  const [grounds, setGrounds] = useState(false);
  const [restriction, setRestriction] = useState('');
  const [tolerance, setTolerance] = useState('');
  const [addingRule, setAddingRule] = useState(false);
  const [pickingDate, setPickingDate] = useState<string | null>(null);

  const [preview, setPreview] = useState<PreviewMaintenanceResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Editing loads what is there. The rules come back resolved, and only the
  // parts a form can own — kind, interval, month-end — are editable here; the
  // due points are the server's and are recomputed from these.
  useEffect(() => {
    if (!editing) return;
    void withAuth(() => api.maintenanceItem(itemId))
      .then((found) => {
        setName(found.name);
        setCategory(found.category);
        setReference(found.regulatory_reference ?? '');
        setGrounds(found.grounds_aircraft);
        setRestriction(found.restriction_label ?? '');
        setTolerance(found.tolerance_hours ?? '');
        setRules(
          found.rules.length === 0
            ? [blankRule('tach_hr')]
            : found.rules.map((rule) => ({
                key: rule.id,
                kind: rule.kind,
                every: rule.every ?? '',
                endOfMonth: rule.end_of_month,
                fixedDate: rule.due_on ?? todayIso(),
                anchorOn: found.last_complied_on ?? todayIso(),
                anchorHours: found.last_complied_on ? '' : '',
              })),
        );
      })
      .catch((problem: unknown) => setError(messageFor(problem)));
  }, [editing, itemId]);

  const asInput = useCallback(
    (): MaintenanceRuleInput[] =>
      rules
        .filter((rule) => rule.kind === 'fixed_date' || rule.every.trim() !== '')
        .map((rule) => ({
          kind: rule.kind,
          ...(rule.kind === 'fixed_date' ? {} : { every: rule.every.trim() }),
          end_of_month: rule.endOfMonth,
          ...(rule.kind === 'fixed_date' ? { fixed_date: rule.fixedDate } : {}),
          anchor_on: rule.anchorOn,
          ...(rule.anchorHours.trim() ? { anchor_hours: rule.anchorHours.trim() } : {}),
        })),
    [rules],
  );

  // The footer. Debounced, because it follows the keyboard.
  useEffect(() => {
    const input = asInput();
    if (input.length === 0) {
      setPreview(null);
      return;
    }
    const timer = setTimeout(() => {
      void withAuth(() =>
        api.previewMaintenance({
          aircraft_id: aircraftId,
          rules: input,
          ...(tolerance.trim() ? { tolerance_hours: tolerance.trim() } : {}),
        }),
      )
        .then(setPreview)
        // A failed preview is a blank footer, never a blocked form: the
        // server will say the same thing on save, in words.
        .catch(() => setPreview(null));
    }, 400);
    return () => clearTimeout(timer);
  }, [asInput, aircraftId, tolerance]);

  function update(key: string, change: Partial<Draft>) {
    setRules((all) => all.map((rule) => (rule.key === key ? { ...rule, ...change } : rule)));
  }

  async function submit() {
    if (!name.trim()) {
      setError('Give it a name.');
      return;
    }
    const input = asInput();
    if (input.length === 0) {
      setError('Set at least one interval, or this item never comes due.');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const body = {
        name: name.trim(),
        ...(reference.trim() ? { regulatory_reference: reference.trim() } : {}),
        grounds_aircraft: grounds,
        ...(restriction.trim() ? { restriction_label: restriction.trim() } : {}),
        ...(tolerance.trim() ? { tolerance_hours: tolerance.trim() } : {}),
        category,
        rules: input,
      };
      if (editing) {
        await withAuth(() => api.updateMaintenanceItem(itemId, body));
      } else {
        await withAuth(() => api.createMaintenanceItem(aircraftId, body));
      }
      router.back();
    } catch (problem) {
      // The server's own words where it has them — a quota in particular,
      // which this app states and never offers to fix (§8.3).
      setError(messageFor(problem));
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
        {error ? <Notice tone="error">{error}</Notice> : null}

        <Field label="Name" compact required>
          <Input compact value={name} onChangeText={setName} placeholder="Oil and filter change" />
        </Field>
        <View style={styles.presets}>
          {PRESETS.map((preset) => (
            <Pressable
              key={preset}
              onPress={() => setName(preset)}
              accessibilityRole="button"
              accessibilityLabel={`Name it ${preset}`}
              style={({ pressed }) => [styles.preset, pressed && styles.pressed]}
            >
              <Text style={styles.presetLabel}>{preset}</Text>
            </Pressable>
          ))}
        </View>

        <Field label="Applies to" compact>
          <Choice value={category} onChange={setCategory} options={CATEGORIES} />
        </Field>

        <Field
          label="Regulatory reference"
          compact
          hint="14 CFR 91.409, AD 2024-12-05, a service bulletin number."
        >
          <Input compact value={reference} onChangeText={setReference} />
        </Field>

        {/* Intervals -------------------------------------------------- */}
        <View style={styles.sectionHead}>
          <SectionHeading>Interval</SectionHeading>
          <Text style={styles.meta}>Whichever comes first</Text>
        </View>

        {rules.map((rule) => {
          const kind = KINDS.find((one) => one.value === rule.kind);
          return (
            <View key={rule.key} style={styles.ruleCard}>
              <View style={styles.ruleHead}>
                <Text style={styles.ruleTitle}>{kind?.label ?? rule.kind}</Text>
                {rules.length > 1 ? (
                  <Pressable
                    onPress={() => setRules((all) => all.filter((one) => one.key !== rule.key))}
                    accessibilityRole="button"
                    accessibilityLabel={`Remove the ${kind?.label ?? rule.kind} rule`}
                    style={({ pressed }) => [styles.remove, pressed && styles.pressed]}
                  >
                    <Feather name="x" size={18} color={color.secondary} />
                  </Pressable>
                ) : null}
              </View>

              {rule.kind === 'fixed_date' ? (
                <Field label="Due on" compact>
                  <Pressable
                    onPress={() => setPickingDate(`${rule.key}:fixed`)}
                    accessibilityRole="button"
                    accessibilityLabel={`Due ${dayLabel(rule.fixedDate)}. Change the date`}
                    style={({ pressed }) => [styles.dateControl, pressed && styles.pressed]}
                  >
                    <Feather name="calendar" size={16} color={color.secondary} />
                    <Text style={styles.dateText}>{dayLabel(rule.fixedDate)}</Text>
                  </Pressable>
                </Field>
              ) : (
                <View style={styles.pair}>
                  <View style={styles.half}>
                    <Field label={`Every (${kind?.unit ?? ''})`} compact required>
                      <Input
                        compact
                        value={rule.every}
                        onChangeText={(value) => update(rule.key, { every: value })}
                        keyboardType="decimal-pad"
                        placeholder={rule.kind.endsWith('_hr') ? '50.0' : '12'}
                      />
                    </Field>
                  </View>
                  <View style={styles.half}>
                    {rule.kind.endsWith('_hr') || rule.kind === 'cycles' ? (
                      <Field label="Last done at" compact>
                        <Input
                          compact
                          value={rule.anchorHours}
                          onChangeText={(value) => update(rule.key, { anchorHours: value })}
                          keyboardType="decimal-pad"
                          placeholder="1225.0"
                        />
                      </Field>
                    ) : (
                      <Field label="Last done" compact>
                        <Pressable
                          onPress={() => setPickingDate(`${rule.key}:anchor`)}
                          accessibilityRole="button"
                          accessibilityLabel={`Last done ${dayLabel(rule.anchorOn)}. Change the date`}
                          style={({ pressed }) => [styles.dateControl, pressed && styles.pressed]}
                        >
                          <Feather name="calendar" size={16} color={color.secondary} />
                          <Text style={styles.dateText}>{dayLabel(rule.anchorOn)}</Text>
                        </Pressable>
                      </Field>
                    )}
                  </View>
                </View>
              )}

              {rule.kind === 'cal_month' ? (
                <View style={styles.switchRow}>
                  <View style={styles.switchText}>
                    <Text style={styles.switchLabel}>Due at month end</Text>
                    {/* §4.2's rule, in the words it actually means. */}
                    <Text style={styles.meta}>
                      An annual signed 12 March is due 31 March the following year.
                    </Text>
                  </View>
                  <Switch
                    value={rule.endOfMonth}
                    onValueChange={(value) => update(rule.key, { endOfMonth: value })}
                    trackColor={{ true: color.teal, false: color.line }}
                  />
                </View>
              ) : null}
            </View>
          );
        })}

        {rules.length < 3 ? (
          <Button
            label="Add another basis"
            variant="secondary"
            onPress={() => setAddingRule(true)}
          />
        ) : (
          <Body muted>Three bases is the limit. The earliest of them wins.</Body>
        )}

        {/* Consequences ---------------------------------------------- */}
        <SectionHeading>When it comes due</SectionHeading>

        <View style={styles.switchRow}>
          <View style={styles.switchText}>
            <Text style={styles.switchLabel}>Ground the aircraft if overdue</Text>
            <Text style={styles.meta}>Blocks new bookings once overdue. Existing ones are flagged, never cancelled.</Text>
          </View>
          <Switch
            value={grounds}
            onValueChange={setGrounds}
            trackColor={{ true: color.teal, false: color.line }}
          />
        </View>

        {!grounds ? (
          <Field
            label="Restriction when overdue"
            compact
            hint="Shown to pilots instead of grounding. "
          >
            <Input compact value={restriction} onChangeText={setRestriction} placeholder="VFR only" />
          </Field>
        ) : null}

        <Field
          label="Tolerance (hours)"
          compact
          hint="Counted as due rather than overdue within this much."
        >
          <Input
            compact
            value={tolerance}
            onChangeText={setTolerance}
            keyboardType="decimal-pad"
            placeholder="0.0"
          />
        </Field>

        {/* The answer to the question the form is asking --------------- */}
        {preview ? (
          <View style={[styles.preview, { borderColor: toneOf(preview.state).ink }]}>
            <Text style={styles.previewLabel}>Next due</Text>
            <Text style={styles.previewValue}>{resetLabel(preview)}</Text>
            <Text style={[styles.previewState, { color: toneOf(preview.state).ink }]}>
              {wordFor(preview.state)}
            </Text>
          </View>
        ) : null}

        <Button label={editing ? 'Save changes' : 'Add item'} onPress={submit} busy={busy} />

        {pickingDate ? (
          <DateTimePicker
            value={new Date(
              `${
                pickingDate.endsWith(':fixed')
                  ? (rules.find((r) => pickingDate.startsWith(r.key))?.fixedDate ?? todayIso())
                  : (rules.find((r) => pickingDate.startsWith(r.key))?.anchorOn ?? todayIso())
              }T12:00:00`,
            )}
            mode="date"
            display={Platform.OS === 'ios' ? 'spinner' : 'default'}
            onValueChange={(_, picked) => {
              if (Platform.OS !== 'ios') setPickingDate(null);
              if (!picked) return;
              const [key, which] = pickingDate.split(':');
              if (!key) return;
              // The wall-clock date, never the picker's instant (§6: a naive
              // local date is the thing being chosen here).
              update(key, which === 'fixed' ? { fixedDate: plainDate(picked) } : { anchorOn: plainDate(picked) });
            }}
            onDismiss={() => setPickingDate(null)}
          />
        ) : null}

        <Sheet visible={addingRule} title="Add a basis" onClose={() => setAddingRule(false)}>
          {KINDS.filter((kind) => !rules.some((rule) => rule.kind === kind.value)).map((kind) => (
            <Pressable
              key={kind.value}
              onPress={() => {
                setRules((all) => [...all, blankRule(kind.value)]);
                setAddingRule(false);
              }}
              accessibilityRole="button"
              style={({ pressed }) => [styles.option, pressed && styles.pressed]}
            >
              <Text style={styles.optionLabel}>{kind.label}</Text>
              <Feather name="plus" size={18} color={color.navy} />
            </Pressable>
          ))}
        </Sheet>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function resetLabel(preview: PreviewMaintenanceResponse): string {
  return preview.rules
    .map((rule) => {
      if (rule.due_at_hours) return `${rule.due_at_hours} ${rule.kind.replace('_hr', '')}`;
      if (rule.due_at_cycles !== null) return `${rule.due_at_cycles} cycles`;
      if (rule.due_on) return dayLabel(rule.due_on);
      return '—';
    })
    .join(' or ');
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
      return 'Already overdue';
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

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { padding: space.base, gap: space.md, paddingBottom: space.xxl },
  pressed: { opacity: 0.7 },
  meta: { ...type.supporting, color: color.secondary, fontFamily: type.body.fontFamily },

  presets: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  preset: {
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: color.line,
    backgroundColor: color.surface,
    minHeight: 36,
    justifyContent: 'center',
  },
  presetLabel: { ...type.supporting },

  sectionHead: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: space.sm,
  },

  ruleCard: {
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.line,
    borderRadius: radius.card,
    padding: space.base,
    gap: space.md,
  },
  ruleHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  ruleTitle: { ...type.cardHeading },
  remove: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },

  pair: { flexDirection: 'row', gap: space.md },
  half: { flex: 1 },

  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.line,
    borderRadius: radius.card,
    padding: space.base,
  },
  switchText: { flex: 1, gap: 2 },
  switchLabel: { ...type.label },

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
    backgroundColor: color.surface,
    borderWidth: 1,
    borderLeftWidth: 3,
    borderRadius: radius.card,
    padding: space.base,
    gap: space.xs,
  },
  previewLabel: { ...type.supporting, color: color.secondary, textTransform: 'uppercase' },
  previewValue: { ...type.sectionHeading, fontVariant: ['tabular-nums'] },
  previewState: { ...type.label },

  option: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: space.base,
    borderWidth: 1,
    borderColor: color.line,
    borderRadius: radius.card,
    minHeight: 56,
  },
  optionLabel: { ...type.bodySmall },
});
