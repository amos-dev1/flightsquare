-- ===========================================================================
-- 0012_scheduling.sql — M5: booking the aeroplane
--
-- §3.3, and the two sentences in it that decide the whole shape:
--
--   "A reservation holds resource lines, not a single `aircraft_id`. Today
--    every reservation has exactly one line, of type `aircraft`. This looks
--    like pointless indirection and is the single most valuable twenty lines
--    in the schema: when instructors arrive, an instructor is another
--    `resource_type`, a lesson booking is a reservation with two lines, and
--    the conflict query does not change."
--
--   "Conflict detection is a database-level exclusion constraint... not an
--    application `SELECT`-then-`INSERT`. Two members hitting Book at the same
--    moment is the normal case for a club with one popular aircraft on a
--    Saturday, and application-level checking loses that race."
--
-- Table classes (§2.2): all tenant-scoped.
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

-- An exclusion constraint that also matches on tenant and resource id needs
-- equality operators in a GiST index, which is what this provides. Trusted
-- since PostgreSQL 13, so the owner can install it without a superuser.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ===========================================================================
-- Who may book what (§3.5)
--
-- "member_aircraft_authorizations stays regardless. It is the club and
--  partnership checkout rule — 'is Dave signed off in the 182?' — it gates
--  booking, and it is about the aircraft, not the pilot's résumé."
--
-- Note what is *not* here: no certificate numbers, no ratings, no history,
-- no hours. §3.4's boundary holds — this records that somebody may fly a
-- particular aeroplane, and nothing about them.
-- ===========================================================================

