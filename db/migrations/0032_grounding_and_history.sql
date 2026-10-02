-- ===========================================================================
-- 0032_grounding_and_history.sql — the override, and what was changed when
--
-- Two things SPEC §4.5 and §7 ask for that genuinely do not exist.
--
-- ---------------------------------------------------------------------------
-- The override
--
-- `aircraft_availability` has always resolved three causes into one answer, and
-- has never had a way to say "yes, and we are flying it anyway". §4.5 gives the
-- admin one, with conditions: a typed reason, an expiry, logged, and visible on
-- the aircraft card. It is not a setting — it is an event with an end.
--
-- **It covers maintenance items and not squawks.** A squawk already has the
-- right mechanism: 14 CFR 91.213 and an MEL, which `squawk_deferrals` records
-- and which the availability view already honours. Overriding a reported defect
-- through a second, weaker door would be a way around the deferral rather than
-- an addition to it. An overdue inspection is the case where an owner and their
-- mechanic may reasonably disagree with a date the app computed, and that is
-- what this is for.
--
-- ---------------------------------------------------------------------------
-- The history
--
-- §7's `item_history`: actor, action, before, after. A trigger rather than
-- something the API remembers to call, for the same reason the usage counters
-- are triggers — an edit that does not reach the log is an edit nobody can
-- account for, and the one path that forgets is the one that matters.
--
-- Append-only in the grants, like `compliance_records` and `squawk_deferrals`.
-- §3.6 is explicit that maintenance records are read back after an accident.
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
-- Grounding events
-- ---------------------------------------------------------------------------

CREATE TABLE public.maintenance_grounding_events (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id   uuid NOT NULL REFERENCES public.tenants(id),
  aircraft_id uuid NOT NULL,

  -- Why the aeroplane is down. `manual` is an admin grounding it outright,
  -- which is `aircraft.status` today and is recorded here so the three causes
  -- have one log between them.
  cause       text NOT NULL,
  maintenance_item_id uuid,

  started_at  timestamptz NOT NULL DEFAULT now(),
  cleared_at  timestamptz,

  /*
    §4.5's override: a reason somebody typed and a time it stops.

    Both or neither. An override with no expiry is a grounding switched off,
    which is the thing this must not become — the aeroplane has to come back to
    the honest answer by itself, without anybody remembering.
  */
  override_reason text,
  override_until  timestamptz,
  override_by     uuid,

  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT maintenance_grounding_events_aircraft_fkey
    FOREIGN KEY (tenant_id, aircraft_id) REFERENCES public.aircraft (tenant_id, id),
  CONSTRAINT maintenance_grounding_events_item_fkey
    FOREIGN KEY (tenant_id, maintenance_item_id)
    REFERENCES public.maintenance_items (tenant_id, id),
  CONSTRAINT maintenance_grounding_events_by_fkey
    FOREIGN KEY (tenant_id, override_by) REFERENCES public.memberships (tenant_id, id),
  CONSTRAINT maintenance_grounding_events_tenant_id_key UNIQUE (tenant_id, id),

  CONSTRAINT maintenance_grounding_events_cause_check
    CHECK (cause IN ('item', 'squawk', 'manual')),
  CONSTRAINT maintenance_grounding_events_item_cause_check
    CHECK ((cause = 'item') = (maintenance_item_id IS NOT NULL)),
  -- A reason without an end, or an end without a reason, is half an override.
  CONSTRAINT maintenance_grounding_events_override_check
    CHECK (num_nonnulls(override_reason, override_until, override_by) IN (0, 3))
);

-- §6.1 item 4, and the shape the availability view reads: the live override for
-- one aeroplane.
CREATE INDEX maintenance_grounding_events_live_idx
  ON public.maintenance_grounding_events (tenant_id, aircraft_id, override_until DESC)
  WHERE cleared_at IS NULL AND override_until IS NOT NULL;

COMMENT ON TABLE public.maintenance_grounding_events IS
  '§4.5: why an aeroplane is down, and the admin override that lets it fly '
  'anyway — a typed reason and an expiry, never a switch. Squawks are not '
  'overridden here; 91.213 and `squawk_deferrals` are their mechanism.';

