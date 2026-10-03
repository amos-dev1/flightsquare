-- ===========================================================================
-- 0038_records.sql — the paperwork, beside the record of the work
--
-- SPEC Phase 2: "attach invoice / logbook-entry photo or PDF to a completion;
-- per-aircraft document storage". Both halves land on the table `0020` built
-- for squawk photographs, which said at the time exactly where this was going:
--
--   "§3.2's `aircraft_documents` — airworthiness certificate, registration,
--    insurance, weight and balance — is the same shape and arrives against the
--    same table, which is why `squawk_id` is nullable."
--
-- Half right, as it turns out. The *bytes* arrive against the same table; the
-- *document* does not, because a document has a kind, an issue date and an
-- expiry, and a photograph of a cracked bracket has none of those.
--
-- ---------------------------------------------------------------------------
-- An owner column per owner, and not a polymorphic pair
--
-- SPEC §7 sketches `attachment (owner_type, owner_id, …)`. That shape cannot
-- carry a foreign key, so nothing would stop a row naming an id that does not
-- exist or — the one that matters — one in another tenant. The composite key is
-- the single mechanism this schema uses to make a cross-tenant pointer
-- unrepresentable, and `0020` leaned on it for squawks. Three nullable columns
-- with three composite foreign keys are three constraints the database
-- enforces. One polymorphic pair is none.
--
-- Three owners, not an open set. A fourth is a migration, which is the right
-- price; a fifth is where this stops being the answer and a junction table
-- starts being one.
--
-- ---------------------------------------------------------------------------
-- The owner exists first, and the upload names it
--
-- That is already how a squawk photograph works, and it is what makes the
-- offline queue correct: `mobile/src/lib/sync.ts` orders an attachment one
-- millisecond behind the squawk it names, so the owner is written before the
-- upload refers to it. Documents follow the same order — the document row
-- carries the metadata and is written first — which is why the foreign key
-- goes `attachments.aircraft_document_id` and never the reverse.
--
-- Three things fall out of that direction, all of them wanted: a two-page
-- certificate is two attachment rows against one document with no junction
-- table; a document can exist before anything is scanned, which is a real state
-- in a club; and `refresh_attachments_usage` is untouched, because it sums
-- bytes on this table regardless of what owns them. `storage.bytes` therefore
-- extends to documents for nothing.
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

-- ---------------------------------------------------------------------------
-- §3.2's table, at last
--
-- The AROW set is the reason it exists: airworthiness certificate,
-- registration, operating limitations, weight and balance — the paperwork that
-- has to be aboard, and which a pilot currently has to take on trust or go and
-- look in the aeroplane for.
--
-- Insurance is not AROW and is here anyway, because it is the document a club
-- actually chases: it expires, somebody has to renew it, and the reminder is
-- most of the value of storing a date beside a file.
-- ---------------------------------------------------------------------------

CREATE TABLE public.aircraft_documents (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id     uuid NOT NULL REFERENCES public.tenants(id),
  aircraft_id   uuid NOT NULL,

  kind          text NOT NULL,
  /** So `other` is useful, and so a renewal can be told from the one before. */
  title         text NOT NULL,
  /** Policy number, certificate number — free text, and not parsed. */
  reference     text,

  issued_on     date,
  /*
    Null for the ones that do not expire.

    A standard airworthiness certificate is effective for as long as the
    aeroplane is maintained, and a weight and balance sheet is good until the
    aeroplane is modified. Neither has a date to count down to, and inventing
    one would put a false deadline in front of somebody.

    Not enforced per kind. The obvious CHECK — no expiry on an airworthiness
    document — is right about the standard certificate and wrong about a special
    flight permit, and a constraint that needs a migration the first time a
    tenant ferries an aeroplane on a permit is a constraint encoding a
    regulation it does not fully know. The forms decline to ask instead.
  */
  expires_on    date,
  notes         text,

  /*
    A renewal names the certificate it replaces, and nothing updates the old
    row.

    The same idiom as `compliance_records.supersedes_id`, and chosen over a
    forward `superseded_by` for the reason §3.7 gives about rates: the fact is
    derived rather than stored, so it cannot disagree with itself. Two current
    insurance certificates is not a state this table can get into, because
    "current" is a left join that found nothing rather than a column somebody
    had to remember to write.
  */
  supersedes_id uuid,

  /*
    §10: an application-facing delete is a status column.

    `removed` is for a file filed by mistake. A superseded certificate is not
    removed — the 2024 policy is what answers a question about a 2024 claim —
    which is why these are two different mechanisms and not one.
  */
  status        text NOT NULL DEFAULT 'active',
  removed_at    timestamptz,
  removed_by    uuid,
  removed_reason text,

  /*
    What has already been said about this expiry, so the sweep says it once.

    The same mechanism `maintenance_items.notified_state` uses, for the reason
    `scheduler/maintenance.ts` gives at length: a reminder that repeats every
    hour until somebody acts gets filtered, and the filter takes the one that
    mattered with it.
  */
  notified_state text,

  uploaded_by   uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT aircraft_documents_kind_check CHECK (kind IN (
    'airworthiness', 'registration', 'operating_limitations',
    'weight_balance', 'insurance', 'other')),
  CONSTRAINT aircraft_documents_status_check
    CHECK (status IN ('active', 'removed')),
  CONSTRAINT aircraft_documents_removed_check
    CHECK ((status = 'removed') = (removed_at IS NOT NULL)
           AND (removed_at IS NULL) = (removed_by IS NULL)),
  CONSTRAINT aircraft_documents_notified_check
    CHECK (notified_state IS NULL
           OR notified_state IN ('expiring_soon', 'expired')),
  CONSTRAINT aircraft_documents_expiry_check
    CHECK (expires_on IS NULL OR issued_on IS NULL OR expires_on >= issued_on),

  CONSTRAINT aircraft_documents_aircraft_fkey
    FOREIGN KEY (tenant_id, aircraft_id) REFERENCES public.aircraft (tenant_id, id),
  CONSTRAINT aircraft_documents_uploader_fkey
    FOREIGN KEY (tenant_id, uploaded_by) REFERENCES public.memberships (tenant_id, id),
  CONSTRAINT aircraft_documents_remover_fkey
    FOREIGN KEY (tenant_id, removed_by) REFERENCES public.memberships (tenant_id, id),
  CONSTRAINT aircraft_documents_supersedes_fkey
    FOREIGN KEY (tenant_id, supersedes_id)
    REFERENCES public.aircraft_documents (tenant_id, id),
  -- §6.1 item 1 is the tenant column; this is what lets `attachments`
  -- reference a row of this table without leaving its tenant.
  CONSTRAINT aircraft_documents_tenant_id_key UNIQUE (tenant_id, id)
);

