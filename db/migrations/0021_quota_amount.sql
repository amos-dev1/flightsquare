-- ===========================================================================
-- 0021_quota_amount.sql — assert_quota learns to count in bytes
--
-- 0020 made `storage.bytes` real, and in doing so found two things wrong with
-- the helper that is supposed to enforce it. Both were invisible while every
-- quota in the product was a count of things somebody can see.
--
-- ---------------------------------------------------------------------------
-- 1. The limit did not fit
--
-- `assert_quota(p_key text, p_limit int)` — and 0005 priced Pro storage at
-- 26,843,545,600 bytes, which is twelve times what int4 holds. The call does
-- not enforce the wrong limit; it raises `integer out of range`, which is a
-- 500 rather than a 402. A quota nothing counted could not fail this way, so
-- it sat there from 0005 until something finally counted bytes.
--
-- `bigint` now, which is also what `tenant_usage.current_value` has always
-- been. The two being different widths was the bug in miniature.
--
-- ---------------------------------------------------------------------------
-- 2. A quota in bytes is not consumed one at a time
--
-- `v_current >= p_limit` asks "is there room for one more", which is exactly
-- right for aircraft and members: you add them singly. A ten megabyte
-- photograph is ten million units of `storage.bytes`, and a tenant one byte
-- under a limit of 1 GiB would have sailed past it.
--
-- So `p_amount bigint DEFAULT 1`, and the comparison becomes
-- `v_current + p_amount > p_limit`. For every existing caller the default
-- makes that identical to what it did before — `current + 1 > limit` is
-- `current >= limit` over integers — so this generalises the helper rather
-- than changing it. Nothing else in the schema or the API moves.
--
-- Two-argument call sites keep working through the default, which is why
-- `api/src/db/entitlements.ts` needed no new shape for the ones that count
-- things.
--
-- ---------------------------------------------------------------------------
-- Not a new §2.3 helper
--
-- This is the same function, doing the same job, with parameters wide enough
-- for the quotas that already exist. It takes no tenant id (§2.3 rule 2), it
-- still derives the tenant from `app.current_tenant_id()` and still fails
-- closed without it, and `db/tests/030`'s closed list is by name, so the list
-- is unchanged. DROP and CREATE rather than CREATE OR REPLACE only because
-- Postgres will not change a parameter's type in place.
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

DROP FUNCTION public.assert_quota(text, int);

CREATE FUNCTION public.assert_quota(p_key text, p_limit bigint, p_amount bigint DEFAULT 1)
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_tenant  uuid := app.current_tenant_id();
  v_current bigint;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'assert_quota requires tenant context'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_amount IS NULL OR p_amount < 0 THEN
    RAISE EXCEPTION 'assert_quota amount must be non-negative, got %', p_amount
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- NULL is Unlimited. Nothing to lock and nothing to compare, and the
  -- caller must not be encouraged to encode unlimited as a large number.
  IF p_limit IS NULL THEN
    RETURN 0;
  END IF;

  -- Materialise the row so there is something to lock even before the first
  -- write of this kind, then take the lock.
  INSERT INTO public.tenant_usage AS u (tenant_id, quota_key, current_value)
  VALUES (v_tenant, p_key, 0)
  ON CONFLICT (tenant_id, quota_key) DO NOTHING;

  SELECT u.current_value INTO v_current
    FROM public.tenant_usage u
   WHERE u.tenant_id = v_tenant AND u.quota_key = p_key
     FOR UPDATE;

  IF v_current + p_amount > p_limit THEN
    RAISE EXCEPTION 'quota % exhausted', p_key
      USING ERRCODE = 'FS402', DETAIL = v_current::text;
  END IF;

  RETURN v_current;
END
$$;

REVOKE ALL ON FUNCTION public.assert_quota(text, bigint, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assert_quota(text, bigint, bigint) TO app_role;

COMMENT ON FUNCTION public.assert_quota(text, bigint, bigint) IS
  '§2.3 privileged helper. Locks this tenant''s usage row for the duration of '
  'the caller''s transaction and raises SQLSTATE FS402 with the current count '
  'in DETAIL when p_amount more would exceed the limit. p_amount defaults to '
  '1, which is what a count of aircraft or members consumes; storage.bytes '
  'passes the size of the file. Takes no tenant argument by design: the '
  'tenant comes from context, so it cannot be pointed elsewhere.';
