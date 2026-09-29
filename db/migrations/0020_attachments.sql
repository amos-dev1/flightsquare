-- ===========================================================================
-- 0020_attachments.sql — §3.8's attachments, and the quota that has been
-- priced since 0005 without anything counting it
--
-- 0006 said why this table did not exist yet: "It is a table of pointers into
-- object storage, and there is no object storage yet; rows describing
-- attachments that cannot exist would be pre-building. It arrives with
-- `attachments` (§3.8)." There is object storage now, so here it is.
--
-- Photographs of a defect, to begin with. Not called `squawk_photos` on
-- purpose: §3.2's `aircraft_documents` — airworthiness certificate,
-- registration, insurance, weight and balance — is the same shape and arrives
-- against the same table, which is why `squawk_id` is nullable and the row
-- describes a stored object rather than a kind of picture.
--
-- **The bytes are not here.** A row is a pointer: bucket key, declared type,
-- size. §3.8 says "object-store pointers, tenant-scoped metadata", and the
-- API never handles the bytes at all — it signs a URL and the device uploads
-- to storage directly.
--
-- ---------------------------------------------------------------------------
-- `storage.bytes` stops being fictional
--
-- 0005 gave every plan a storage limit (1 GiB free, 25 GiB pro) and nothing
-- has ever counted a byte, which is why /entitlements returns that quota with
-- a limit and no `current`. `refresh_attachments_usage` is the third member
-- of §2.3's `refresh_*_usage` family — and the constitution is explicit that
-- a new member is "an instance of a decision already taken rather than a new
-- one": one quota key, one table, reachable only as a trigger, so the
-- application can read its own counter and never write it.
--
-- It sums `byte_size`, not a row count, which is the only difference from its
-- two siblings.
--
-- ---------------------------------------------------------------------------
-- §7.2: content, not metadata
--
-- No `admin_read` policy, deliberately, matching `squawks` in 0008. A
-- photograph of a cracked bracket is not less sensitive than the sentence
-- describing it, and §7.2 puts the squawk log on the protected side of the
-- control-plane split — "after a GA accident, the squawk log, deferral
-- history, and compliance records are discoverable and get subpoenaed".
-- `db/tests/030` defaults to deny, so saying nothing here is saying no.
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

CREATE TABLE public.attachments (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id   uuid NOT NULL REFERENCES public.tenants(id),

  -- What it is attached to. Nullable because §3.2's aircraft documents land
  -- on this table too, and a composite key so a row can never point at
  -- another tenant's squawk.
  squawk_id   uuid,

  -- Where the bytes are. Unique because two rows pointing at one object means
  -- deleting either one orphans or destroys the other's.
  storage_key text NOT NULL UNIQUE,

  content_type text NOT NULL,
  -- What the client said before uploading, replaced by what storage actually
  -- received once the upload completes. The quota counts this column, so it
  -- being a declaration until then is the reason `uploaded_at` exists.
  byte_size   bigint NOT NULL CHECK (byte_size >= 0),

  uploaded_by uuid,
  uploaded_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT attachments_squawk_fkey
    FOREIGN KEY (tenant_id, squawk_id) REFERENCES public.squawks (tenant_id, id),
  -- §6.1 item 1 is the tenant column; this is what lets anything else
  -- reference a row of this table without leaving its tenant.
  CONSTRAINT attachments_tenant_id_key UNIQUE (tenant_id, id)
);

-- §6.1 item 4: an index leading with tenant_id.
CREATE INDEX attachments_squawk_idx
  ON public.attachments (tenant_id, squawk_id, created_at DESC)
  WHERE squawk_id IS NOT NULL;

COMMENT ON TABLE public.attachments IS
  'Pointers into object storage (§3.8). The bytes are not in the database and '
  'never pass through the API: it signs a URL and the device uploads to '
  'storage directly. Content tier (§7.2) — no admin_read policy.';

-- ---------------------------------------------------------------------------
-- Isolation (§1.1, §6.1)
-- ---------------------------------------------------------------------------

ALTER TABLE public.attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attachments FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.attachments
  FOR ALL TO app_role, flightsquare_owner
  USING      (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

-- No DELETE: an attachment naming an object that has been uploaded is a
-- pointer somebody has to go and clean up, and §3.6 keeps the squawk log
-- append-only anyway. Removing one is a later decision with a storage story
-- attached.
GRANT SELECT, INSERT ON public.attachments TO app_role;
-- Completing an upload records what storage actually received.
GRANT UPDATE (byte_size, uploaded_at) ON public.attachments TO app_role;

-- ---------------------------------------------------------------------------
-- The counter (§2.3, §4.5)
-- ---------------------------------------------------------------------------

CREATE FUNCTION public.refresh_attachments_usage()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET app.auth_bootstrap = 'usage'
AS $$
DECLARE v_tenant uuid := coalesce(NEW.tenant_id, OLD.tenant_id);
BEGIN
  INSERT INTO public.tenant_usage AS u (tenant_id, quota_key, current_value)
  VALUES (v_tenant, 'storage.bytes',
          -- Only what has actually arrived. A row whose upload was signed and
          -- never completed is a declaration, and charging a club for bytes
          -- that were never sent is the kind of thing nobody can explain.
          (SELECT coalesce(sum(a.byte_size), 0) FROM public.attachments a
            WHERE a.tenant_id = v_tenant
              AND a.uploaded_at IS NOT NULL))
  ON CONFLICT (tenant_id, quota_key)
  DO UPDATE SET current_value = EXCLUDED.current_value, updated_at = now();
  RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION public.refresh_attachments_usage() FROM PUBLIC;

CREATE TRIGGER attachments_refresh_usage
  AFTER INSERT OR UPDATE OR DELETE ON public.attachments
  FOR EACH ROW EXECUTE FUNCTION public.refresh_attachments_usage();

COMMENT ON FUNCTION public.refresh_attachments_usage() IS
  '§2.3 privileged helper, third of the refresh_*_usage family. Writes '
  'tenant_usage, which app_role may read and must not write — a role that '
  'can set its own counter to zero walks past every quota.';
