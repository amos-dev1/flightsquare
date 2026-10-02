-- ===========================================================================
-- 0035_compliance_voids.sql — taking back a completion without rewriting one
--
-- SPEC §4.7: "Completions can be edited or voided (soft, with reason); anchor
-- recomputes from the latest non-voided completion." §13 wants the same thing
-- in one line: "Voiding the latest completion restores the previous anchor."
--
-- CLAUDE.md §3.6 is absolute about how: "Never UPDATE a signed compliance
-- record, and never hard-delete one", and `compliance_records` holds SELECT and
-- INSERT and nothing else, asserted by four tests. So a void cannot be a column
-- on the record.
--
-- ---------------------------------------------------------------------------
-- Why not a superseding row
--
-- §3.6 does prescribe a mechanism — "corrections are new rows referencing the
-- superseded one" — and `supersedes_id` already exists. It is the right shape
-- for *a correction*: the oil change was at 1,225.0, not 1,252.0, here is the
-- row that says so.
--
-- It is the wrong shape for a retraction. `complied_on` is NOT NULL, so a void
-- written as a compliance record has to claim a date on which the work was
-- done, when the whole point is that it was not. The log would then contain a
-- compliance record for an inspection that never happened — in the table §7.2
-- names among the things read back after an accident.
--
-- So a void is its own fact, in its own append-only table, and
-- `compliance_records` stays a list of work that was done.
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

/*
  `compliance_records` never needed a composite key until now: nothing pointed
  at it. §6.1 item 1's pattern — UNIQUE (tenant_id, id) — is what lets another
  tenant-scoped table reference a row without the reference being able to leave
  its tenant, and it is why every other table here carries one.
*/
ALTER TABLE public.compliance_records
  ADD CONSTRAINT compliance_records_tenant_id_key UNIQUE (tenant_id, id);

CREATE TABLE public.compliance_voids (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id  uuid NOT NULL REFERENCES public.tenants(id),
  compliance_record_id uuid NOT NULL,

  -- §4.7 asks for a reason and means one. "mistake" is not a record of why a
  -- signed inspection was taken back.
  reason     text NOT NULL,
  voided_by  uuid NOT NULL,
  voided_at  timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT compliance_voids_record_fkey
    FOREIGN KEY (tenant_id, compliance_record_id)
    REFERENCES public.compliance_records (tenant_id, id),
  CONSTRAINT compliance_voids_by_fkey
    FOREIGN KEY (tenant_id, voided_by) REFERENCES public.memberships (tenant_id, id),
  -- Voiding twice is not twice as void.
  CONSTRAINT compliance_voids_once UNIQUE (tenant_id, compliance_record_id),
  CONSTRAINT compliance_voids_reason_check CHECK (length(btrim(reason)) >= 5)
);

CREATE INDEX compliance_voids_record_idx
  ON public.compliance_voids (tenant_id, compliance_record_id);

COMMENT ON TABLE public.compliance_voids IS
  '§4.7: a completion taken back, with a reason and an actor. Its own table '
  'because `complied_on` is NOT NULL — a void written as a compliance record '
  'would have to claim a date the work was done on, in the table §7.2 names '
  'among what is read back after an accident.';

ALTER TABLE public.compliance_voids ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.compliance_voids FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.compliance_voids
  FOR ALL TO app_role, flightsquare_owner
  USING      (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

-- Append-only, like everything else in this corner of the schema. Changing
-- one's mind about a void is another compliance record, not an edit.
GRANT SELECT, INSERT ON public.compliance_voids TO app_role;

-- ---------------------------------------------------------------------------
-- Rebuild an item from what is left
--
-- Needed because voiding does not fire `apply_compliance_to_item`: that trigger
-- rolls *forward* from the row that just landed, and a void is the opposite
-- motion. This recomputes from scratch — the latest record that is neither
-- superseded nor voided — which is also exactly right after a superseding
-- correction.
-- ---------------------------------------------------------------------------

CREATE FUNCTION public.recompute_item_from_compliance(p_item_id uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_item   public.maintenance_items;
  v_record public.compliance_records;
BEGIN
  SELECT * INTO v_item FROM public.maintenance_items WHERE id = p_item_id;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT c.* INTO v_record
    FROM public.compliance_records c
   WHERE c.maintenance_item_id = p_item_id
     AND NOT EXISTS (SELECT 1 FROM public.compliance_records s
                      WHERE s.supersedes_id = c.id)
     AND NOT EXISTS (SELECT 1 FROM public.compliance_voids v
                      WHERE v.compliance_record_id = c.id)
   ORDER BY c.complied_on DESC, c.recorded_at DESC
   LIMIT 1;

  IF NOT FOUND THEN
    /*
      Nothing left on record.

      The anchors clear and `ever_complied` goes back to false, which is the
      honest state: the app has no idea when this was last done. The rules keep
      their due points — there is nothing to recompute them from, and inventing
      one would be the app asserting a date nobody gave it.
    */
    UPDATE public.maintenance_items
       SET last_complied_on = NULL,
           last_complied_hours = NULL,
           last_complied_cycles = NULL
     WHERE id = p_item_id;
    RETURN;
  END IF;

  UPDATE public.maintenance_item_rules r
     SET due_on        = coalesce(
           CASE WHEN r.kind IN ('cal_month', 'cal_day') THEN v_record.next_due_on END,
           n.due_on, r.due_on),
         due_at_hours  = coalesce(
           CASE WHEN r.kind IN ('tach_hr', 'hobbs_hr', 'airframe_hr')
                THEN v_record.next_due_at_hours END,
           n.due_at_hours, r.due_at_hours),
         due_at_cycles = coalesce(n.due_at_cycles, r.due_at_cycles)
    FROM public.maintenance_item_rules src
    CROSS JOIN LATERAL public.next_due_for(
           src.kind, src.every, src.end_of_month,
           v_record.complied_on, v_record.complied_at_hours, v_record.complied_at_cycles
         ) AS n
   WHERE src.id = r.id
     AND r.maintenance_item_id = p_item_id;

  UPDATE public.maintenance_items i
     SET last_complied_on     = v_record.complied_on,
         last_complied_hours  = v_record.complied_at_hours,
         last_complied_cycles = v_record.complied_at_cycles,
         due_on        = (SELECT min(r.due_on) FROM public.maintenance_item_rules r
                           WHERE r.maintenance_item_id = i.id),
         due_at_hours  = (SELECT min(r.due_at_hours) FROM public.maintenance_item_rules r
                           WHERE r.maintenance_item_id = i.id),
         due_at_cycles = (SELECT min(r.due_at_cycles) FROM public.maintenance_item_rules r
                           WHERE r.maintenance_item_id = i.id)
   WHERE i.id = p_item_id;
END
$$;

COMMENT ON FUNCTION public.recompute_item_from_compliance(uuid) IS
  '§4.7: rebuild an item''s anchor and due points from the latest record that '
  'is neither superseded nor voided. The forward trigger cannot do this — it '
  'rolls on from the row that just landed, and a void is the other direction.';

REVOKE ALL ON FUNCTION public.recompute_item_from_compliance(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.recompute_item_from_compliance(uuid) TO app_role;
