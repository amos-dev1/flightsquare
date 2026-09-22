import { Kysely, PostgresDialect, sql, type ColumnType } from 'kysely';
import pg from 'pg';

import { config } from '../config.js';
import {
  UndeliverableError,
  type MailTransport,
  type OutgoingMessage,
} from './transport.js';

/**
 * The worker's own view of the database, which is one table.
 *
 * `api/src/db/schema.ts` types `outbox` the way *app_role* sees it: insert
 * only, with every delivery column `never` on the write side, because the
 * application must not be able to mark a message sent or read one back. The
 * worker is the other half of that split and needs the opposite, so it has
 * its own type rather than loosening the shared one — the grants say the same
 * thing in the database, and the types agreeing with them is worth having.
 */
interface MailDatabase {
  outbox: {
    id: ColumnType<string, never, never>;
    to_email: ColumnType<string, never, never>;
    subject: ColumnType<string, never, never>;
    body: ColumnType<string, never, never>;
    kind: ColumnType<string, never, never>;
    created_at: ColumnType<Date, never, never>;
    sent_at: ColumnType<Date | null, never, Date | null>;
    attempts: ColumnType<number, never, number>;
    last_error: ColumnType<string | null, never, string | null>;
    last_attempt_at: ColumnType<Date | null, never, Date | null>;
  };
}

/**
 * The worker's own connection, as `mail_role`.
 *
 * Not the API's pool, and not app_role. 0009 built the outbox so the
 * application could queue a password-reset link and never read one back, and
 * that only holds if the thing that *does* read them is a different role
 * with different credentials. This pool can see one table.
 */
export function mailDatabase(): Kysely<MailDatabase> {
  return new Kysely<MailDatabase>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({
        host: config.db.host,
        port: config.db.port,
        database: config.db.database,
        user: config.mail.user,
        password: config.mail.password,
        max: 2,
      }),
    }),
  });
}

/**
 * Refuse to start as anything but the mail role.
 *
 * Same reasoning as `assertApplicationRole`: the realistic way this goes
 * wrong is a copied connection string, and a worker running as the owner
 * would quietly hold DDL on every table in the database in order to send
 * some email.
 */
export async function assertMailRole(db: Kysely<MailDatabase>): Promise<void> {
  const { rows } = await sql<{
    current_user: string;
    rolsuper: boolean;
    rolbypassrls: boolean;
  }>`
    SELECT current_user, r.rolsuper, r.rolbypassrls
      FROM pg_roles r WHERE r.rolname = current_user
  `.execute(db);

  const row = rows[0];
  if (!row) throw new Error('could not determine the current database role');
  if (row.rolsuper || row.rolbypassrls) {
    throw new Error(
      `the mail worker connected as ${row.current_user}, which can bypass ` +
        'row-level security (§1.2).',
    );
  }
  if (row.current_user !== 'mail_role') {
    throw new Error(
      `the mail worker connected as ${row.current_user}, expected mail_role.`,
    );
  }
}

export interface DrainResult {
  claimed: number;
  sent: number;
  failed: number;
}

/**
 * One pass over the queue.
 *
 * The claim is a *write*, not a lock held open. Holding `FOR UPDATE` across
 * an HTTP call to a mail provider would pin a connection for as long as that
 * provider felt like taking, and a provider having a slow day would exhaust
 * the pool — so the batch is marked attempted in one statement and the lock
 * is gone before anything is sent. A second worker's next claim does not see
 * those rows, because their backoff has just been reset.
 *
 * The cost is that a crash between sending and recording retries one message
 * once its backoff expires. A duplicate booking confirmation is a much
 * smaller problem than a queue that wedges, and the alternative — record
 * first, then send — loses messages instead, which is worse.
 */
export async function drainOnce(
  db: Kysely<MailDatabase>,
  transport: MailTransport,
): Promise<DrainResult> {
  const due = await claim(db);
  const result: DrainResult = { claimed: due.length, sent: 0, failed: 0 };

  for (const message of due) {
    const outgoing: OutgoingMessage = {
      to: message.to_email,
      subject: message.subject,
      body: message.body,
      kind: message.kind,
    };

    try {
      await transport.send(outgoing);
      await markSent(db, message.id);
      result.sent += 1;
    } catch (error) {
      const permanent = error instanceof UndeliverableError;
      await markFailed(db, message.id, describe(error), permanent);
      result.failed += 1;
    }
  }

  return result;
}

interface Claimed {
  id: string;
  to_email: string;
  subject: string;
  body: string;
  kind: string;
}

/**
 * What is due now: never sent, not exhausted, and past its backoff.
 *
 * The backoff is computed in SQL from `attempts` and `last_attempt_at` rather
 * than held in the worker, so restarting it does not retry the whole queue at
 * once — which is the failure mode of every in-memory schedule.
 *
 * Doubling from a minute, capped at an hour: eight attempts reach roughly a
 * day, which is long enough for a provider outage to end and short enough
 * that a password reset is not still trying on Thursday.
 */
async function claim(db: Kysely<MailDatabase>): Promise<Claimed[]> {
  const { rows } = await sql<Claimed>`
    UPDATE public.outbox
       SET attempts = attempts + 1, last_attempt_at = now()
     WHERE id IN (
       SELECT id FROM public.outbox
        WHERE sent_at IS NULL
          AND attempts < ${config.mail.maxAttempts}
          AND (
            last_attempt_at IS NULL
            OR last_attempt_at < now() - least(
                 interval '1 minute' * power(2, attempts),
                 interval '1 hour'
               )
          )
        ORDER BY created_at
        LIMIT ${config.mail.batchSize}
        FOR UPDATE SKIP LOCKED
     )
    RETURNING id, to_email, subject, body, kind
  `.execute(db);

  return rows;
}

async function markSent(db: Kysely<MailDatabase>, id: string): Promise<void> {
  // `attempts` was already incremented by the claim, so a message that took
  // three tries says three rather than resetting to look like it went first
  // time — which is the number worth having when somebody asks why an
  // invitation was slow.
  await db
    .updateTable('outbox')
    .set({ sent_at: new Date(), last_error: null })
    .where('id', '=', id)
    .execute();
}

/**
 * A failure, recorded where the next pass will read it.
 *
 * A permanent one is retired by exhausting its attempts rather than by a
 * separate column: there is one question the claim asks ("is this still
 * worth trying?") and one place to answer it.
 */
async function markFailed(
  db: Kysely<MailDatabase>,
  id: string,
  reason: string,
  permanent: boolean,
): Promise<void> {
  await db
    .updateTable('outbox')
    .set({
      last_error: reason.slice(0, 1000),
      // Retiring a permanent failure by exhausting its attempts keeps one
      // question in the claim — "is this still worth trying?" — with one
      // place to answer it, rather than a second column that means the same.
      ...(permanent ? { attempts: config.mail.maxAttempts } : {}),
    })
    .where('id', '=', id)
    .execute();
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