ALTER TABLE public.maintenance_grounding_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.maintenance_grounding_events FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.maintenance_grounding_events
  FOR ALL TO app_role, flightsquare_owner
  USING      (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

-- An override is a decision somebody made on a date. Clearing it early is an
-- UPDATE of `cleared_at`; nothing is deleted and nothing is rewritten.
GRANT SELECT, INSERT ON public.maintenance_grounding_events TO app_role;
GRANT UPDATE (cleared_at) ON public.maintenance_grounding_events TO app_role;

-- ---------------------------------------------------------------------------
-- Item history
-- ---------------------------------------------------------------------------

CREATE TABLE public.maintenance_item_history (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id   uuid NOT NULL REFERENCES public.tenants(id),
  maintenance_item_id uuid NOT NULL,

  -- Who, as a membership. Null when nobody did it: the roll-forward that
  -- follows a completion is the database's doing, and saying a person did it
  -- would be worse than saying nothing.
  actor       uuid,
  action      text NOT NULL,
  before      jsonb,
  after       jsonb,
  at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT maintenance_item_history_item_fkey
    FOREIGN KEY (tenant_id, maintenance_item_id)
    REFERENCES public.maintenance_items (tenant_id, id),
  CONSTRAINT maintenance_item_history_actor_fkey
    FOREIGN KEY (tenant_id, actor) REFERENCES public.memberships (tenant_id, id),
  CONSTRAINT maintenance_item_history_action_check
    CHECK (action IN ('created', 'edited', 'archived', 'restored', 'rolled_forward'))
);

CREATE INDEX maintenance_item_history_item_idx
  ON public.maintenance_item_history (tenant_id, maintenance_item_id, at DESC);

COMMENT ON TABLE public.maintenance_item_history IS
  '§7: what changed on an item, by whom, when. Append-only — §3.6 makes '
  'maintenance records something read back after an accident, and an edit log '
  'that can be edited is not one.';

ALTER TABLE public.maintenance_item_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.maintenance_item_history FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.maintenance_item_history
  FOR ALL TO app_role, flightsquare_owner
  USING      (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

-- Written by the trigger below, read by the item detail. Never updated, never
-- deleted — the same grant `compliance_records` and `squawk_deferrals` carry.
GRANT SELECT, INSERT ON public.maintenance_item_history TO app_role;

/*
  The log writes itself.

  A trigger rather than a call the API makes, for the same reason the usage
  counters are triggers: the path that forgets is the one that matters, and an
  edit that never reached the log is an edit nobody can account for.

  `rolled_forward` is kept separate from `edited` because they are different
  claims. A person changed the interval; the database moved the due date because
  a completion landed. Collapsing them would make the log read as though
  somebody edited an annual every time one was signed off.
*/
CREATE FUNCTION public.record_maintenance_item_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_action text;
  v_actor  uuid := app.current_membership_id();
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.maintenance_item_history
      (tenant_id, maintenance_item_id, actor, action, after)
    VALUES (NEW.tenant_id, NEW.id, v_actor, 'created', to_jsonb(NEW));
    RETURN NULL;
  END IF;

  -- Nothing anybody would want to read back.
  IF to_jsonb(OLD) - 'updated_at' = to_jsonb(NEW) - 'updated_at' THEN
    RETURN NULL;
  END IF;

  v_action := CASE
    WHEN OLD.status = 'active'   AND NEW.status = 'archived' THEN 'archived'
    WHEN OLD.status = 'archived' AND NEW.status = 'active'   THEN 'restored'
    -- The compliance trigger moves the anchor and the due points and touches
    -- nothing else. That is the database doing arithmetic, not a person
    -- changing their mind about an interval.
    WHEN OLD.last_complied_on IS DISTINCT FROM NEW.last_complied_on
      OR OLD.last_complied_hours IS DISTINCT FROM NEW.last_complied_hours
      THEN 'rolled_forward'
    ELSE 'edited'
  END;

  INSERT INTO public.maintenance_item_history
    (tenant_id, maintenance_item_id, actor, action, before, after)
  VALUES (NEW.tenant_id, NEW.id,
          CASE WHEN v_action = 'rolled_forward' THEN NULL ELSE v_actor END,
          v_action, to_jsonb(OLD), to_jsonb(NEW));
  RETURN NULL;
END
$$;

CREATE TRIGGER maintenance_items_record_change
  AFTER INSERT OR UPDATE ON public.maintenance_items
  FOR EACH ROW EXECUTE FUNCTION public.record_maintenance_item_change();

-- ---------------------------------------------------------------------------
-- Availability honours a live override
--
-- Replaced, not dropped: the column list is unchanged, so the booking trigger
-- and `GET /availability` never lose sight of it.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.aircraft_availability
WITH (security_invoker = true) AS
SELECT
  a.id        AS aircraft_id,
  a.tenant_id,
  a.registration,
  a.status    AS aircraft_status,
  g.count     AS grounding_squawks,
  -- Overdue items that are still grounding it. An override does not make the
  -- item not overdue — the maintenance screen goes on saying so — it makes the
  -- aeroplane bookable despite it.
  CASE WHEN ov.until IS NULL THEN o.count ELSE 0 END AS overdue_grounding_items,
  (a.status = 'active' AND g.count = 0
     AND (o.count = 0 OR ov.until IS NOT NULL)) AS available,
  array_remove(
    ARRAY[CASE
            WHEN a.status = 'grounded' THEN 'Grounded by an administrator'
            WHEN a.status <> 'active'  THEN format('Aircraft is %s', a.status)
          END],
    NULL)
  || g.reasons
  -- The reasons stay either way. A club calling a member needs to be able to
  -- say what was overridden and until when, not just that it was.
  || CASE WHEN ov.until IS NULL THEN o.reasons
          ELSE ARRAY[format('Override until %s: %s',
                            to_char(ov.until, 'YYYY-MM-DD HH24:MI'), ov.reason)]
               || o.reasons
     END AS grounding_reasons
FROM public.aircraft a
CROSS JOIN LATERAL (
  SELECT count(*) AS count,
         coalesce(array_agg(format('Grounding squawk: %s', s.summary)
                            ORDER BY s.reported_at), ARRAY[]::text[]) AS reasons
    FROM public.squawks s
   WHERE s.aircraft_id = a.id
     AND s.grounding
     -- A deferral is the decision that it may fly with the defect — that is
     -- what an MEL and 91.213 are for — so only 'open' grounds. A squawk is
     -- never overridden by §4.5; it is deferred, which is the same decision
     -- made the way the regulation describes.
     AND s.status = 'open'
) AS g
CROSS JOIN LATERAL (
  SELECT count(*) AS count,
         coalesce(array_agg(format(CASE WHEN mis.ever_complied
                                        THEN 'Overdue: %s'
                                        ELSE 'Not recorded: %s' END, mis.name)
                            ORDER BY mis.name), ARRAY[]::text[]) AS reasons
    FROM public.maintenance_item_status mis
   WHERE mis.aircraft_id = a.id
     AND mis.grounds_aircraft
     AND mis.state = 'overdue'
) AS o
CROSS JOIN LATERAL (
  -- The live override, if there is one. It expires by itself: nobody has to
  -- remember to take it off, which is the whole reason `override_until` is
  -- required rather than optional.
  SELECT e.override_until AS until, e.override_reason AS reason
    FROM public.maintenance_grounding_events e
   WHERE e.aircraft_id = a.id
     AND e.cleared_at IS NULL
     AND e.override_until IS NOT NULL
     AND e.override_until > now()
   ORDER BY e.override_until DESC
   LIMIT 1
) AS ov;

COMMENT ON VIEW public.aircraft_availability IS
  '§3.3: the one place that decides whether an aircraft may be booked. Three '
  'ways in — an admin''s grounding, a grounding squawk, an overdue inspection '
  '— one answer out (§6.2), and §4.5''s override, which expires by itself.';
