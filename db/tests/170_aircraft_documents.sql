-- ===========================================================================
-- Aircraft documents: §6.1's two non-optional tests, and the three things the
-- grants are supposed to make impossible.
--
-- §3.2 described this table before there was object storage to point at, and
-- `0006` said so in a comment that stood for thirty-two migrations. It exists
-- now, and the paperwork it holds is the kind somebody reads back years later
-- — an insurance certificate in a claim, a weight and balance sheet after a
-- modification — so what the application may and may not do to a row is worth
-- asserting rather than assuming.
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

BEGIN;
SET LOCAL app.tenant_id = '01920000-0000-7000-8000-00000000000a';
SET LOCAL app.user_id   = '01920000-0000-7000-8000-0000000000a1';

INSERT INTO public.aircraft (id, tenant_id, registration, type_code)
VALUES ('01920000-0000-7000-8000-0000000000d1',
        '01920000-0000-7000-8000-00000000000a', 'N903AT', 'SR22');

INSERT INTO public.aircraft_documents
  (id, tenant_id, aircraft_id, kind, title, issued_on, expires_on, uploaded_by)
VALUES ('01920000-0000-7000-8000-0000000000d2',
        '01920000-0000-7000-8000-00000000000a',
        '01920000-0000-7000-8000-0000000000d1',
        'insurance', 'Hull and liability 2026', '2026-01-01', '2026-12-31',
        '01920000-0000-7000-8000-0000000000a2');

-- The file itself is an attachment naming the document, the same way a
-- photograph names its squawk — the document row is written first and carries
-- the metadata (0038).
INSERT INTO public.attachments
  (id, tenant_id, aircraft_document_id, storage_key, content_type,
   byte_size, uploaded_at)
VALUES ('01920000-0000-7000-8000-0000000000d3',
        '01920000-0000-7000-8000-00000000000a',
        '01920000-0000-7000-8000-0000000000d2',
        'a/01920000-0000-7000-8000-0000000000d3.pdf', 'application/pdf',
        340000, now());

-- ---------------------------------------------------------------------------
-- §6.1 item 5: tenant A's context shows tenant A's rows and nothing else.
-- ---------------------------------------------------------------------------
DO $t$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM public.aircraft_documents;
  IF n <> 1 THEN
    RAISE EXCEPTION 'tenant A saw % documents, expected its own 1', n;
  END IF;
  RAISE NOTICE '   ok: a tenant sees its own documents';
END
$t$;

-- ---------------------------------------------------------------------------
-- Two dates and nothing to count down to.
--
-- An airworthiness certificate is good for as long as the aeroplane is
-- maintained and a weight and balance sheet is good until it is modified.
-- Neither has an expiry, and the column being nullable is the schema declining
-- to invent a deadline.
-- ---------------------------------------------------------------------------
DO $t$
BEGIN
  INSERT INTO public.aircraft_documents
    (tenant_id, aircraft_id, kind, title, uploaded_by)
  VALUES ('01920000-0000-7000-8000-00000000000a',
          '01920000-0000-7000-8000-0000000000d1',
          'airworthiness', 'Standard airworthiness certificate',
          '01920000-0000-7000-8000-0000000000a2');
  RAISE NOTICE '   ok: a document that never expires needs no date';

  BEGIN
    INSERT INTO public.aircraft_documents
      (tenant_id, aircraft_id, kind, title, issued_on, expires_on, uploaded_by)
    VALUES ('01920000-0000-7000-8000-00000000000a',
            '01920000-0000-7000-8000-0000000000d1',
            'registration', 'Backwards', '2026-06-01', '2025-06-01',
            '01920000-0000-7000-8000-0000000000a2');
    RAISE EXCEPTION 'a document expired before it was issued';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE '   ok: and one that does cannot expire before it was issued';
  END;
END
$t$;

-- ---------------------------------------------------------------------------
-- Replacing a certificate is a new row naming the old one, never an edit.
--
-- A club renews its insurance every year. The certificate that was current
-- last March is what an insurer asks about in a claim, so it stays untouched —
-- the renewal points back at it, which is `compliance_records.supersedes_id`'s
-- idiom and the same shape every other correction in this schema uses.
-- ---------------------------------------------------------------------------
DO $t$
DECLARE n bigint;
BEGIN
  -- The renewal names what it replaces, and nothing updates the old row.
  INSERT INTO public.aircraft_documents
    (id, tenant_id, aircraft_id, kind, title, issued_on, expires_on,
     supersedes_id, uploaded_by)
  VALUES ('01920000-0000-7000-8000-0000000000d4',
          '01920000-0000-7000-8000-00000000000a',
          '01920000-0000-7000-8000-0000000000d1',
          'insurance', 'Hull and liability 2027', '2027-01-01', '2027-12-31',
          '01920000-0000-7000-8000-0000000000d2',
          '01920000-0000-7000-8000-0000000000a2');

  /*
    "Current" is derived and therefore cannot disagree with itself.

    A forward `superseded_by` column would be a second place to write the same
    fact, and the failure is a list showing two current insurance certificates
    with no way to tell which one is in the aeroplane. This is the left join
    that found nothing.
  */
  SELECT count(*) INTO n FROM public.aircraft_documents d
   WHERE d.kind = 'insurance' AND d.status = 'active'
     AND NOT EXISTS (SELECT 1 FROM public.aircraft_documents later
                      WHERE later.supersedes_id = d.id);
  IF n <> 1 THEN
    RAISE EXCEPTION '% current insurance certificates, expected 1', n;
  END IF;
  RAISE NOTICE '   ok: a renewal supersedes rather than overwrites';

  -- The superseded one is still there, with its dates and its file.
  IF NOT EXISTS (SELECT 1 FROM public.aircraft_documents
                  WHERE id = '01920000-0000-7000-8000-0000000000d2'
                    AND expires_on = '2026-12-31') THEN
    RAISE EXCEPTION 'last year''s certificate lost its dates';
  END IF;
  RAISE NOTICE '   ok: and last year''s certificate keeps its dates and file';
