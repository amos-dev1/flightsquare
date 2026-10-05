-- ===========================================================================
-- 0036_notifications.sql — the feed §3.8 named and nothing ever built
--
-- §3.8 lists `notifications  per-user, per-tenant` among the cross-cutting
-- tables and that is as far as it got. Everything since has gone through
-- `outbox`, which is a send queue: no tenant, no membership, no read state, and
-- a CHECK-constrained `kind` that needs a migration to extend. It answers "has
-- this been emailed", which is a different question from "has this person seen
-- it".
--
-- Mockup 01 has a bell with a dot on it. This is what is behind the dot.
--
-- ---------------------------------------------------------------------------
-- Per membership, not per user
--
-- A user can belong to several clubs (§3.1), and a notice about an annual
-- coming due belongs to one of them. Keying on membership means a club's
-- notices arrive in that club and nowhere else, and that removing somebody from
-- a club takes their notices with them.
--
-- ---------------------------------------------------------------------------
-- Push is not here
--
-- §9 asks for push and in-app. `device_registrations` has existed since 0004
-- with no code behind it, and push brings APNs credentials, token lifecycle and
-- permission prompts — its own piece of work with its own failure modes. This
-- is the half that can be built without any of that, and the half the mockup
-- actually draws.
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

CREATE TABLE public.notifications (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id     uuid NOT NULL REFERENCES public.tenants(id),
  membership_id uuid NOT NULL,

  kind          text NOT NULL,
  title         text NOT NULL,
  body          text,

  /*
    Where it points. A notice a pilot cannot act on is a notice that trains
    them to ignore the bell, so every one of these can be opened — and the
    target is stored as a kind and an id rather than a path, because a path
    compiled into a row outlives the client that could route it (§8.1).
  */
  subject_type  text,
  subject_id    uuid,

  read_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT notifications_membership_fkey
    FOREIGN KEY (tenant_id, membership_id)
    REFERENCES public.memberships (tenant_id, id),
  CONSTRAINT notifications_tenant_id_key UNIQUE (tenant_id, id),

  CONSTRAINT notifications_kind_check CHECK (kind IN (
    'maintenance_upcoming', 'maintenance_due_soon', 'maintenance_overdue',
    'aircraft_grounded', 'aircraft_returned', 'booking_needs_review',
    'squawk_filed')),
  CONSTRAINT notifications_subject_check CHECK (
    (subject_type IS NULL) = (subject_id IS NULL)),
  CONSTRAINT notifications_subject_type_check CHECK (
    subject_type IS NULL OR subject_type IN
      ('maintenance_item', 'aircraft', 'reservation', 'squawk'))
);

-- What the bell asks for: this member's unread, newest first.
CREATE INDEX notifications_unread_idx
  ON public.notifications (tenant_id, membership_id, created_at DESC)
  WHERE read_at IS NULL;

CREATE INDEX notifications_member_idx
  ON public.notifications (tenant_id, membership_id, created_at DESC);

COMMENT ON TABLE public.notifications IS
  'The in-app feed §3.8 named: per membership, per tenant, with a read state. '
  '`outbox` is a send queue and answers a different question — whether '
  'something was emailed, not whether anybody saw it.';

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications FORCE  ROW LEVEL SECURITY;

/*
  Readable only by the member it belongs to.

  Tenant isolation is not enough here. A notice is addressed to one person, and
  §4.4's scope dimension exists for exactly this — `app.current_membership_id()`
  is the same predicate `app.owns_row` would apply, written directly because
  there is no level at which somebody else's notifications are anybody's
  business.
*/
CREATE POLICY own_notifications ON public.notifications
  FOR ALL TO app_role
  USING      (tenant_id = app.current_tenant_id()
              AND membership_id = app.current_membership_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

-- The sweep and the write paths insert for other people, which the policy above
-- would refuse — so the owner keeps a policy of its own for the definer
-- function below, and `app_role` may only ever read its own.
CREATE POLICY definer_notify ON public.notifications
  FOR ALL TO flightsquare_owner
  USING      (current_setting('app.auth_bootstrap', true) = 'notify')
  WITH CHECK (current_setting('app.auth_bootstrap', true) = 'notify');

GRANT SELECT ON public.notifications TO app_role;
-- Marking one read is the only write a member makes to their own feed.
GRANT UPDATE (read_at) ON public.notifications TO app_role;

/*
  §2.3 privileged helper: writing a notice to somebody else.

  The application must not hold INSERT on this table. A role that can write
  another member's feed can write anything into it — "your annual is fine" over
  the top of a notice saying it is not — and the feed is the one surface a pilot
  reads before deciding whether to fly.

  It derives the tenant from context and never from an argument (§2.3 rule 2),
  so it cannot be aimed at another club.
*/
CREATE FUNCTION public.notify_member(
  p_membership_id uuid,
  p_kind          text,
  p_title         text,
  p_body          text DEFAULT NULL,
  p_subject_type  text DEFAULT NULL,
  p_subject_id    uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_prev text := current_setting('app.auth_bootstrap', true);
  v_tenant uuid := app.current_tenant_id();
  v_id     uuid;
BEGIN
  PERFORM set_config('app.auth_bootstrap', 'notify', true);

  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'notify_member requires tenant context'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- The membership has to be in this tenant. The composite foreign key would
  -- catch it, but a sentence beats a constraint violation surfacing as a 500.
  IF NOT EXISTS (SELECT 1 FROM public.memberships m
                  WHERE m.id = p_membership_id AND m.tenant_id = v_tenant) THEN
    RAISE EXCEPTION 'that member is not in this tenant'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO public.notifications
    (tenant_id, membership_id, kind, title, body, subject_type, subject_id)
  VALUES (v_tenant, p_membership_id, p_kind, p_title, p_body,
          p_subject_type, p_subject_id)
  RETURNING id INTO v_id;

  PERFORM set_config('app.auth_bootstrap', coalesce(v_prev, ''), true);
  RETURN v_id;
END
$$;

COMMENT ON FUNCTION public.notify_member(uuid, text, text, text, text, uuid) IS
  '§2.3 privileged helper. Holds the INSERT on `notifications` that app_role '
  'must not: a role that can write another member''s feed can write over a '
  'notice saying the aeroplane is grounded. Tenant from context, never an '
  'argument.';

REVOKE ALL ON FUNCTION public.notify_member(uuid, text, text, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.notify_member(uuid, text, text, text, text, uuid) TO app_role;