-- §6.1 item 4: an index leading with tenant_id. The list this serves is "what
-- paperwork does this aeroplane have".
CREATE INDEX aircraft_documents_aircraft_idx
  ON public.aircraft_documents (tenant_id, aircraft_id, kind, created_at DESC);

-- What a renewal asks: has anything already replaced this one.
CREATE INDEX aircraft_documents_supersedes_idx
  ON public.aircraft_documents (tenant_id, supersedes_id)
  WHERE supersedes_id IS NOT NULL;

-- What the sweep asks. Partial, because most rows have no date and none of
-- them are the question.
CREATE INDEX aircraft_documents_expiry_idx
  ON public.aircraft_documents (tenant_id, expires_on)
  WHERE expires_on IS NOT NULL AND status = 'active';

COMMENT ON TABLE public.aircraft_documents IS
  '§3.2: the paperwork that belongs to an aeroplane rather than to a job of '
  'work. The file itself is an `attachments` row naming this one. Expiry is a '
  'notice and never a grounding — §11 forbids inferring airworthiness, and an '
  'aeroplane is not unflyable because nobody uploaded a PDF.';

ALTER TABLE public.aircraft_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.aircraft_documents FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.aircraft_documents
  FOR ALL TO app_role, flightsquare_owner
  USING      (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

/*
  No DELETE, and the UPDATE is column-restricted.

  The application needs to remove a row and to correct a date, a title or a
  note. It does not need to move a document to another aeroplane, and
  `aircraft_id` is therefore not on the list — a document that could be
  repointed is a document whose provenance is a suggestion. Nor does it need to
  rewrite `supersedes_id`, which is the whole point of deriving supersession
  rather than storing it.
*/
GRANT SELECT, INSERT ON public.aircraft_documents TO app_role;
GRANT UPDATE (status, removed_at, removed_by, removed_reason,
              issued_on, expires_on, title, reference, notes, notified_state)
  ON public.aircraft_documents TO app_role;

-- §7.2, and no admin_read policy: deliberate. An insurance certificate is the
-- tenant's commercial business and a weight and balance sheet is operating
-- detail, which is the content tier — the same call `0020` made for
-- `attachments`, for the same reason. `db/tests/030` defaults to deny, so
-- saying nothing here is saying no.

-- ---------------------------------------------------------------------------
-- `attachments` learns two more owners, a kind, and how to be put aside
-- ---------------------------------------------------------------------------

ALTER TABLE public.attachments
  ADD COLUMN compliance_record_id uuid,
  ADD COLUMN aircraft_document_id uuid,

  /*
    What the file is, which mockup 05 asks for directly: its two dashed tiles
    are "Attach invoice" and "Logbook entry", and mockup 04 labels its glyph
    "Invoice attached".

    Defaulted, so nothing is backfilled and an old client that does not send it
    stays correct (§8.1). It is a label and not a source — camera versus files
    is a different question and must never be inferred from this.
  */
  ADD COLUMN kind text NOT NULL DEFAULT 'photo',

  /*
    §10 again: filed by mistake is a status, not a delete.

    There is no DELETE grant and no purge job — `0020` said why and it is still
    true: an uploaded pointer needs a storage cleanup story that does not exist.
    A removal therefore marks the row and keeps the link, which matters most for
    a completion: §3.6 will not let a signed compliance record be edited, and
    erasing the link would erase the fact that an invoice was once filed against
    one. The reason is required by the API for the same reason §4.7 requires one
    for a void.
  */
  ADD COLUMN status text NOT NULL DEFAULT 'active',
  ADD COLUMN removed_at timestamptz,
  ADD COLUMN removed_by uuid,
  ADD COLUMN removed_reason text;

ALTER TABLE public.attachments
  ADD CONSTRAINT attachments_compliance_fkey
    FOREIGN KEY (tenant_id, compliance_record_id)
    REFERENCES public.compliance_records (tenant_id, id),
  ADD CONSTRAINT attachments_document_fkey
    FOREIGN KEY (tenant_id, aircraft_document_id)
    REFERENCES public.aircraft_documents (tenant_id, id),
  ADD CONSTRAINT attachments_remover_fkey
    FOREIGN KEY (tenant_id, removed_by)
    REFERENCES public.memberships (tenant_id, id),
  ADD CONSTRAINT attachments_kind_check CHECK (kind IN (
    'photo', 'invoice', 'logbook_entry', 'document')),
  ADD CONSTRAINT attachments_status_check
    CHECK (status IN ('active', 'removed')),
  ADD CONSTRAINT attachments_removed_check
    CHECK ((status = 'removed') = (removed_at IS NOT NULL)
           AND (removed_at IS NULL) = (removed_by IS NULL)),

  /*
    At most one owner, never two.

    Two is the bug worth a constraint: one file reachable through two list
    endpoints gated on two different permission resources is a permission
    bypass, not an untidiness.

    Not *exactly* one, though the permission argument pulls that way — an
    attachment owning nothing has no resource for §1.5's check to ask about. It
    is already creatable (`CreateAttachmentRequest.squawk_id` is optional and
    two tests rely on it), and §8.1 is absolute that a validation rule an old
    client would now fail does not get tightened. So an ownerless row stays
    legal and stays unreachable: the squawk doors serve squawk-owned and
    ownerless rows exactly as they did, and the new owners get new doors.
  */
  ADD CONSTRAINT attachments_one_owner_check
    CHECK (num_nonnulls(squawk_id, compliance_record_id, aircraft_document_id) <= 1);

CREATE INDEX attachments_compliance_idx
  ON public.attachments (tenant_id, compliance_record_id, created_at DESC)
  WHERE compliance_record_id IS NOT NULL;

CREATE INDEX attachments_document_idx
  ON public.attachments (tenant_id, aircraft_document_id, created_at DESC)
  WHERE aircraft_document_id IS NOT NULL;

/*
  The bytes do not come back, and this is the sharp part.

  If a removal decremented `storage.bytes`, a tenant could upload and remove in
  a loop and hold unbounded objects in the bucket while reading zero — because
  nothing deletes them. The counter measures what FlightSquare is actually
  storing, and after a removal it is still storing it. So
  `refresh_attachments_usage` is untouched, and the screens have to say so:
  "removed, and it still counts toward your storage" is the true sentence, and
  "freed 2.4 MB" would be the §11 violation.
*/
GRANT UPDATE (status, removed_at, removed_by, removed_reason)
  ON public.attachments TO app_role;

COMMENT ON COLUMN public.attachments.compliance_record_id IS
  'The completion this is the paperwork for (SPEC §4.7). A wrong one is removed '
  'with a reason rather than unlinked, because §3.6 will not let the record '
  'itself be edited and erasing the link would erase the fact that an invoice '
  'was once filed against a signed record.';

COMMENT ON COLUMN public.attachments.aircraft_document_id IS
  'The §3.2 document this is a file of. The document row is written first and '
  'carries the metadata; this names it, the same way a photograph names its '
  'squawk. One document can have several files — a two-page certificate.';

-- ---------------------------------------------------------------------------
-- A document coming due is something to be told about
--
-- `notifications` (0036) constrains both its kind and its subject type, which
-- is what makes the feed readable rather than a bag of strings. Both widen by
-- one value.
--
-- One kind and not two: "expiring" covers before and after, the body carries
-- the date, and two kinds would be two crossings to deduplicate for one
-- renewal.
-- ---------------------------------------------------------------------------

ALTER TABLE public.notifications
  DROP CONSTRAINT notifications_kind_check,
  ADD  CONSTRAINT notifications_kind_check CHECK (kind IN (
    'maintenance_upcoming', 'maintenance_due_soon', 'maintenance_overdue',
    'aircraft_grounded', 'aircraft_returned', 'booking_needs_review',
    'squawk_filed', 'document_expiring'));

ALTER TABLE public.notifications
  DROP CONSTRAINT notifications_subject_type_check,
  ADD  CONSTRAINT notifications_subject_type_check CHECK (
    subject_type IS NULL OR subject_type IN
      ('maintenance_item', 'aircraft', 'reservation', 'squawk',
       'aircraft_document'));