END
$t$;

-- ---------------------------------------------------------------------------
-- What the application may not do.
-- ---------------------------------------------------------------------------
DO $t$
BEGIN
  -- A document that could be moved to another aeroplane is a document whose
  -- provenance is a suggestion.
  BEGIN
    UPDATE public.aircraft_documents SET aircraft_id = '01920000-0000-7000-8000-0000000000d1'
     WHERE id = '01920000-0000-7000-8000-0000000000d4';
    RAISE EXCEPTION 'app_role moved a document to another aeroplane';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE '   ok: app_role cannot repoint a document at another aircraft';
  END;

  -- Nor rewrite what a renewal replaced, which is the whole reason
  -- supersession is derived rather than stored.
  BEGIN
    UPDATE public.aircraft_documents SET supersedes_id = NULL
     WHERE id = '01920000-0000-7000-8000-0000000000d4';
    RAISE EXCEPTION 'app_role rewrote what a renewal superseded';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE '   ok: app_role cannot rewrite a supersession';
  END;

  BEGIN
    DELETE FROM public.aircraft_documents
     WHERE id = '01920000-0000-7000-8000-0000000000d4';
    RAISE EXCEPTION 'app_role deleted a document';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE '   ok: app_role cannot delete one, leaving bytes behind';
  END;
END
$t$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- §6.1 item 6: an insert carrying another tenant's id is refused.
--
-- Tenant A's aeroplane is created first and the context then moves to B, so
-- the row attempted is a valid (tenant, aircraft) pair belonging to somebody
-- else — referential checks bypass RLS, which leaves the policy as the only
-- thing that can refuse it. An invalid pair would be caught by the foreign key
-- and prove nothing about isolation.
-- ---------------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '01920000-0000-7000-8000-00000000000a';
SET LOCAL app.user_id   = '01920000-0000-7000-8000-0000000000a1';

INSERT INTO public.aircraft (id, tenant_id, registration, type_code)
VALUES ('01920000-0000-7000-8000-0000000000d5',
        '01920000-0000-7000-8000-00000000000a', 'N904AT', 'SR22');

SET LOCAL app.tenant_id = '01920000-0000-7000-8000-00000000000b';
SET LOCAL app.user_id   = '01920000-0000-7000-8000-0000000000b1';

DO $t$
DECLARE msg text;
BEGIN
  BEGIN
    INSERT INTO public.aircraft_documents
      (tenant_id, aircraft_id, kind, title, uploaded_by)
    VALUES ('01920000-0000-7000-8000-00000000000a',
            '01920000-0000-7000-8000-0000000000d5',
            'insurance', 'Written into someone else''s tenant',
            '01920000-0000-7000-8000-0000000000a2');
    RAISE EXCEPTION 'a document was written into another tenant';
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
-- §7.2: content, not metadata.
--
-- An insurance certificate is the tenant's commercial business and a weight
-- and balance sheet is operating detail. The control plane reads neither
-- without a time-boxed, logged, tenant-consented grant — and the default being
-- deny means saying nothing in the migration is saying no, which is exactly
-- what this proves.
-- ---------------------------------------------------------------------------
DO $t$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'aircraft_documents'
     AND 'admin_role' = ANY(roles);
  IF n <> 0 THEN
    RAISE EXCEPTION 'aircraft_documents granted admin_role a policy — §7.2 content tier';
  END IF;

  SELECT count(*) INTO n FROM information_schema.table_privileges
   WHERE table_schema = 'public' AND table_name = 'aircraft_documents'
     AND grantee = 'admin_role';
  IF n <> 0 THEN
    RAISE EXCEPTION 'admin_role holds % grants on aircraft_documents', n;
  END IF;
  RAISE NOTICE '   ok: the control plane cannot read a tenant''s paperwork';
END
$t$;

-- ---------------------------------------------------------------------------
-- Expiry is a notice, never a grounding.
--
-- §11: "do not infer airworthiness from an absence of maintenance warnings",
-- and the inverse binds just as hard — an aeroplane is not unflyable because
-- nobody uploaded a PDF. `aircraft_availability` stays fed by squawks and
-- overdue grounding items, which is also what keeps the booking trigger out of
-- this entirely.
-- ---------------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '01920000-0000-7000-8000-00000000000a';
SET LOCAL app.user_id   = '01920000-0000-7000-8000-0000000000a1';

INSERT INTO public.aircraft (id, tenant_id, registration, type_code)
VALUES ('01920000-0000-7000-8000-0000000000d6',
        '01920000-0000-7000-8000-00000000000a', 'N905AT', 'SR22');

INSERT INTO public.aircraft_documents
  (tenant_id, aircraft_id, kind, title, issued_on, expires_on, uploaded_by)
VALUES ('01920000-0000-7000-8000-00000000000a',
        '01920000-0000-7000-8000-0000000000d6',
        'insurance', 'Lapsed last year', '2024-01-01', '2025-01-01',
        '01920000-0000-7000-8000-0000000000a2');

DO $t$
DECLARE available boolean;
BEGIN
  SELECT v.available INTO available FROM public.aircraft_availability v
   WHERE v.aircraft_id = '01920000-0000-7000-8000-0000000000d6';

  IF available IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'a lapsed document grounded an aeroplane';
  END IF;
  RAISE NOTICE '   ok: a lapsed document does not ground an aeroplane';
END
$t$;
ROLLBACK;
