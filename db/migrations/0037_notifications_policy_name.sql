-- ===========================================================================
-- 0037_notifications_policy_name.sql — the isolation policy is called
-- tenant_isolation, even when it isolates further
--
-- 0036 named the policy `own_notifications`, because it is narrower than tenant
-- isolation: a notice is addressed to one member and nobody else in the club
-- has any business reading it.
--
-- `db/tests/030` refused it — "notifications: has tenant_id but no
-- tenant_isolation policy (§6.1)" — and the test is right. It is a structural
-- check, not a naming preference: it asks every tenant-scoped table to carry
-- the policy that stands between tenants, under the name every other table uses
-- it under, so that a table which simply forgot cannot hide behind a creative
-- one. A convention nobody can read off a catalogue query is not a convention.
--
-- So it keeps the name. The predicate is unchanged — tenant *and* membership —
-- and the comment says so, because the name undersells what it does.
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

ALTER POLICY own_notifications ON public.notifications RENAME TO tenant_isolation;

COMMENT ON POLICY tenant_isolation ON public.notifications IS
  'Stricter than its name: tenant *and* membership. A notice is addressed to '
  'one person, and §4.4''s scope dimension exists for exactly this — the '
  'predicate is what `app.owns_row` would apply, written directly because '
  'there is no level at which somebody else''s notifications are anybody''s '
  'business. Named for the convention §6.1 and db/tests/030 rely on.';
