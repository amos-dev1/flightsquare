-- ===========================================================================
-- 0016_outbox_drain.sql — M8: the queue gets a sender, and the owner steps back
--
-- 0009 left the instruction in a comment against `outbox_drain`:
--
--   "The owner holds that for now because the sender does not exist yet (M8).
--    When it does it gets a role of its own with exactly this policy and no
--    DDL, and this one goes away: a mail sender has no business owning
--    tables."
--
-- This is that. `mail_role` reads and drains the queue; the owner's blanket
-- policy is replaced by a read the development script needs and nothing more.
--
-- The shape of the split is the point. The bodies in this table hold live
-- verification and password-reset links, so:
--
--   app_role   INSERT only, still. The API can queue a reset link and cannot
--              read one back, which is why the queue was built this way.
--   mail_role  SELECT, and UPDATE on the three delivery columns. It cannot
--              write a message, only record what happened to one.
--   owner      SELECT, for scripts/outbox.sh. No writes.
--   admin_role nothing. §7.2's content tier, and more: a support engineer
--              reading this table reads password resets in flight.
--
-- Run as flightsquare_owner.
-- ===========================================================================

DO $guard$
BEGIN
  IF current_user <> 'flightsquare_owner' THEN
    RAISE EXCEPTION 'migrations run as flightsquare_owner, not %', current_user;
  END IF;

  -- Roles are created at initdb, and initdb only runs on an empty data
  -- directory — so a database that predates M8 has no mail_role and every
  -- statement below would fail on a name that does not exist. Say which
  -- script fixes it rather than leaving a bare "role does not exist".
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mail_role') THEN
    RAISE EXCEPTION 'mail_role does not exist — run scripts/roles.sh first';
  END IF;
END
$guard$;

-- ---------------------------------------------------------------------------
-- When it was last tried
--
-- `attempts` and `last_error` were there from the start; what was missing is
-- the one column a backoff needs. Without it a worker either retries a failing
-- message on every pass — which is how a queue turns into a mail-server ban —
-- or it has to keep the schedule in memory, and a worker that restarts then
-- forgets which messages it was backing off.
-- ---------------------------------------------------------------------------
ALTER TABLE public.outbox ADD COLUMN last_attempt_at timestamptz;

COMMENT ON COLUMN public.outbox.last_attempt_at IS
  'When delivery was last tried, successful or not. With `attempts`, this is '
  'the whole of the backoff schedule: the worker keeps nothing in memory, so '
  'restarting it does not retry everything at once.';

-- The partial index has to see both, or the claim query falls back to a scan
-- of the whole queue once there is a queue worth scanning.
DROP INDEX public.outbox_unsent_idx;
CREATE INDEX outbox_unsent_idx
  ON public.outbox (created_at)
  INCLUDE (attempts, last_attempt_at)
  WHERE sent_at IS NULL;

-- ---------------------------------------------------------------------------
-- The policies, rearranged
-- ---------------------------------------------------------------------------

-- The owner's blanket read-and-write goes, as 0009 said it would.
DROP POLICY outbox_drain ON public.outbox;

CREATE POLICY outbox_drain ON public.outbox
  FOR SELECT TO mail_role USING (true);

-- Recording what happened to a message, and nothing else. The column list on
-- the GRANT is what stops this being "the sender can rewrite the queue"; the
-- policy is what lets it see the rows at all, and both are needed.
CREATE POLICY outbox_record ON public.outbox
  FOR UPDATE TO mail_role
  USING (true) WITH CHECK (true);

-- scripts/outbox.sh, which is still how a developer reads what would have
-- gone out. Read-only now: the owner has no reason to write here and 0009's
-- note is explicit that it should stop being able to.
CREATE POLICY outbox_inspect ON public.outbox
  FOR SELECT TO flightsquare_owner USING (true);

GRANT SELECT ON public.outbox TO mail_role;
GRANT UPDATE (sent_at, attempts, last_error, last_attempt_at)
  ON public.outbox TO mail_role;
GRANT SELECT ON public.outbox TO flightsquare_owner;

COMMENT ON TABLE public.outbox IS
  'The sender drains this as mail_role (api/src/mail). app_role may INSERT '
  'and may not read: the bodies carry live reset links. admin_role has no '
  'access at all — reading this table is reading password resets in flight.';
