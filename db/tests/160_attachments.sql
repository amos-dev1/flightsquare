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
--
-- Tenant A's squawk is created first and the context then moves to B, so the
-- row being attempted is a *valid* (tenant, owner) pair belonging to somebody
-- else. That matters since 0038: an attachment now has to name exactly one
-- owner, and an ownerless insert would be refused by that CHECK before the
-- policy was ever consulted — which would leave this test passing with RLS
-- switched off. Referential checks bypass RLS, so the foreign key is satisfied
-- and the policy is the only thing left to refuse it.
-- ---------------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '01920000-0000-7000-8000-00000000000a';
SET LOCAL app.user_id   = '01920000-0000-7000-8000-0000000000a1';

INSERT INTO public.aircraft (id, tenant_id, registration, type_code)
VALUES ('01920000-0000-7000-8000-0000000000f1',
        '01920000-0000-7000-8000-00000000000a', 'N901AT', 'C172');

INSERT INTO public.squawks (id, tenant_id, aircraft_id, summary, reported_by)
VALUES ('01920000-0000-7000-8000-0000000000f2',
        '01920000-0000-7000-8000-00000000000a',
        '01920000-0000-7000-8000-0000000000f1',
        'Nav light intermittent',
        '01920000-0000-7000-8000-0000000000a2');

SET LOCAL app.tenant_id = '01920000-0000-7000-8000-00000000000b';
SET LOCAL app.user_id   = '01920000-0000-7000-8000-0000000000b1';

DO $t$
DECLARE msg text;
BEGIN
  BEGIN
    INSERT INTO public.attachments
      (tenant_id, squawk_id, storage_key, content_type, byte_size)
    VALUES ('01920000-0000-7000-8000-00000000000a',
            '01920000-0000-7000-8000-0000000000f2',
            'a/written-into-someone-elses-tenant.jpg', 'image/jpeg', 1);
    RAISE EXCEPTION 'an attachment was written into another tenant';
  EXCEPTION WHEN insufficient_privilege THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    IF msg NOT LIKE '%row-level security%' THEN
      RAISE EXCEPTION 'rejected, but not by RLS: %', msg;
    END IF;
    RAISE NOTICE '   ok: WITH CHECK refuses another tenant''s id';
  END;
END
$t$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- 0038: at most one owner, never two.
--
-- Two is the bug worth a constraint. §1.5 wants a permission check on every
-- endpoint and the resource depends on what the object is attached to — a
-- defect photograph is `squawks`, an invoice is `maintenance.items`, a
-- certificate is `documents` — so one file reachable through two list endpoints
-- gated on two different resources is a permission bypass.
--
-- Zero owners stays legal, and that is §8.1 rather than a preference: an
-- ownerless attachment is creatable today and two API tests rely on it, so the
-- rule does not get tightened under a client already shipped. Such a row is
-- simply unreachable through the new doors.
-- ---------------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '01920000-0000-7000-8000-00000000000a';
SET LOCAL app.user_id   = '01920000-0000-7000-8000-0000000000a1';

INSERT INTO public.aircraft (id, tenant_id, registration, type_code)
VALUES ('01920000-0000-7000-8000-0000000000f3',
        '01920000-0000-7000-8000-00000000000a', 'N902AT', 'C172');

INSERT INTO public.squawks (id, tenant_id, aircraft_id, summary, reported_by)
VALUES ('01920000-0000-7000-8000-0000000000f4',
        '01920000-0000-7000-8000-00000000000a',
        '01920000-0000-7000-8000-0000000000f3',
        'Cowl fastener missing',
        '01920000-0000-7000-8000-0000000000a2');

-- Standing alone, which the schema allows and which keeps this file about
-- attachments: a record naming an item would roll that item forward, and the
-- interval arithmetic has its own suite (100_maintenance).
INSERT INTO public.compliance_records
  (id, tenant_id, aircraft_id, kind, title, complied_on)
VALUES ('01920000-0000-7000-8000-0000000000f6',
        '01920000-0000-7000-8000-00000000000a',
        '01920000-0000-7000-8000-0000000000f3',
        'repair', 'Oil and filter change', '2026-08-02');

