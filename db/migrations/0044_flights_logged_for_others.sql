-- ===========================================================================
-- 0044 — logging a flight for somebody else is an administrator's act
--
-- `flown_by` is the billing subject (§3.4): who had the aeroplane, and who
-- owes for it. `POST /flights` has always accepted it, and until now nothing
-- asked who was sending it — anybody holding `flights: write`, which both
-- bundles do, could log a flight against any member and so put a charge on
-- their statement.
--
-- The need behind accepting it is real: a member without the app hands the
-- treasurer a paper squawk sheet, or a pilot forgets and the admin enters it
-- from the Hobbs book. So it stays, and it now needs the same thing a late
-- correction needs: `aircraft: write`, the admin test 0041 chose and
-- `assert_booking_is_allowed` uses. Not the `scope` column, for 0041's reason —
-- `role_bundle_permissions` is keyed per resource rather than per level, so
-- narrowing `flights` to 'own' would narrow reading too.
--
-- A trigger rather than a handler check, for 0041's reason: a rule that exists
-- only in one handler is a rule the next handler will not have.
--
-- §8.1: no shipped client fails this. The phone never sends `flown_by` except
-- when taking back a flight, and that path is only offered on a pilot's own
-- flights, where it carries their own membership. A correction is not exempt:
-- naming somebody else on a correction is the same act as naming them on a new
-- flight, and 0041 already requires an admin for any correction of somebody
-- else's flight.
--
-- SECURITY INVOKER: it reads the caller's own permission and membership, which
-- app_role can already do, so it holds no privilege and is not a §2.3 helper.
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

CREATE FUNCTION public.assert_flown_by_allowed()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.flown_by IS NOT DISTINCT FROM app.current_membership_id() THEN
    RETURN NEW;
  END IF;

  IF app.permission_level('aircraft') = 'write' THEN
    RETURN NEW;
  END IF;

  -- FS403, as 0041's refusals are, so the API answers 403 naming the
  -- permission that would have allowed it.
  RAISE EXCEPTION 'only an administrator can log a flight for somebody else'
    USING ERRCODE = 'FS403';
END
$$;

REVOKE ALL ON FUNCTION public.assert_flown_by_allowed() FROM PUBLIC;

CREATE TRIGGER flights_assert_flown_by_allowed
  BEFORE INSERT ON public.flights
  FOR EACH ROW
  EXECUTE FUNCTION public.assert_flown_by_allowed();

COMMENT ON FUNCTION public.assert_flown_by_allowed() IS
  'A flight names its own logger as flown_by unless the logger holds '
  'aircraft: write (0044). flown_by is the billing subject, so naming somebody '
  'else is putting a charge on their statement.';
