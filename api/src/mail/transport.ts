import { config } from '../config.js';

/**
 * How a message leaves the building.
 *
 * Same shape as the billing provider, for the same reason: one interface, a
 * real implementation and a local one, so the path exercised in development
 * is the path that runs in production apart from the last hop. Nothing
 * outside this file knows which is in use.
 */
export interface MailTransport {
  readonly name: string;
  /**
   * Deliver, or throw. Throwing is a retry (the worker records the error and
   * backs off); returning is final. Nothing here decides *whether* to send —
   * that was decided when the message was queued.
   */
  send(message: OutgoingMessage): Promise<void>;
}

export interface OutgoingMessage {
  to: string;
  subject: string;
  /** Plain text. §3.4's audience is a club treasurer, not a marketing list. */
  body: string;
  kind: string;
}

/**
 * A permanent failure — a malformed address, a rejected domain.
 *
 * Retrying it will fail identically forever, and a queue that retries the
 * undeliverable is a queue that eventually gets the sending domain blocked.
 * The worker marks these done and records why, rather than backing off.
 */
export class UndeliverableError extends Error {}

/**
 * The default, and what runs in development: log it and consider it sent.
 *
 * Not a no-op — the row is marked delivered, exactly as a real transport
 * would leave it, so the worker's own behaviour is under test rather than
 * being skipped. `scripts/outbox.sh` is where the body is actually read.
 */
export class LogTransport implements MailTransport {
  readonly name = 'log';

  constructor(private readonly log: (message: OutgoingMessage) => void) {}

  async send(message: OutgoingMessage): Promise<void> {
    this.log(message);
  }
}

/**
 * Resend's HTTP API — one POST, no dependency.
 *
 * Chosen because it is a single authenticated request against a documented
 * JSON endpoint, which is the whole of what this needs. SES is the likelier
 * production answer once `infra/` has something in it, and arrives as a
 * second class here rather than as a change to anything that calls this.
 */
export class ResendTransport implements MailTransport {
  readonly name = 'resend';

  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  async send(message: OutgoingMessage): Promise<void> {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: this.from,
        to: [message.to],
        subject: message.subject,
        text: message.body,
      }),
    });

    if (response.ok) return;

    const detail = await response.text().catch(() => '');
    // 4xx is us: a bad address, a domain that is not verified, a malformed
    // body. None of that improves by being sent again in four minutes.
    // 429 is the exception — that is explicitly "later", not "never".
    if (response.status >= 400 && response.status < 500 && response.status !== 429) {
      throw new UndeliverableError(`resend refused it (${response.status}): ${detail}`);
    }
    throw new Error(`resend failed (${response.status}): ${detail}`);
  }
}

let transport: MailTransport | null = null;

/**
 * The one transport this process uses, chosen once.
 *
 * A key means Resend; no key means the log. There is no third state, for the
 * reason the billing provider has none: a deployment that half-configures
 * mail finds out which half at the moment somebody needs a password reset.
 */
export function mailTransport(log: (message: OutgoingMessage) => void): MailTransport {
  transport ??= config.mail.apiKey
    ? new ResendTransport(config.mail.apiKey, config.mail.from)
    : new LogTransport(log);
  return transport;
}

/** Test seam. Nothing in the running worker calls this. */
export function setMailTransport(replacement: MailTransport | null): void {
  transport = replacement;
}
