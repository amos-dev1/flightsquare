-- ===========================================================================
-- 0017_scheduled_sweep.sql — M8: the notice with no event behind it
--
-- Every other message in the product has something that fires it: somebody
-- books, files a squawk, pays or fails to. An annual going overdue has
-- nothing — no row is written, the clock simply passes — so it needs a
-- sweep, and a sweep has to know which tenants exist before §1.1's "set
-- context explicitly per tenant and loop" can begin.
--
-- Nothing in this design may enumerate tenants. `admin_role` can, because
-- §7.2 puts `tenants` in its metadata tier, and the owner can because it owns
-- everything — and neither is a credential a long-running job should hold:
-- one is the control plane §7.7 keeps on a separate surface, the other is
-- DDL on every table in the database.
--
-- So the capability gets named, the way mail_role's did in 0016, and made as
-- small as it can be: `scheduler_role` can read the *id* of a tenant worth
-- sweeping, and nothing else anywhere. It cannot read a tenant's name, its
-- plan, its aircraft or its members. Everything after the list is done as
-- app_role with explicit tenant context, under the ordinary policies, which
-- is precisely what §1.1 asks a background job to do.
--
-- Run as flightsquare_owner.
-- ===========================================================================

DO $guard$
BEGIN
  IF current_user <> 'flightsquare_owner' THEN
    RAISE EXCEPTION 'migrations run as flightsquare_owner, not %', current_user;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'scheduler_role') THEN
    RAISE EXCEPTION 'scheduler_role does not exist — run scripts/roles.sh first';
  END IF;
END
$guard$;

-- ---------------------------------------------------------------------------
-- What the sweep may see
--
-- One column of one table. The policy narrows it further to tenants that are
-- actually running: a suspended or closed account gets no maintenance email,
-- and a deleted one is not swept at all.
--
-- Note the policy reads `status` and `deleted_at` while the grant withholds
-- them. That is deliberate and it is how RLS works — a policy is evaluated by
-- the system, not by the caller, so the predicate can be stricter than
-- anything the role could ask about for itself.
-- ---------------------------------------------------------------------------
CREATE POLICY scheduler_enumerate ON public.tenants
  FOR SELECT TO scheduler_role
  USING (status IN ('trial', 'active', 'past_due') AND deleted_at IS NULL);

GRANT SELECT (id) ON public.tenants TO scheduler_role;

-- ---------------------------------------------------------------------------
-- What has already been said
--
-- A digest that runs daily and reports the same overdue annual every morning
-- is not a notification, it is noise, and the first thing a club does with
-- noise is filter it — which is how the one email that mattered gets missed.
--
-- So the sweep reports *changes*: an item whose state has moved to due_soon
-- or overdue since anybody was last told about it. The column holds what was
-- last reported rather than when, because "when" does not answer the
-- question — an item that went overdue, was complied with, and came due
-- again is news both times.
-- ---------------------------------------------------------------------------
ALTER TABLE public.maintenance_items
  ADD COLUMN notified_state text;

ALTER TABLE public.maintenance_items
  ADD CONSTRAINT maintenance_items_notified_state_check
  CHECK (notified_state IS NULL OR notified_state IN ('due_soon', 'overdue'));

COMMENT ON COLUMN public.maintenance_items.notified_state IS
  'The due state this item was last reported in, or NULL if it has not been '
  'reported since it was last in hand. Compared against the computed state in '
  'maintenance_item_status, which is what makes the digest report changes '
  'rather than repeating itself every morning.';

-- Recording compliance is what puts an item back in hand, and an item back in
-- hand has nothing outstanding to have been told about. Without this a second
-- trip through overdue would be silent, which is the failure this whole
-- column exists to avoid.
CREATE FUNCTION public.clear_maintenance_notice()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  -- Only when the due point actually moved. An edit to the item's name is
  -- not a reason to re-arm a notice about its annual.
  IF NEW.due_on IS DISTINCT FROM OLD.due_on
     OR NEW.due_at_hours IS DISTINCT FROM OLD.due_at_hours
     OR NEW.due_at_cycles IS DISTINCT FROM OLD.due_at_cycles THEN
    NEW.notified_state := NULL;
  END IF;
  RETURN NEW;
END
$$;

-- SECURITY INVOKER and no grant: it runs with whatever rights its caller
-- already had, and it needs none of its own. Not a §2.3 helper — it holds no
-- privilege app_role lacks, which is the test that section sets.
CREATE TRIGGER maintenance_items_clear_notice
  BEFORE UPDATE ON public.maintenance_items
  FOR EACH ROW EXECUTE FUNCTION public.clear_maintenance_notice();

-- The sweep's own query: everything not yet reported in its current state.
-- Partial, because the interesting rows are always a small fraction.
CREATE INDEX maintenance_items_unnotified_idx
  ON public.maintenance_items (tenant_id)
  WHERE status = 'active' AND notified_state IS NULL;
