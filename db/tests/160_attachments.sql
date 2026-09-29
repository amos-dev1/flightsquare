-- ===========================================================================
-- Attachments: §6.1's two non-optional tests, and the quota that counts them.
--
-- §6.1 is explicit that items 5 and 6 are not optional — "a policy without a
-- test proving it denies is an untested security control" — so this proves
-- both for `attachments`, and then proves the thing that is new about it:
-- `storage.bytes` has been priced since 0005 with nothing counting a byte,
-- and 0020's trigger is what makes the limit real.
--
-- The bytes themselves are not here and never will be (§3.8): a row is a
-- pointer into object storage, and the API signs a URL rather than handling
-- an upload.
--
-- Runs as app_role, in transactions that roll back.
-- ===========================================================================

DO $guard$
BEGIN
  IF current_user <> 'app_role' THEN
    RAISE EXCEPTION 'this test must run as app_role, not %', current_user;
  END IF;
END
$guard$;

-- ---------------------------------------------------------------------------
-- A squawk in each tenant, to hang attachments off.
-- ---------------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '01920000-0000-7000-8000-00000000000a';
SET LOCAL app.user_id   = '01920000-0000-7000-8000-0000000000a1';

INSERT INTO public.aircraft (id, tenant_id, registration, type_code)
VALUES ('01920000-0000-7000-8000-0000000000e1',
        '01920000-0000-7000-8000-00000000000a', 'N900AT', 'C172');

INSERT INTO public.squawks (id, tenant_id, aircraft_id, summary, reported_by)
VALUES ('01920000-0000-7000-8000-0000000000e2',
        '01920000-0000-7000-8000-00000000000a',
        '01920000-0000-7000-8000-0000000000e1',
        'Cracked bracket on the nose gear fairing',
        '01920000-0000-7000-8000-0000000000a2');

INSERT INTO public.attachments
  (id, tenant_id, squawk_id, storage_key, content_type, byte_size, uploaded_at)
VALUES ('01920000-0000-7000-8000-0000000000e3',
        '01920000-0000-7000-8000-00000000000a',
        '01920000-0000-7000-8000-0000000000e2',
        'a/01920000-0000-7000-8000-0000000000e3.jpg', 'image/jpeg', 250000, now());

-- -------------------------------------------------------------------------
-- §6.1 item 5: tenant A's context shows tenant A's rows and nothing else.
-- -------------------------------------------------------------------------
DO $t$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM public.attachments;
  IF n <> 1 THEN
    RAISE EXCEPTION 'tenant A saw % attachments, expected its own 1', n;
  END IF;
  RAISE NOTICE '   ok: a tenant sees its own attachments';
END
$t$;

-- -------------------------------------------------------------------------
-- The quota stops being fictional.
--
-- 0005 priced storage at 1 GiB free and 25 GiB pro, and until 0020 nothing
-- counted a byte — which is why /entitlements returned that quota with a
-- limit and no `current` at all.
-- -------------------------------------------------------------------------
DO $t$
DECLARE used bigint;
BEGIN
  SELECT current_value INTO used FROM public.tenant_usage
   WHERE tenant_id = '01920000-0000-7000-8000-00000000000a'
     AND quota_key = 'storage.bytes';

  IF used IS DISTINCT FROM 250000 THEN
    RAISE EXCEPTION 'storage.bytes counted %, expected 250000', used;
  END IF;
  RAISE NOTICE '   ok: storage.bytes counts bytes, not rows';
END
$t$;

-- -------------------------------------------------------------------------
-- An upload that was signed and never completed is a declaration, not bytes
-- somebody is holding. Charging a club for it is not explicable.
-- -------------------------------------------------------------------------
DO $t$
DECLARE used bigint;
BEGIN
  INSERT INTO public.attachments
    (tenant_id, squawk_id, storage_key, content_type, byte_size)
  VALUES ('01920000-0000-7000-8000-00000000000a',
          '01920000-0000-7000-8000-0000000000e2',
          'a/never-arrived.jpg', 'image/jpeg', 999999);

  SELECT current_value INTO used FROM public.tenant_usage
   WHERE tenant_id = '01920000-0000-7000-8000-00000000000a'
     AND quota_key = 'storage.bytes';

  IF used IS DISTINCT FROM 250000 THEN
    RAISE EXCEPTION 'an unfinished upload was counted: %', used;
  END IF;
  RAISE NOTICE '   ok: only what actually arrived is counted';
END
$t$;

-- -------------------------------------------------------------------------
-- app_role may record what storage received, and may not rewrite the
-- pointer: moving `storage_key` under a row would orphan the object.
-- -------------------------------------------------------------------------
DO $t$
BEGIN
  BEGIN
    UPDATE public.attachments SET storage_key = 'a/somewhere-else.jpg'
     WHERE id = '01920000-0000-7000-8000-0000000000e3';
    RAISE EXCEPTION 'app_role repointed an attachment at another object';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE '   ok: app_role cannot move a pointer';
  END;

  BEGIN
    DELETE FROM public.attachments
     WHERE id = '01920000-0000-7000-8000-0000000000e3';
    RAISE EXCEPTION 'app_role deleted an attachment';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE '   ok: app_role cannot delete one, leaving bytes behind';
  END;
END
$t$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- §6.1 item 6: an insert carrying another tenant's id is refused.
-- ---------------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '01920000-0000-7000-8000-00000000000b';
SET LOCAL app.user_id   = '01920000-0000-7000-8000-0000000000b1';

DO $t$
BEGIN
  BEGIN
    INSERT INTO public.attachments
      (tenant_id, storage_key, content_type, byte_size)
    VALUES ('01920000-0000-7000-8000-00000000000a',
            'a/written-into-someone-elses-tenant.jpg', 'image/jpeg', 1);
    RAISE EXCEPTION 'an attachment was written into another tenant';
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN
    RAISE NOTICE '   ok: WITH CHECK refuses another tenant''s id';
  END;
END
$t$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- §7.2: content, not metadata. A photograph of a defect is not less
-- sensitive than the sentence describing it, so the control plane reads
-- neither without a time-boxed, logged, tenant-consented grant.
-- ---------------------------------------------------------------------------
DO $t$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'attachments'
     AND 'admin_role' = ANY(roles);
  IF n <> 0 THEN
    RAISE EXCEPTION 'attachments granted admin_role a policy — §7.2 puts it in the content tier';
  END IF;

  SELECT count(*) INTO n FROM information_schema.table_privileges
   WHERE table_schema = 'public' AND table_name = 'attachments'
     AND grantee = 'admin_role';
  IF n <> 0 THEN
    RAISE EXCEPTION 'admin_role holds % grants on attachments', n;
  END IF;
  RAISE NOTICE '   ok: the control plane cannot read attachments at all';
END
$t$;