DO $t$
BEGIN
  INSERT INTO public.attachments
    (tenant_id, storage_key, content_type, byte_size)
  VALUES ('01920000-0000-7000-8000-00000000000a',
          'a/belongs-to-nothing.pdf', 'application/pdf', 1);
  RAISE NOTICE '   ok: an ownerless attachment is still accepted (§8.1)';

  BEGIN
    INSERT INTO public.attachments
      (tenant_id, squawk_id, compliance_record_id,
       storage_key, content_type, byte_size)
    VALUES ('01920000-0000-7000-8000-00000000000a',
            '01920000-0000-7000-8000-0000000000f4',
            '01920000-0000-7000-8000-0000000000f6',
            'a/belongs-to-two-things.pdf', 'application/pdf', 1);
    RAISE EXCEPTION 'an attachment was stored belonging to two things';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE '   ok: and one cannot belong to two things at once';
  END;
END
$t$;

-- -------------------------------------------------------------------------
-- A completion's paperwork: withdrawable, and not deletable.
--
-- §3.6 will not let a signed compliance record be edited, so taking a wrong
-- invoice off one cannot be an edit of the record. Nor is it an unlink: the
-- row keeps saying what it was filed against and says it was withdrawn, which
-- is how §3.6 corrects everything else in this corner of the schema. The bytes
-- stay counted, because the bytes are still in the bucket.
-- -------------------------------------------------------------------------
INSERT INTO public.attachments
  (id, tenant_id, compliance_record_id, storage_key, content_type,
   byte_size, uploaded_at)
VALUES ('01920000-0000-7000-8000-0000000000f7',
        '01920000-0000-7000-8000-00000000000a',
        '01920000-0000-7000-8000-0000000000f6',
        'a/01920000-0000-7000-8000-0000000000f7.pdf', 'application/pdf',
        120000, now());

DO $t$
DECLARE
  used bigint;
  row  public.attachments;
BEGIN
  UPDATE public.attachments
     SET status = 'removed',
         removed_at = now(),
         removed_by = '01920000-0000-7000-8000-0000000000a2',
         removed_reason = 'That is the invoice for the other aeroplane'
   WHERE id = '01920000-0000-7000-8000-0000000000f7';

  SELECT * INTO row FROM public.attachments
   WHERE id = '01920000-0000-7000-8000-0000000000f7';

  -- The link survives, which is the point: the completion was once filed with
  -- this invoice against it, and that stays true.
  IF row.compliance_record_id IS NULL THEN
    RAISE EXCEPTION 'removal erased what the invoice had been filed against';
  END IF;
  RAISE NOTICE '   ok: a wrong invoice is removed, and still says what from';

  -- And the application cannot clear the link instead, which would.
  BEGIN
    UPDATE public.attachments SET compliance_record_id = NULL
     WHERE id = '01920000-0000-7000-8000-0000000000f7';
    RAISE EXCEPTION 'app_role unlinked an invoice from a signed record';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE '   ok: app_role cannot unlink one instead';
  END;

  -- A removal with no actor and no time is not a record of anything.
  INSERT INTO public.attachments
    (id, tenant_id, compliance_record_id, storage_key, content_type, byte_size)
  VALUES ('01920000-0000-7000-8000-0000000000f8',
          '01920000-0000-7000-8000-00000000000a',
          '01920000-0000-7000-8000-0000000000f6',
          'a/01920000-0000-7000-8000-0000000000f8.pdf', 'application/pdf', 1);

  BEGIN
    UPDATE public.attachments SET status = 'removed'
     WHERE id = '01920000-0000-7000-8000-0000000000f8';
    RAISE EXCEPTION 'an attachment was removed by nobody';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE '   ok: a removal names who and when';
  END;

  /*
    And the bytes do not come back.

    The mirror of the assertion further up this file, and the more important of
    the two: if removal decremented the counter a tenant could upload and remove
    in a loop and hold unbounded objects in the bucket while reading zero,
    because nothing deletes them.
  */
  SELECT current_value INTO used FROM public.tenant_usage
   WHERE tenant_id = '01920000-0000-7000-8000-00000000000a'
     AND quota_key = 'storage.bytes';
  IF used IS DISTINCT FROM 120000 THEN
    RAISE EXCEPTION 'removal changed the bytes stored: %', used;
  END IF;
  RAISE NOTICE '   ok: removing does not un-store the bytes';
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
