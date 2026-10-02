'use client';

import { useRouter } from 'next/navigation';
import { useTransition, type ReactNode } from 'react';

import { markAllNotificationsRead, markNotificationRead } from '@/app/actions';
import { Button } from '@/components/ui';

/**
 * Opening a notice, which is also reading it.
 *
 * Not two gestures: the dot exists to say "there is something you have not
 * seen", and tapping through is seeing it. The read mark is fired without
 * waiting — it is a convenience, and the destination should not be held up by
 * it.
 */
export function OpenNotification({
  id,
  href,
  unread,
  children,
}: {
  id: string;
  href: string;
  unread: boolean;
  children: ReactNode;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  return (
    <a
      href={href}
      onClick={(event) => {
        event.preventDefault();
        if (unread) startTransition(() => void markNotificationRead(id));
        router.push(href);
      }}
      className="block rounded-lg hover:bg-subtle"
    >
      {children}
    </a>
  );
}

export function MarkAllRead() {
  const [pending, startTransition] = useTransition();

  return (
    <Button
      variant="secondary"
      disabled={pending}
      onClick={() => startTransition(() => void markAllNotificationsRead())}
    >
      {pending ? 'Marking…' : 'Mark all read'}
    </Button>
  );
}