CREATE TABLE public.member_aircraft_authorizations (
  tenant_id      uuid NOT NULL REFERENCES public.tenants(id),
  membership_id  uuid NOT NULL,
  aircraft_id    uuid NOT NULL,
  authorized_on  date NOT NULL DEFAULT current_date,
  authorized_by  uuid,
  note           text,
  created_at     timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, membership_id, aircraft_id),

  CONSTRAINT member_aircraft_authorizations_member_fkey
    FOREIGN KEY (tenant_id, membership_id)
    REFERENCES public.memberships (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT member_aircraft_authorizations_aircraft_fkey
    FOREIGN KEY (tenant_id, aircraft_id)
    REFERENCES public.aircraft (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT member_aircraft_authorizations_by_fkey
    FOREIGN KEY (tenant_id, authorized_by)
    REFERENCES public.memberships (tenant_id, id)
);

CREATE INDEX member_aircraft_authorizations_aircraft_idx
  ON public.member_aircraft_authorizations (tenant_id, aircraft_id);

-- ===========================================================================
-- reservations, and the blackouts that share their calendar
-- ===========================================================================

CREATE TABLE public.reservations (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id     uuid NOT NULL REFERENCES public.tenants(id),

  /** The member who has the aeroplane, and who will be flying it. */
  booked_by     uuid NOT NULL,
  purpose       text,
  notes         text,

  starts_at     timestamptz NOT NULL,
  ends_at       timestamptz NOT NULL,

  status        text NOT NULL DEFAULT 'booked',

  -- §3.3: "Existing future reservations are flagged for review, not silently
  -- cancelled; the club needs to call those members." This is that flag. It
  -- is never a cancellation, and nothing acts on it but a person.
  needs_review  boolean NOT NULL DEFAULT false,
  review_reason text,

  cancelled_at  timestamptz,
  cancelled_by  uuid,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT reservations_status_check
    CHECK (status IN ('booked', 'cancelled', 'completed')),
  CONSTRAINT reservations_order_check CHECK (ends_at > starts_at),
  CONSTRAINT reservations_cancelled_consistency_check
    CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  CONSTRAINT reservations_booked_by_fkey
    FOREIGN KEY (tenant_id, booked_by)
    REFERENCES public.memberships (tenant_id, id),
  CONSTRAINT reservations_cancelled_by_fkey
    FOREIGN KEY (tenant_id, cancelled_by)
    REFERENCES public.memberships (tenant_id, id),
  CONSTRAINT reservations_tenant_id_key UNIQUE (tenant_id, id)
);

CREATE INDEX reservations_tenant_window_idx
  ON public.reservations (tenant_id, starts_at)
  WHERE status = 'booked';
CREATE INDEX reservations_member_idx
  ON public.reservations (tenant_id, booked_by, starts_at DESC);

CREATE TRIGGER reservations_set_updated_at BEFORE UPDATE ON public.reservations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

/**
 * An admin taking the aeroplane off the calendar: an annual, an AOG, a month
 * the owner wants it back.
 *
 * Its own table because it is its own thing — nobody is flying, and there is
 * no member to call — but it competes for exactly the same time, so its
 * lines live in the same space as a booking's. That is what makes one
 * constraint enough.
 */
CREATE TABLE public.blackouts (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id   uuid NOT NULL REFERENCES public.tenants(id),
  aircraft_id uuid NOT NULL,

  reason      text NOT NULL,
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz NOT NULL,

  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT blackouts_order_check CHECK (ends_at > starts_at),
  CONSTRAINT blackouts_aircraft_fkey
    FOREIGN KEY (tenant_id, aircraft_id)
    REFERENCES public.aircraft (tenant_id, id),
  CONSTRAINT blackouts_tenant_id_key UNIQUE (tenant_id, id)
);

CREATE INDEX blackouts_aircraft_idx
  ON public.blackouts (tenant_id, aircraft_id, starts_at);

CREATE TRIGGER blackouts_set_updated_at BEFORE UPDATE ON public.blackouts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ===========================================================================
-- The lines, and the constraint that is the point of them
--
-- One row per thing a booking holds. Today that is always exactly one row of
-- type 'aircraft', which looks like indirection for its own sake — until an
-- instructor is a second `resource_type`, a lesson is a reservation with two
-- lines, and none of the code below changes.
--
-- Two things are copied onto the line rather than read through the parent,
-- and both are for the same reason: **an exclusion constraint can only see
-- columns of its own table.**
--
--   `during`   the reservation's window, kept in step by the trigger below.
--   `blocking` false once cancelled, so a cancelled booking stops holding
--              the slot without the row being deleted and the history lost.
--
-- Same bargain as `tenant_id` on every child table in this schema: the
-- denormalisation is what makes the guarantee expressible, and a trigger is
-- what keeps it honest.
-- ===========================================================================

CREATE TABLE public.reservation_resources (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id      uuid NOT NULL REFERENCES public.tenants(id),

  -- Exactly one holder. A blackout is not a reservation — nobody is flying
  -- and there is nobody to call — but it competes for the same hours, and
  -- one overlap space is what lets one constraint decide all of it.
  reservation_id uuid,
  blackout_id    uuid,

  resource_type  text NOT NULL,
  resource_id    uuid NOT NULL,

  during         tstzrange NOT NULL,
  blocking       boolean NOT NULL DEFAULT true,

  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT reservation_resources_one_holder_check
    CHECK (num_nonnulls(reservation_id, blackout_id) = 1),
  CONSTRAINT reservation_resources_type_check
    CHECK (resource_type IN ('aircraft')),
  CONSTRAINT reservation_resources_reservation_fkey
    FOREIGN KEY (tenant_id, reservation_id)
    REFERENCES public.reservations (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT reservation_resources_blackout_fkey
    FOREIGN KEY (tenant_id, blackout_id)
    REFERENCES public.blackouts (tenant_id, id) ON DELETE CASCADE,

  /**
   * §3.3, and the reason this is a constraint rather than a query.
   *
   * Two members hitting Book at the same moment is the normal case for a
   * club with one popular aircraft on a Saturday. A SELECT-then-INSERT loses
   * that race silently and double-books the aeroplane; this cannot, because
   * the second transaction is refused by the index itself.
   *
   * Scoped by tenant as well as resource: §3.2 lets two tenants track the
   * same tail number — the leaseback case — and their calendars are no more
   * related than their maintenance records.
   */
  CONSTRAINT reservation_resources_no_overlap
    EXCLUDE USING gist (
      tenant_id     WITH =,
      resource_type WITH =,
      resource_id   WITH =,
      during        WITH &&
    ) WHERE (blocking)
);

-- ---------------------------------------------------------------------------
-- A Pilot's reservations become `own`
--
-- §4.4's third dimension, applied to its second resource. Everything else a
-- pilot holds stays `all` — the club's flights, squawks and maintenance are
-- shared by design — and the calendar stays readable by everyone, because
-- the policies above scope the writing and not the reading.
-- ---------------------------------------------------------------------------
SET LOCAL app.auth_bootstrap = 'on';

DO $backfill$
DECLARE t record;
BEGIN
  FOR t IN SELECT id FROM public.tenants ORDER BY id LOOP
    PERFORM set_config('app.tenant_id', t.id::text, true);

    UPDATE public.role_bundle_permissions p
       SET scope = 'own'
      FROM public.role_bundles b
     WHERE b.tenant_id = p.tenant_id
       AND b.id = p.role_bundle_id
       AND p.tenant_id = t.id
       AND p.resource = 'reservations'
       AND b.code = 'pilot'
       AND b.is_default;
  END LOOP;

  PERFORM set_config('app.tenant_id', '', true);
END
$backfill$;

RESET app.auth_bootstrap;

CREATE OR REPLACE FUNCTION public.seed_default_role_bundles(p_tenant_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_admin_id uuid;
  v_pilot_id uuid;
BEGIN
  INSERT INTO public.role_bundles (tenant_id, code, name, is_default)
  VALUES (p_tenant_id, 'admin', 'Admin', true)
  RETURNING id INTO v_admin_id;

  INSERT INTO public.role_bundles (tenant_id, code, name, is_default)
  VALUES (p_tenant_id, 'pilot', 'Pilot', true)
  RETURNING id INTO v_pilot_id;

  INSERT INTO public.role_bundle_permissions
    (tenant_id, role_bundle_id, resource, level, scope)
  VALUES
    (p_tenant_id, v_admin_id, 'aircraft',       'write', 'all'),
    (p_tenant_id, v_admin_id, 'reservations',   'write', 'all'),
    (p_tenant_id, v_admin_id, 'flights',        'write', 'all'),
    (p_tenant_id, v_admin_id, 'squawks',        'write', 'all'),
    (p_tenant_id, v_admin_id, 'maintenance',    'write', 'all'),
    (p_tenant_id, v_admin_id, 'rates',          'write', 'all'),
    (p_tenant_id, v_admin_id, 'charges',        'write', 'all'),
    (p_tenant_id, v_admin_id, 'qualifications', 'write', 'all'),
    (p_tenant_id, v_admin_id, 'documents',      'write', 'all'),
    (p_tenant_id, v_admin_id, 'members',        'write', 'all'),
    (p_tenant_id, v_admin_id, 'subscription',   'write', 'all'),
    (p_tenant_id, v_admin_id, 'settings',       'write', 'all'),

    -- A pilot reports defects but does not close them, books and flies but
    -- does not set rates, and sees the fleet without editing it.
    (p_tenant_id, v_pilot_id, 'aircraft',       'read',  'all'),
    -- Books for themselves. The calendar is still read by everyone: the
    -- policies on `reservations` scope the writing, not the reading.
    (p_tenant_id, v_pilot_id, 'reservations',   'write', 'own'),
    (p_tenant_id, v_pilot_id, 'flights',        'write', 'all'),
    (p_tenant_id, v_pilot_id, 'squawks',        'write', 'all'),
    (p_tenant_id, v_pilot_id, 'maintenance',    'read',  'all'),
    (p_tenant_id, v_pilot_id, 'rates',          'read',  'all'),
    -- §10 decision 3: a pilot reads their own ledger and no further.
    (p_tenant_id, v_pilot_id, 'charges',        'read',  'own'),
    (p_tenant_id, v_pilot_id, 'qualifications', 'read',  'all'),
    (p_tenant_id, v_pilot_id, 'documents',      'read',  'all'),
    (p_tenant_id, v_pilot_id, 'members',        'none',  'all'),
    (p_tenant_id, v_pilot_id, 'subscription',   'none',  'all'),
    (p_tenant_id, v_pilot_id, 'settings',       'none',  'all');

  RETURN v_admin_id;
END
$$;

CREATE INDEX reservation_resources_resource_idx
  ON public.reservation_resources (tenant_id, resource_type, resource_id);
CREATE INDEX reservation_resources_reservation_idx
  ON public.reservation_resources (tenant_id, reservation_id)
  WHERE reservation_id IS NOT NULL;

-- ===========================================================================
-- Keeping the copies honest
--
-- The line's `during` and `blocking` are the parent's window and status,
-- copied because the constraint cannot reach across tables. So nothing but
-- these triggers ever writes them: move a booking and its lines move,
-- cancel it and they stop blocking.
--
-- Both are §2.3 privileged helpers, and both pass that section's own test —
-- could the application simply be granted what it needs, without also being
-- able to abuse it? **No.** An app_role that could write `during` could move
-- a line off the hours its booking claims, and the exclusion constraint
-- would go on being satisfied while the aeroplane was double-booked. The
-- guarantee would become a suggestion, which is the same answer §2.3 gives
-- for the derived meter totals and for the same reason.
--
-- Triggers, so they get no grant at all: nothing can call them directly.
-- ===========================================================================

CREATE FUNCTION public.sync_reservation_resource_window()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET app.auth_bootstrap = 'schedule'
AS $$
BEGIN
  UPDATE public.reservation_resources r
     SET during   = tstzrange(NEW.starts_at, NEW.ends_at, '[)'),
         blocking = (NEW.status = 'booked')
   WHERE r.reservation_id = NEW.id
     AND (r.during <> tstzrange(NEW.starts_at, NEW.ends_at, '[)')
          OR r.blocking <> (NEW.status = 'booked'));
  RETURN NULL;
END
$$;

-- No grant: a trigger function nothing can call is a door that does not open.
REVOKE ALL ON FUNCTION public.sync_reservation_resource_window() FROM PUBLIC;

CREATE TRIGGER reservations_sync_resources
  AFTER UPDATE ON public.reservations
  FOR EACH ROW EXECUTE FUNCTION public.sync_reservation_resource_window();

CREATE FUNCTION public.sync_blackout_resource_window()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET app.auth_bootstrap = 'schedule'
AS $$
BEGIN
  UPDATE public.reservation_resources r
     SET during = tstzrange(NEW.starts_at, NEW.ends_at, '[)')
   WHERE r.blackout_id = NEW.id
     AND r.during <> tstzrange(NEW.starts_at, NEW.ends_at, '[)');
  RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION public.sync_blackout_resource_window() FROM PUBLIC;

CREATE TRIGGER blackouts_sync_resources
  AFTER UPDATE ON public.blackouts
  FOR EACH ROW EXECUTE FUNCTION public.sync_blackout_resource_window();

-- ===========================================================================
-- What a level is, so a policy or a trigger can ask
--
-- The companion to 0010's `app.permission_scope`. Same shape, same reasons:
-- SECURITY INVOKER, STABLE, reading rows the caller can already read.
-- ===========================================================================

CREATE FUNCTION app.permission_level(p_resource text) RETURNS text
LANGUAGE sql STABLE
AS $$
  SELECT coalesce(
    (SELECT p.level
       FROM public.memberships m
       JOIN public.role_bundle_permissions p
         ON p.tenant_id = m.tenant_id AND p.role_bundle_id = m.role_bundle_id
      WHERE m.user_id = app.current_user_id()
        AND m.tenant_id = app.current_tenant_id()
        AND m.status = 'active'
        AND m.deleted_at IS NULL
        AND p.resource = p_resource),
    'none')
$$;

GRANT EXECUTE ON FUNCTION app.permission_level(text) TO app_role, admin_role;

-- ===========================================================================
-- The two rules a booking has to pass, in the database
--
-- Neither is tenancy, so neither is what §1.1 is about. They are here for
-- §7.4's reason instead: a rule that only exists in a handler is a rule the
-- next handler will not have. Both are checks the application could make and
-- could also forget, and forgetting either one puts somebody in an aeroplane
-- they should not be in.
-- ===========================================================================

CREATE FUNCTION public.assert_booking_is_allowed()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_reservation public.reservations%ROWTYPE;
  v_available   boolean;
  v_reasons     text[];
BEGIN
  -- A blackout is an admin taking the aeroplane away; none of this applies.
  IF NEW.reservation_id IS NULL OR NOT NEW.blocking THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_reservation
    FROM public.reservations WHERE id = NEW.reservation_id;

  -- §3.3: "A grounded aircraft blocks new reservations." Existing ones are a
  -- different question and are flagged rather than cancelled, below.
  SELECT a.available, a.grounding_reasons INTO v_available, v_reasons
    FROM public.aircraft_availability a
   WHERE a.aircraft_id = NEW.resource_id;

  IF v_available IS NOT NULL AND NOT v_available THEN
    RAISE EXCEPTION 'that aircraft is not available: %',
                    array_to_string(v_reasons, '; ')
      USING ERRCODE = 'FS409';
  END IF;

  /**
   * §3.5's checkout rule: "is Dave signed off in the 182?"
   *
   * The question is always about `booked_by` — who will be in the aeroplane
   * — and never about who filled in the form. An admin booking on somebody
   * else's behalf is still putting *them* in it.
   *
   * The one bypass is an admin booking for themselves: they administer the
   * fleet and are the person who grants authorisations, so requiring them to
   * sign themselves off first would be a step that means nothing. Vouching
   * for somebody *else* is exactly what the authorisation row is for, so
   * that is not a step it makes sense to skip.
   */
  IF NOT (v_reservation.booked_by = app.current_membership_id()
          AND app.permission_level('aircraft') = 'write')
     AND NOT EXISTS (
       SELECT 1 FROM public.member_aircraft_authorizations z
        WHERE z.tenant_id = NEW.tenant_id
          AND z.membership_id = v_reservation.booked_by
          AND z.aircraft_id = NEW.resource_id
     ) THEN
    RAISE EXCEPTION 'that member is not signed off in this aircraft'
      USING ERRCODE = 'FS409',
            HINT = 'An administrator can authorise them on the aircraft page.';
  END IF;

  RETURN NULL;
END
$$;

CREATE TRIGGER reservation_resources_check_booking
  AFTER INSERT ON public.reservation_resources
  FOR EACH ROW EXECUTE FUNCTION public.assert_booking_is_allowed();

-- ---------------------------------------------------------------------------
-- §3.3: "Existing future reservations are flagged for review, not silently
-- cancelled; the club needs to call those members."
--
-- Fired by the two things that ground an aircraft at a moment in time: an
-- administrator's decision, and a grounding squawk. The third — an
-- inspection coming due — has no moment to fire on, because it happens when
-- the clock passes a date or a flight passes an hour reading. Nothing here
-- pretends otherwise; the booking screen reads availability alongside, so an
-- aircraft that went overdue is visibly unavailable even where no flag was
-- ever written.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.flag_reservations_for_grounding()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_aircraft uuid;
  v_reason   text;
BEGIN
  IF TG_TABLE_NAME = 'aircraft' THEN
    IF NEW.status = 'active' OR NEW.status = OLD.status THEN RETURN NULL; END IF;
    v_aircraft := NEW.id;
    v_reason := format('The aircraft was marked %s on %s.',
                       NEW.status, to_char(now(), 'FMDD Mon YYYY'));
  ELSE
    IF NOT NEW.grounding OR NEW.status <> 'open' THEN RETURN NULL; END IF;
    v_aircraft := NEW.aircraft_id;
    v_reason := format('Grounded by a squawk on %s: %s',
                       to_char(now(), 'FMDD Mon YYYY'), NEW.summary);
  END IF;

  UPDATE public.reservations r
     SET needs_review = true, review_reason = v_reason
   WHERE r.tenant_id = (CASE WHEN TG_TABLE_NAME = 'aircraft'
                             THEN NEW.tenant_id ELSE NEW.tenant_id END)
     AND r.status = 'booked'
     AND r.starts_at > now()
     AND NOT r.needs_review
     AND EXISTS (
       SELECT 1 FROM public.reservation_resources rr
        WHERE rr.reservation_id = r.id
          AND rr.resource_type = 'aircraft'
          AND rr.resource_id = v_aircraft
     );

  RETURN NULL;
END
$$;

CREATE TRIGGER aircraft_flag_reservations
  AFTER UPDATE OF status ON public.aircraft
  FOR EACH ROW EXECUTE FUNCTION public.flag_reservations_for_grounding();

CREATE TRIGGER squawks_flag_reservations
  AFTER INSERT OR UPDATE OF grounding, status ON public.squawks
  FOR EACH ROW EXECUTE FUNCTION public.flag_reservations_for_grounding();

-- ===========================================================================
-- Row-level security
-- ===========================================================================

ALTER TABLE public.reservations                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reservations                   FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.reservation_resources          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reservation_resources          FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.blackouts                      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blackouts                      FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.member_aircraft_authorizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_aircraft_authorizations FORCE  ROW LEVEL SECURITY;

/**
 * The calendar is read by everyone and written by one person at a time.
 *
 * V1_SCOPE M3: "Edit or cancel your own. Admins can edit or cancel anyone's."
 * That is §4.4's scope dimension doing its second job — and a different job
 * from `charges`, where the scope limits *reads*. Here it limits writes,
 * because a club's calendar that only its owner can see is not a calendar,
 * while a calendar anybody can rewrite is not a booking.
 *
 * Three policies rather than one, and the split is the point: a single
 * `FOR ALL` with a scoped WITH CHECK would let a pilot UPDATE somebody
 * else's booking as long as the *result* named themselves — which is how you
 * steal a Saturday rather than how you keep one.
 */
CREATE POLICY tenant_isolation ON public.reservations
  FOR SELECT TO app_role, flightsquare_owner
  USING (tenant_id = app.current_tenant_id());

CREATE POLICY reservation_own_insert ON public.reservations
  FOR INSERT TO app_role, flightsquare_owner
  WITH CHECK (tenant_id = app.current_tenant_id()
              AND app.owns_row('reservations', booked_by));

CREATE POLICY reservation_own_update ON public.reservations
  FOR UPDATE TO app_role, flightsquare_owner
  -- The row as it stands: whose booking is being changed.
  USING      (tenant_id = app.current_tenant_id()
              AND app.owns_row('reservations', booked_by))
  -- And as it would stand: you cannot hand it to somebody else either.
  WITH CHECK (tenant_id = app.current_tenant_id()
              AND app.owns_row('reservations', booked_by));

CREATE POLICY tenant_isolation ON public.reservation_resources
  FOR ALL TO app_role, flightsquare_owner
  USING      (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

-- The 'schedule' level: what the two sync triggers need, and nothing else.
-- Same shape as 0006's 'meters' and 0005's 'usage' — a named level rather
-- than a policy that trusts any value of the GUC.
CREATE POLICY definer_schedule ON public.reservation_resources
  FOR ALL TO flightsquare_owner
  USING      (current_setting('app.auth_bootstrap', true) = 'schedule')
  WITH CHECK (current_setting('app.auth_bootstrap', true) = 'schedule');

CREATE POLICY tenant_isolation ON public.blackouts
  FOR ALL TO app_role, flightsquare_owner
  USING      (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY tenant_isolation ON public.member_aircraft_authorizations
  FOR ALL TO app_role, flightsquare_owner
  USING      (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

-- §7.2: a calendar says who was where and when, and an authorisation is a
-- statement about an individual's competence. Both are content, and content
-- takes a time-boxed, logged, tenant-consented grant that does not exist yet.
-- Silence here is the correct amount of access.

-- ===========================================================================
-- Privileges
-- ===========================================================================

-- §10: cancelling is a status, so no DELETE anywhere. A cancelled booking is
-- still a thing that happened, and a club arguing about a Saturday needs it.
GRANT SELECT, INSERT ON public.reservations TO app_role;
GRANT UPDATE (starts_at, ends_at, purpose, notes, status,
              needs_review, review_reason, cancelled_at, cancelled_by)
  ON public.reservations TO app_role;

-- The lines are written when a booking is made and moved only by the
-- triggers above. `during` and `blocking` are absent from the grant for the
-- same reason the derived meter totals are (§3.4): if the application could
-- write them, the constraint would be a suggestion.
GRANT SELECT, INSERT, DELETE ON public.reservation_resources TO app_role;

GRANT SELECT, INSERT ON public.blackouts TO app_role;
GRANT UPDATE (reason, starts_at, ends_at) ON public.blackouts TO app_role;
GRANT DELETE ON public.blackouts TO app_role;

-- An authorisation is granted and withdrawn; there is no history to keep
-- that the audit log will not hold better.
GRANT SELECT, INSERT, DELETE ON public.member_aircraft_authorizations TO app_role;
