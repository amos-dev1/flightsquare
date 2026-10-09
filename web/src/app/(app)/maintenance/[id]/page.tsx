import Link from 'next/link';
import { notFound } from 'next/navigation';
import { FileText, Paperclip } from 'lucide-react';

import { ApiError, apiFetch } from '@/lib/api';
import { Card, KeyMetric, PageTitle, SectionHeading, Status } from '@/components/ui';
import type {
  ComplianceRecordResponse,
  EntitlementsResponse,
  MaintenanceItemHistoryResponse,
  MaintenanceItemResponse,
} from '@flightsquare/shared';

import { duePointLabel, kindFor, remainingIn, ruleLabel } from '../shared';
import { ArchiveItemButton, CompletionForm, VoidButton } from './client';

/**
 * One tracked item (mockup 04).
 *
 * Everything on it is the server's resolution: the remaining, which rule is
 * governing, what the projection says. §8.2 is the reason — "the client never
 * computes anything that matters" — and a maintenance countdown is the clearest
 * case of mattering in the product.
 *
 * Behind `maintenance.items: read`, which a pilot does not hold. The 403 that
 * follows becomes a not-found here, which is §1.6 working rather than a dead end
 * worth papering over: §6 asks for "not found", never "not yours".
 */
export default async function MaintenanceItemPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let item: MaintenanceItemResponse;
  let entitlements: EntitlementsResponse;
  try {
    [item, entitlements] = await Promise.all([
      apiFetch<MaintenanceItemResponse>(`/maintenance-items/${id}`),
      apiFetch<EntitlementsResponse>('/entitlements'),
    ]);
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 403)) notFound();
    throw error;
  }

  const canWrite = entitlements.permissions['maintenance.items'] === 'write';

  // Neither is load-bearing for the page, and either can be refused without
  // the countdown above becoming wrong.
  const [completions, history] = await Promise.all([
    apiFetch<ComplianceRecordResponse[]>(`/maintenance-items/${id}/completions`).catch(() => []),
    apiFetch<MaintenanceItemHistoryResponse[]>(`/maintenance-items/${id}/history`).catch(() => []),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/maintenance"
          className="inline-flex min-h-11 items-center text-sm font-semibold underline decoration-1 underline-offset-4"
        >
          Maintenance
        </Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div>
            <PageTitle>{item.name}</PageTitle>
            <p className="mt-1 text-sm text-secondary">
              {CATEGORY[item.category]}
              {item.regulatory_reference ? ` · ${item.regulatory_reference}` : ''}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Status kind={kindFor(item.state)} />
            {canWrite ? (
              <Link
                href={`/maintenance/${item.id}/edit`}
                className="inline-flex h-11 items-center rounded-lg border border-control px-4 text-sm font-semibold hover:bg-subtle"
              >
                Edit
              </Link>
            ) : null}
          </div>
        </div>
        {item.description ? <p className="mt-2 text-sm">{item.description}</p> : null}
      </div>

      {/* The countdown ------------------------------------------------ */}
      <div className="grid gap-4 sm:grid-cols-3">
        <Card className="px-5 py-4">
          <KeyMetric
            label="Remaining"
            value={
              item.ever_complied
                ? remainingIn(item.governing_kind, item.governing_remaining)
                : null
            }
          />
        </Card>
        <Card className="px-5 py-4">
          <KeyMetric label={`Now at (${item.hours_meter})`} value={item.current_hours} />
        </Card>
        <Card className="px-5 py-4">
          {/* §4.3: a projection or nothing, never a misleading forecast. */}
          <KeyMetric label="At this pace" value={item.projected_date} />
        </Card>
      </div>

      {!item.ever_complied ? (
        /*
          §3.6's distinction, and the claim this page must not make casually:
          nobody having recorded this is not the same as the aeroplane being
          overdue for it.
        */
        <Card className="px-5 py-4 text-sm">
          No compliance recorded. Log one below and the countdown starts from it.
        </Card>
      ) : null}

      {/* Every basis it is due on ------------------------------------ */}
      <section className="space-y-3">
        <SectionHeading>Due on</SectionHeading>
        {item.rules.length === 0 ? (
          <Card className="px-5 py-4 text-sm text-secondary">
            No interval set. This item is tracked but never comes due.
          </Card>
        ) : (
          <Card className="divide-y divide-line">
            {item.rules.map((rule) => (
              <div
                key={rule.id}
                className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-5 py-4"
              >
                <div>
                  <p className="text-sm font-semibold">{capitalise(ruleLabel(rule))}</p>
                  <p className="tabular mt-0.5 text-sm text-secondary">{duePointLabel(rule)}</p>
                </div>
                <span className="flex items-center gap-3">
                  <span className="tabular text-sm text-secondary">
                    {remainingIn(rule.kind, rule.remaining)}
                  </span>
                  {/* Which rule is deciding, said out loud: three rules and one
                      number is how somebody concludes the app is wrong. */}
                  {rule.id === item.governing_rule_id ? (
                    <span className="rounded-lg bg-mist px-2 py-1 text-xs font-semibold">
                      Governs
                    </span>
                  ) : null}
                </span>
              </div>
            ))}
          </Card>
        )}

        <Card className="divide-y divide-line">
          <Setting
            label="Ground if overdue"
            value={item.grounds_aircraft ? 'Yes' : 'No'}
            hint={
              item.grounds_aircraft
                ? 'Blocks new bookings. Existing ones are flagged for review, never cancelled.'
                : (item.restriction_label ?? undefined)
            }
          />
          <Setting label="Next interval starts from" value={NEXT_FROM[item.next_from]} />
          {item.tolerance_hours ? (
            <Setting
              label="Tolerance"
              value={`${item.tolerance_hours} hr`}
              hint="Counted as due rather than overdue within this much."
            />
          ) : null}
          {item.last_complied_on ? (
            <Setting label="Last done" value={item.last_complied_on} />
          ) : null}
        </Card>
      </section>

      {canWrite ? <CompletionForm item={item} /> : null}

      {/* What has been logged against it ---------------------------- */}
      <section className="space-y-3">
        <SectionHeading>Completions</SectionHeading>
        {completions.length === 0 ? (
          <Card className="px-5 py-4 text-sm text-secondary">Nothing logged yet.</Card>
        ) : (
          <Card className="divide-y divide-line">
            {completions.map((record) => (
              <div
                key={record.id}
                className={`flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-5 py-4 ${
                  record.voided ? 'bg-subtle' : ''
                }`}
              >
                <div>
                  <p className="text-sm font-semibold">
                    <time className="tabular" dateTime={record.complied_on}>
                      {record.complied_on}
                    </time>
                    {record.complied_at_hours ? (
                      <span className="tabular font-normal text-secondary">
                        {' · '}
                        {record.complied_at_hours} {record.hours_meter}
                      </span>
                    ) : null}
                  </p>
                  {record.signed_by ? (
                    <p className="mt-0.5 text-sm text-secondary">
                      {record.signed_by}
                      {record.signed_certificate ? ` · ${record.signed_certificate}` : ''}
                    </p>
                  ) : null}
                  {record.note ? <p className="mt-0.5 text-sm">{record.note}</p> : null}
                  {/*
                    Labelled, never hidden (§3.6). A retracted completion is part
                    of the trail and so is the reason — this is the table that
                    gets read back after an accident.
                  */}
                  {record.voided ? (
                    <p className="mt-1 text-sm font-semibold">Voided — {record.void_reason}</p>
                  ) : record.superseded ? (
                    <p className="mt-1 text-sm text-secondary">Corrected by a later record</p>
                  ) : null}

                  {/*
                    Mockup 04's paperclip. The files arrive inline with the
                    history, so a list of ten does not make ten more requests —
                    and a PDF opens rather than rendering, because an `<img>`
                    cannot show one.
                  */}
                  {(record.attachments ?? []).length > 0 ? (
                    <ul className="mt-2 flex flex-wrap gap-3">
                      {(record.attachments ?? []).map((file) => (
                        <li key={file.id}>
                          <a
                            href={file.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-2 text-sm font-semibold underline decoration-1 underline-offset-4"
                          >
                            {file.content_type === 'application/pdf' ? (
                              <FileText aria-hidden size={16} strokeWidth={2} />
                            ) : (
                              <Paperclip aria-hidden size={16} strokeWidth={2} />
                            )}
                            {FILE_LABEL[file.kind ?? 'document']}
                          </a>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
                {canWrite && !record.voided && !record.superseded ? (
                  <VoidButton itemId={item.id} recordId={record.id} on={record.complied_on} />
                ) : null}
              </div>
            ))}
          </Card>
        )}
      </section>

      {/* The edit log, which is a different thing from the above ---- */}
      {history.length > 0 ? (
        <section className="space-y-3">
          <SectionHeading>Changes</SectionHeading>
          <Card className="divide-y divide-line">
            {history.map((entry) => (
              <div key={entry.id} className="px-5 py-4">
                <p className="text-sm font-semibold">{ACTION[entry.action]}</p>
                <p className="mt-0.5 text-sm text-secondary">
                  <time dateTime={entry.at}>{new Date(entry.at).toLocaleString()}</time>
                  {/* No actor means the database did it, not a person — a
                      roll-forward after a completion (§7). */}
                  {entry.actor_email ? ` · ${entry.actor_email}` : ' · automatic'}
                </p>
                {Object.entries(entry.changed).map(([field, move]) => (
                  <p key={field} className="tabular mt-0.5 text-xs text-secondary">
                    {field}: {String(move.from ?? '—')} → {String(move.to ?? '—')}
                  </p>
                ))}
              </div>
            ))}
          </Card>
        </section>
      ) : null}

      {canWrite ? <ArchiveItemButton itemId={item.id} status={item.status} /> : null}
    </div>
  );
}

function Setting({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-5 py-4">
      <div>
        <p className="text-sm text-secondary">{label}</p>
        {hint ? <p className="mt-0.5 text-sm">{hint}</p> : null}
      </div>
      <p className="tabular text-sm font-semibold">{value}</p>
    </div>
  );
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** What a file is called where it is listed, which is all `kind` is for. */
const FILE_LABEL: Record<string, string> = {
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

const NEXT_FROM: Record<MaintenanceItemResponse['next_from'], string> = {
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
