import {
  SESv2Client,
  SendEmailCommand,
  AccountSuspendedException,
  MailFromDomainNotVerifiedException,
  MessageRejected,
  SendingPausedException,
} from '@aws-sdk/client-sesv2';

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

/**
 * Amazon SES, over the v2 HTTPS API.
 *
 * No credential of its own: the SDK signs with the task role, which is what
 * keeps a sending key out of the environment entirely. In the deployed VPC
 * there is no NAT and so no route to the internet — the call reaches SES
 * through an interface endpoint, whose private DNS covers
 * `email.<region>.amazonaws.com`, so the default endpoint resolves inside the
 * VPC and no override is needed here.
 */
export class SesTransport implements MailTransport {
  readonly name = 'ses';
  private readonly client: SESv2Client;

  constructor(
    private readonly from: string,
    region: string,
  ) {
    this.client = new SESv2Client({ region });
  }

  async send(message: OutgoingMessage): Promise<void> {
    try {
      await this.client.send(
        new SendEmailCommand({
          FromEmailAddress: this.from,
          Destination: { ToAddresses: [message.to] },
          Content: {
            Simple: {
              Subject: { Data: message.subject },
              Body: { Text: { Data: message.body } },
            },
          },
        }),
      );
    } catch (error) {
      // Final, in the sense the worker means: sending this again changes
      // nothing. A rejected message is a bad address or blocked content; an
      // unverified MAIL FROM domain and a suspended account are
      // configuration, and retrying either just burns the queue.
      if (
        error instanceof MessageRejected ||
        error instanceof MailFromDomainNotVerifiedException ||
        error instanceof AccountSuspendedException ||
        error instanceof SendingPausedException
      ) {
        throw new UndeliverableError(`ses refused it: ${(error as Error).message}`);
      }
      // Everything else — throttling, a 5xx, a broken connection — is "later".
      // Notably this includes sandbox rejections of unverified recipients,
      // which arrive as MessageRejected and are therefore final above: that is
      // correct, because nothing about waiting verifies an address.
      throw error;
    }
  }
}

/**
 * Wraps a transport and writes each message, body included, to stdout.
 *
 * This is the one thing the log transport has always refused to do, and the
 * refusal was right: the body carries a live sign-in code or a
 * password-reset link, and here the log is CloudWatch, which keeps it for a
 * month. It exists only because SES in sandbox delivers to verified addresses
 * only, so until production access lands this log is the sole inbox an
 * invited member has.
 *
 * It logs before delegating, deliberately — a message that fails to send is
 * exactly the one somebody needs to read.
 */
export class BodyLoggingTransport implements MailTransport {
  constructor(private readonly inner: MailTransport) {}

  get name(): string {
    return `${this.inner.name}+bodylog`;
  }

  async send(message: OutgoingMessage): Promise<void> {
    console.log(
      `[mail:body] ${message.kind} → ${message.to}\n` +
        `  subject: ${message.subject}\n` +
        message.body
          .split('\n')
          .map((line) => `  | ${line}`)
          .join('\n'),
    );
    await this.inner.send(message);
  }
}

let transport: MailTransport | null = null;

/**
 * The one transport this process uses, chosen once.
 *
 * There are three now, so the choice is named rather than inferred:
 * `FS_MAIL_PROVIDER` is `ses`, `resend` or `log`. The old inference — a key
 * means Resend, no key means the log — survives only for an unset variable,
 * which is what keeps local development free of configuration.
 *
 * Naming it matters for the reason the billing provider has one implementation
 * and one stub: a deployment that half-configures mail finds out which half at
 * the moment somebody needs a password reset. `resend` without a key now
 * refuses to start instead of quietly logging, because a worker that logs when
 * it was meant to send looks healthy in every way except the one that counts.
 */
export function mailTransport(log: (message: OutgoingMessage) => void): MailTransport {
  transport ??= wrap(choose(log));
  return transport;
}

function choose(log: (message: OutgoingMessage) => void): MailTransport {
  switch (config.mail.provider) {
    case 'ses':
      return new SesTransport(config.mail.from, config.mail.region);
    case 'resend':
      if (!config.mail.apiKey) {
        throw new Error('FS_MAIL_PROVIDER=resend needs FS_MAIL_API_KEY');
      }
      return new ResendTransport(config.mail.apiKey, config.mail.from);
    case 'log':
      return new LogTransport(log);
    case '':
      // Unset keeps the behaviour this function had before SES existed, which
      // is what makes `docker compose up` need no environment: a key means
      // Resend, no key means the log.
      return config.mail.apiKey
        ? new ResendTransport(config.mail.apiKey, config.mail.from)
        : new LogTransport(log);
    default:
      throw new Error(`FS_MAIL_PROVIDER=${config.mail.provider} is not a transport`);
  }
}

function wrap(inner: MailTransport): MailTransport {
  return config.mail.logBodies ? new BodyLoggingTransport(inner) : inner;
}

/** Test seam. Nothing in the running worker calls this. */
export function setMailTransport(replacement: MailTransport | null): void {
  transport = replacement;
}
