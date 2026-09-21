import { config } from './config.js';

/**
 * The three emails M1 needs, and nothing that sends them.
 *
 * v1 has no sender (M8). What exists is a queue: every message is rendered
 * here and written to `outbox`, which a worker will drain later. Until then
 * `scripts/outbox.sh` prints what would have gone out — links included —
 * which is enough to walk verification, invitation and reset end to end.
 *
 * Rendering lives in the API and the enqueue lives in the database, and for
 * the two token emails that split is deliberate: `auth.request_email_token`
 * decides whether the message happens, so whether an address is registered
 * never reaches the caller. This module hands it a finished subject and body
 * and is told nothing back.
 *
 * Plain text on purpose. HTML mail needs a rendering pipeline, an inliner and
 * a testing story, and a club being told their annual is due does not need
 * any of that. It arrives with HTML when there is a reason.
 */

export type OutboxKind =
  | 'email_verification'
  | 'password_reset'
  | 'invite'
  | 'booking_confirmed'
  | 'booking_cancelled'
  | 'squawk_filed'
  | 'maintenance_due'
  | 'over_quota';

export interface RenderedEmail {
  subject: string;
  body: string;
}

/** Where a link in an email points. Not the API — the person clicks a page. */
function link(path: string): string {
  return `${config.web.baseUrl.replace(/\/$/, '')}${path}`;
}

export function verificationEmail(token: string): RenderedEmail {
  return {
    subject: 'Confirm your FlightSquare email',
    body: [
      'Confirm this address to finish setting up your FlightSquare account:',
      '',
      link(`/verify-email?token=${encodeURIComponent(token)}`),
      '',
      'The link is good for 24 hours and can be used once.',
      "If you didn't create an account, you can ignore this.",
    ].join('\n'),
  };
}

export function passwordResetEmail(token: string): RenderedEmail {
  return {
    subject: 'Reset your FlightSquare password',
    body: [
      'Somebody asked to reset the password on this address:',
      '',
      link(`/reset-password?token=${encodeURIComponent(token)}`),
      '',
      'The link is good for one hour and can be used once.',
      // No "if this wasn't you, your account may be at risk" — it alarms
      // people over what is usually their own mistyped password, and there
      // is nothing for them to do about it either way.
      "If you didn't ask for this, nothing has changed and you can ignore it.",
    ].join('\n'),
  };
}

export function inviteEmail(input: {
  token: string;
  tenantName: string;
  invitedBy: string | null;
}): RenderedEmail {
  const from = input.invitedBy ? `${input.invitedBy} has` : 'You have been';
  return {
    subject: `Join ${input.tenantName} on FlightSquare`,
    body: [
      `${from} invited you to ${input.tenantName} on FlightSquare.`,
      '',
      link(`/accept-invite?token=${encodeURIComponent(input.token)}`),
      '',
      'The link is good for 7 days and can be used once.',
      'If you already have a FlightSquare account, sign in and it joins that one.',
    ].join('\n'),
  };
}
