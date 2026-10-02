-- ===========================================================================
-- 0027_maintenance_permission_split.sql — a pilot may see that the aeroplane
-- is grounded without reading its maintenance history
--
-- SPEC §3 draws a line the single `maintenance` resource cannot: a pilot gets
-- the status card, the grounded banner and the next five items; the full list,
-- the item detail, the history and the notes are the admin's. Today a pilot
-- holds `maintenance: read, all` and both clients show them the whole fleet
-- picture on that basis.
--
-- So `maintenance` becomes two resources:
--
--   maintenance.summary   is the aeroplane fit to fly, and what is coming up
--   maintenance.items     is the record — every item, its rules, its history
--
-- ---------------------------------------------------------------------------
-- This is a narrowing, and it is worth saying plainly
--
-- Every existing pilot can read the full maintenance list today and will not be
-- able to afterwards. That is the spec's intent rather than an accident of the
-- migration, and it is the one change in Phase 1 that takes something away from
-- somebody who already has it. An admin who wants the old behaviour for their
-- club can grant `maintenance.items: read` to the Pilot bundle — §1.5 makes a
-- role a bundle of rows, so that is a data change and not a deploy.
--
-- ---------------------------------------------------------------------------
-- Why the resource list grows rather than the level or the scope
--
-- §1.5's list is closed in three places — the `Resource` union, this CHECK, and
-- the primary key `(tenant_id, role_bundle_id, resource)`, which allows exactly
-- one level per resource per bundle. Two alternatives were considered:
--
--   * One resource, where `read` means the summary and the full list needs
--     `write`. No migration, and a read gated on write that somebody trips over
--     every time they add an endpoint.
--   * A third scope value beside `own | all`. But scope is enforced in RLS as a
--     row predicate through `app.owns_row`, and summary-versus-detail is not a
--     property of a row — it is a projection.
--
-- The list is the domain's vocabulary and the domain grew. §1.5 is amended in
-- the same commit rather than left contradicting this.
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
-- Widen first, so the rows have somewhere to go
-- ---------------------------------------------------------------------------

ALTER TABLE public.role_bundle_permissions
  DROP CONSTRAINT role_bundle_permissions_resource_check;

ALTER TABLE public.role_bundle_permissions
  ADD CONSTRAINT role_bundle_permissions_resource_check CHECK (resource IN (
    'aircraft', 'reservations', 'flights', 'squawks',
    'maintenance', 'maintenance.summary', 'maintenance.items',
    'rates', 'charges', 'qualifications', 'documents', 'members',
    'subscription', 'settings'));

/*
  Every bundle's `maintenance` row becomes two.

  `summary` keeps whatever level the bundle had: a pilot who could read
  maintenance can still see whether the aeroplane is fit to fly, which is the
  half of it they were actually using.

  `items` keeps the level only when it was `write`. A bundle that could *edit*
  maintenance is an admin bundle by any reading, and nothing about this split
  was meant to take anything from them. A bundle that could only read drops to
  `none`, which is the narrowing above.

  Loops per tenant, because `role_bundle_permissions` is tenant-scoped and
  forced, and 0023 is the cautionary tale: a data migration run without context
  reads zero rows and reports success.
*/
SET LOCAL app.auth_bootstrap = 'on';

DO $split$
DECLARE
  t       record;
  moved   bigint := 0;
  touched bigint;
BEGIN
  FOR t IN SELECT id FROM public.tenants ORDER BY created_at LOOP
    PERFORM set_config('app.tenant_id', t.id::text, true);

    INSERT INTO public.role_bundle_permissions
      (tenant_id, role_bundle_id, resource, level, scope)
    SELECT p.tenant_id, p.role_bundle_id, 'maintenance.summary', p.level, p.scope
      FROM public.role_bundle_permissions p
     WHERE p.resource = 'maintenance'
    ON CONFLICT DO NOTHING;

    INSERT INTO public.role_bundle_permissions
      (tenant_id, role_bundle_id, resource, level, scope)
    SELECT p.tenant_id, p.role_bundle_id, 'maintenance.items',
           CASE WHEN p.level = 'write' THEN 'write' ELSE 'none' END, p.scope
      FROM public.role_bundle_permissions p
     WHERE p.resource = 'maintenance'
    ON CONFLICT DO NOTHING;

    DELETE FROM public.role_bundle_permissions WHERE resource = 'maintenance';
    GET DIAGNOSTICS touched = ROW_COUNT;
    moved := moved + touched;
  END LOOP;

  RAISE NOTICE 'maintenance grants split: %', moved;
END
$split$;

-- And now that nothing holds it, the old name goes. A resource that can still
-- be written is a resource somebody will write.
ALTER TABLE public.role_bundle_permissions
  DROP CONSTRAINT role_bundle_permissions_resource_check;

