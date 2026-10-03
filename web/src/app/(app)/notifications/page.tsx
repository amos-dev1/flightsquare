import Link from 'next/link';
import { AlertTriangle, Bell, CalendarClock, Clock, FileText, Wrench } from 'lucide-react';

import { apiFetch } from '@/lib/api';
import { Card, Empty, PageTitle } from '@/components/ui';
import type { NotificationResponse } from '@flightsquare/shared';

import { MarkAllRead, OpenNotification } from './client';

/**
 * The feed (§3.8), which is what the bell has a dot for.
 *
 * Every notice points somewhere, because one a member cannot act on teaches
 * them to ignore the bell. The target arrives as a kind and an id rather than a
 * path — §8.1: a path written into a row outlives the build that could route
 * it — so the routing happens here.
 */
export default async function NotificationsPage() {
  const rows = await apiFetch<NotificationResponse[]>('/notifications');
  const unread = rows.filter((row) => row.read_at === null).length;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <PageTitle>Notifications</PageTitle>
          <p className="mt-1 text-sm text-secondary">
            {unread === 0 ? 'Nothing unread.' : `${unread} unread.`}
          </p>
        </div>
        {unread > 0 ? <MarkAllRead /> : null}
      </div>

      {rows.length === 0 ? (
        <Empty title="Nothing here">
          Maintenance coming due, an aircraft going down, and a booking that needs a second look all
          land here.
        </Empty>
      ) : (
        <Card className="divide-y divide-line">
          {rows.map((row) => {
            const Icon = ICON[row.kind];
            const href = destinationFor(row);

            const body = (
              <div className="flex items-start gap-4">
                <span
                  aria-hidden
                  className="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-mist"
                >
                  <Icon size={16} strokeWidth={2} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className={`text-sm ${row.read_at === null ? 'font-semibold' : ''}`}>
                    {row.title}
                  </p>
                  {row.body ? <p className="mt-0.5 text-sm text-secondary">{row.body}</p> : null}
                  <p className="mt-1 text-xs text-secondary">
                    <time dateTime={row.created_at}>
                      {new Date(row.created_at).toLocaleString()}
                    </time>
                    {/* The unread state is a word as well as a rule, because
                        §11 forbids meaning that lives only in a colour. */}
                    {row.read_at === null ? ' · unread' : null}
                  </p>
                </div>
              </div>
            );

            return (
              <div
                key={row.id}
                className={`px-5 py-4 ${
                  row.read_at === null ? 'border-l-2 border-l-teal bg-subtle' : ''
                }`}
              >
                {href ? (
                  <OpenNotification id={row.id} href={href} unread={row.read_at === null}>
                    {body}
                  </OpenNotification>
                ) : (
                  body
                )}
              </div>
            );
          })}
        </Card>
      )}

      <p className="text-sm text-secondary">
        <Link href="/maintenance" className="underline decoration-1 underline-offset-4">
          Maintenance
        </Link>{' '}
        has the full picture for every aircraft.
      </p>
    </div>
  );
}

/**
 * Where a notice goes.
 *
 * Nothing rather than a guess when this build does not know the kind: a new
 * `subject_type` is additive (§8.1), and showing the title while going nowhere
 * is better than routing to a screen the notice is not about.
 */
function destinationFor(row: NotificationResponse): string | null {
  if (row.subject_id === null) return null;
  switch (row.subject_type) {
    case 'maintenance_item':
      return `/maintenance/${row.subject_id}`;
    case 'aircraft':
      return `/aircraft/${row.subject_id}`;
    case 'squawk':
      return '/squawks';
    case 'aircraft_document':
      // The document's own page knows which aeroplane it belongs to, which a
      // notice from the bell does not carry.
      return `/aircraft-documents/${row.subject_id}`;
    case 'reservation':
      return '/schedule';
    default:
      return null;
  }
}

const ICON: Record<NotificationResponse['kind'], typeof Bell> = {
  maintenance_upcoming: CalendarClock,
  maintenance_due_soon: Clock,
  maintenance_overdue: AlertTriangle,
  aircraft_grounded: AlertTriangle,
  aircraft_returned: Bell,
  booking_needs_review: CalendarClock,
  squawk_filed: Wrench,
  /*
    A certificate coming up for renewal. The restrained icon is deliberate: a
    lapsed document is a thing to renew and never a grounding, and an alert
    triangle here is how somebody would read one into it (§11).
  */
  document_expiring: FileText,
};
