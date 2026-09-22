import { config } from '../config.js';
import { assertMailRole, drainOnce, mailDatabase } from './worker.js';
import { mailTransport, type OutgoingMessage } from './transport.js';

/**
 * The mail sender: `npm run mail -w api`.
 *
 * Its own process, on purpose. It connects as a different role to a table the
 * API cannot read, and if it were a timer inside the API it would have to
 * hold those credentials in the same process as every request handler — which
 * is the whole of what the outbox split was avoiding.
 *
 * It is also the piece most likely to be scaled or restarted independently:
 * a mail provider having a bad hour should not mean redeploying the API, and
 * two of these can run side by side because the claim is a write (see
 * `drainOnce`).
 */

const log = (message: OutgoingMessage): void => {
  // The body is not logged. It holds the link, and a log line with a live
  // password-reset URL in it defeats the reason app_role cannot read this
  // table in the first place. `scripts/outbox.sh` is where a person reads it.
  console.log(
    `[mail] ${message.kind} → ${message.to}: ${JSON.stringify(message.subject)}`,
  );
};

const db = mailDatabase();
const transport = mailTransport(log);

let running = true;
let inFlight: Promise<unknown> = Promise.resolve();

try {
  await assertMailRole(db);
} catch (error) {
  console.error('[mail] refusing to start:', (error as Error).message);
  await db.destroy();
  process.exit(1);
}

console.log(
  `[mail] draining every ${config.mail.pollSeconds}s via the ${transport.name} transport` +
    (transport.name === 'log'
      ? ' — nothing actually leaves this machine; set FS_MAIL_API_KEY to change that'
      : ''),
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    running = false;
    void (async () => {
      // Let the pass in progress finish. Killing it mid-batch would leave
      // messages claimed-but-unsent, which is survivable — they come back
      // after their backoff — but waiting a moment is free.
      await inFlight;
      await db.destroy();
      process.exit(0);
    })();
  });
}

while (running) {
  inFlight = (async () => {
    try {
      const result = await drainOnce(db, transport);
      if (result.claimed > 0) {
        console.log(
          `[mail] ${result.sent} sent, ${result.failed} failed of ${result.claimed}`,
        );
      }
      // A full batch means there is probably more waiting, so go again
      // rather than sleeping on a backlog.
      return result.claimed >= config.mail.batchSize;
    } catch (error) {
      // The database went away, most likely. Log it and keep the loop alive:
      // a worker that exits on a blip is a queue that stops until somebody
      // notices, and nothing here is holding state worth restarting for.
      console.error('[mail] pass failed:', (error as Error).message);
      return false;
    }
  })();

  const more = await inFlight;
  if (!more && running) {
    await new Promise((resolve) => setTimeout(resolve, config.mail.pollSeconds * 1000));
  }
}
