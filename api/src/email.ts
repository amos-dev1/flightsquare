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

// ---------------------------------------------------------------------------
// M8's event notices.
//
// Each one answers "what happened, to what, and what do I do now" in that
// order, because these arrive on a phone and are read in the first line. No
// footer, no branding block, no unsubscribe: none of this is marketing, and
// V1_SCOPE keeps per-user notification preferences out of v1, so an
// unsubscribe link would be a lie.
// ---------------------------------------------------------------------------

export function bookingConfirmedEmail(input: {
  registration: string;
  starts: string;
  ends: string;
  bookedForSomeoneElse: boolean;
  bookedBy: string | null;
}): RenderedEmail {
  return {
    subject: `${input.registration} booked — ${input.starts}`,
    body: [
      input.bookedForSomeoneElse
        ? `${input.bookedBy ?? 'Somebody'} booked ${input.registration} for you.`
        : `${input.registration} is booked for you.`,
      '',
      `From  ${input.starts}`,
      `Until ${input.ends}`,
      '',
      link('/schedule'),
    ].join('\n'),
  };
}

export function bookingCancelledEmail(input: {
  registration: string;
  starts: string;
  cancelledBy: string | null;
  self: boolean;
}): RenderedEmail {
  return {
    subject: `${input.registration} cancelled — ${input.starts}`,
    body: [
      input.self
        ? `Your booking of ${input.registration} on ${input.starts} is cancelled.`
        : `${input.cancelledBy ?? 'Somebody'} cancelled your booking of ` +
          `${input.registration} on ${input.starts}.`,
      '',
      'The aircraft is free again for that slot.',
      '',
      link('/schedule'),
    ].join('\n'),
  };
}

export function squawkFiledEmail(input: {
  registration: string;
  summary: string;
  reportedBy: string | null;
  grounding: boolean;
}): RenderedEmail {
  return {
    subject: input.grounding
      ? `${input.registration} grounded — ${input.summary}`
      : `Squawk on ${input.registration} — ${input.summary}`,
    body: [
      `${input.reportedBy ?? 'A member'} reported a defect on ${input.registration}:`,
      '',
      input.summary,
      '',
      // §11: never infer airworthiness, and never soften a grounding. The
      // aircraft is out of service until somebody clears it, and the email
      // says so in the same words the screen does.
      input.grounding
        ? 'It is marked as grounding, so the aircraft takes no new bookings ' +
          'and existing ones are flagged for review until it is resolved.'
        : 'It is not marked as grounding, so bookings are unaffected.',
      '',
      link('/squawks'),
    ].join('\n'),
  };
}

export function overQuotaEmail(input: {
  tenantName: string;
  planCode: string;
  over: { noun: string; used: number; limit: number }[];
}): RenderedEmail {
  return {
    subject: `${input.tenantName} is over its plan limit`,
    body: [
      `${input.tenantName} is on the ${input.planCode} plan and is over on:`,
      '',
      ...input.over.map((row) => `  ${row.noun}: ${row.used} of ${row.limit}`),
      '',
      // §5.2, in the words the policy uses: nothing is destroyed, nothing is
      // switched off, and the only thing refused is creating more.
      'Nothing has been deleted and nothing has stopped working. What you',
      'cannot do is add another until you move one out of the way or change',
      'plan — and there is no deadline on deciding which.',
      '',
      link('/settings/subscription'),
    ].join('\n'),
  };
}