ALTER TABLE public.role_bundle_permissions
  ADD CONSTRAINT role_bundle_permissions_resource_check CHECK (resource IN (
    'aircraft', 'reservations', 'flights', 'squawks',
    'maintenance.summary', 'maintenance.items',
    'rates', 'charges', 'qualifications', 'documents', 'members',
    'subscription', 'settings'));

DO $verify$
DECLARE
  t      record;
  stale  bigint;
  bundles bigint := 0;
BEGIN
  FOR t IN SELECT id FROM public.tenants LOOP
    PERFORM set_config('app.tenant_id', t.id::text, true);

    -- Every bundle that had maintenance must now have both halves. A bundle
    -- holding neither would silently lose the maintenance screen entirely.
    SELECT count(*) INTO stale
      FROM public.role_bundles b
     WHERE EXISTS (SELECT 1 FROM public.role_bundle_permissions p
                    WHERE p.role_bundle_id = b.id
                      AND p.resource = 'maintenance.summary')
       AND NOT EXISTS (SELECT 1 FROM public.role_bundle_permissions p
                        WHERE p.role_bundle_id = b.id
                          AND p.resource = 'maintenance.items');
    IF stale > 0 THEN
      RAISE EXCEPTION '% bundles in tenant % kept summary without items', stale, t.id;
    END IF;

    SELECT count(*) INTO stale FROM public.role_bundles;
    bundles := bundles + stale;
  END LOOP;
  RAISE NOTICE 'bundles checked: %', bundles;
END
$verify$;

-- ---------------------------------------------------------------------------
-- New tenants get the split from the start
--
-- The fourth version of this function (0005, 0010, 0012, here). Only the two
-- maintenance rows change; everything else is carried forward verbatim so the
-- whole grant table stays readable in one place.
-- ---------------------------------------------------------------------------

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
    (p_tenant_id, v_admin_id, 'aircraft',            'write', 'all'),
    (p_tenant_id, v_admin_id, 'reservations',        'write', 'all'),
    (p_tenant_id, v_admin_id, 'flights',             'write', 'all'),
    (p_tenant_id, v_admin_id, 'squawks',             'write', 'all'),
    (p_tenant_id, v_admin_id, 'maintenance.summary', 'write', 'all'),
    (p_tenant_id, v_admin_id, 'maintenance.items',   'write', 'all'),
    (p_tenant_id, v_admin_id, 'rates',               'write', 'all'),
    (p_tenant_id, v_admin_id, 'charges',             'write', 'all'),
    (p_tenant_id, v_admin_id, 'qualifications',      'write', 'all'),
    (p_tenant_id, v_admin_id, 'documents',           'write', 'all'),
    (p_tenant_id, v_admin_id, 'members',             'write', 'all'),
    (p_tenant_id, v_admin_id, 'subscription',        'write', 'all'),
    (p_tenant_id, v_admin_id, 'settings',            'write', 'all'),

    -- A pilot reports defects but does not close them, books and flies but
    -- does not set rates, and sees the fleet without editing it.
    (p_tenant_id, v_pilot_id, 'aircraft',            'read',  'all'),
    -- Books for themselves. The calendar is still read by everyone: the
    -- policies on `reservations` scope the writing, not the reading.
    (p_tenant_id, v_pilot_id, 'reservations',        'write', 'own'),
    (p_tenant_id, v_pilot_id, 'flights',             'write', 'all'),
    (p_tenant_id, v_pilot_id, 'squawks',             'write', 'all'),
    -- SPEC §3: whether the aeroplane is fit to fly, and what is coming up.
    -- Not the record — a pilot reports a defect and does not sign off work,
    -- which is the same line §1.5 draws between squawks and maintenance.
    (p_tenant_id, v_pilot_id, 'maintenance.summary', 'read',  'all'),
    (p_tenant_id, v_pilot_id, 'maintenance.items',   'none',  'all'),
    (p_tenant_id, v_pilot_id, 'rates',               'read',  'all'),
    -- §10 decision 3: a pilot reads their own ledger and no further.
    (p_tenant_id, v_pilot_id, 'charges',             'read',  'own'),
    (p_tenant_id, v_pilot_id, 'qualifications',      'read',  'all'),
    (p_tenant_id, v_pilot_id, 'documents',           'read',  'all'),
    (p_tenant_id, v_pilot_id, 'members',             'none',  'all'),
    (p_tenant_id, v_pilot_id, 'subscription',        'none',  'all'),
    (p_tenant_id, v_pilot_id, 'settings',            'none',  'all');

  RETURN v_admin_id;
END
$$;
