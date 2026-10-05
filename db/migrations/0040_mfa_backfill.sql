-- ===========================================================================
-- 0040_mfa_backfill.sql — the backfill 0039 thought it had done
--
-- `0039` ended with:
--
--   UPDATE public.users SET mfa_enabled = true WHERE mfa_enabled = false;
--
-- It matched nothing, changed nothing, and raised nothing. Every user who
-- existed before that migration still had no second factor, and the first
-- sign-in afterwards proved it by handing over a token pair for a password.
--
-- ---------------------------------------------------------------------------
-- Why it did nothing, which is worth writing down because it has happened before
--
-- `users` has FORCE ROW LEVEL SECURITY, so the owner is subject to its policies
-- like anybody else — that is §1.1's "applies to the table owner too", working
-- exactly as intended. The owner's policies on `users` are `definer_bootstrap`
-- (SELECT, and only with `app.auth_bootstrap` set), `definer_provision`
-- (INSERT), and `user_self_write` (UPDATE, and only for `app.current_user_id()`).
-- A bare UPDATE as the owner matches no rows at all.
--
-- **And the silence is the lesson.** `UPDATE` reports zero rows the same way it
-- reports success, so a migration that assumes is a migration that lies. This
-- is the second time in this schema: `0023` exists because `0022`'s backfill
-- did the same thing for the same reason, and said so at the time. The fix then
-- was a per-tenant loop that sets context and verifies; the fix now is the same
-- shape one level down.
--
-- So this migration: reads under the bootstrap flag, writes one row at a time
-- under that row's own user context, and **raises if a single user is left
-- without a second factor**. A backfill that cannot fail loudly is not a
-- backfill.
--
-- Run as flightsquare_owner.
-- ===========================================================================

DO $guard$
BEGIN
  IF current_user <> 'flightsquare_owner' THEN
    RAISE EXCEPTION 'migrations run as flightsquare_owner, not %', current_user;
  END IF;
END
$guard$;

DO $backfill$
DECLARE
  r       record;
  touched integer := 0;
  left_over integer;
BEGIN
  /*
    Read as the bootstrap, write as each user.

    `set_config(..., true)` is `SET LOCAL` in plpgsql's own words: scoped to
    this transaction, gone when the migration commits. Nothing persists, and
    nothing is granted — `db/tests/040` proves that `app_role` setting this flag
    by hand gains it nothing, which is what keeps the arrangement from being
    BYPASSRLS with extra steps.
  */
  PERFORM set_config('app.auth_bootstrap', 'on', true);

  FOR r IN SELECT id FROM public.users WHERE NOT mfa_enabled LOOP
    -- `user_self_write` is the only UPDATE door the owner has here, and it
    -- opens for one row at a time. That is a feature: a loop that has to name
    -- each row cannot quietly update none of them.
    PERFORM set_config('app.user_id', r.id::text, true);

    UPDATE public.users SET mfa_enabled = true WHERE id = r.id;
    touched := touched + 1;
  END LOOP;

  PERFORM set_config('app.user_id', '', true);

  -- The guard 0039 should have had. Read back under the flag that can see.
  SELECT count(*) INTO left_over FROM public.users WHERE NOT mfa_enabled;
  IF left_over <> 0 THEN
    RAISE EXCEPTION
      'MFA backfill reached % user(s) and left % without a second factor',
      touched, left_over;
  END IF;

  RAISE NOTICE 'mfa backfill: % user(s) brought along, 0 left', touched;
END
$backfill$;
