-- ===========================================================================
-- Scheduling: the constraint that cannot lose the race, and the two rules
-- that decide who may book at all.
--
-- §3.3: "Two members hitting Book at the same moment is the normal case for a
-- club with one popular aircraft on a Saturday, and application-level
-- checking loses that race." Everything below is about not losing it.
--
-- Runs as app_role.
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
SET LOCAL app.user_id   = '01920000-0000-7000-8000-0000000000a1';   -- alice, Admin

INSERT INTO public.aircraft (id, tenant_id, registration, type_code)
VALUES ('01920000-0000-7000-8000-0000000000f1',
        '01920000-0000-7000-8000-00000000000a', 'N123AB', 'C172');

-- Booking is two inserts — the reservation, then the line it holds — and
-- they are written out each time rather than wrapped in a helper: app_role
-- holds no TEMP on the database, which is exactly the right privilege for
-- it and exactly the wrong one for a shortcut.
--
-- The API does the same two statements in the same transaction.

-- ---------------------------------------------------------------------------
-- One aeroplane, one Saturday.
-- ---------------------------------------------------------------------------
DO $t$
BEGIN
  INSERT INTO public.reservations (id, tenant_id, booked_by, starts_at, ends_at, purpose)
  VALUES ('01920000-0000-7000-8000-00000000b001', '01920000-0000-7000-8000-00000000000a', '01920000-0000-7000-8000-0000000000a2', '2026-10-03 09:00+00', '2026-10-03 12:00+00', 'Local');
  INSERT INTO public.reservation_resources
    (tenant_id, reservation_id, resource_type, resource_id, during)
  VALUES ('01920000-0000-7000-8000-00000000000a', '01920000-0000-7000-8000-00000000b001', 'aircraft',
          '01920000-0000-7000-8000-0000000000f1', tstzrange('2026-10-03 09:00+00', '2026-10-03 12:00+00', '[)'));
  RAISE NOTICE '   ok: the first booking takes the morning';

  BEGIN
    INSERT INTO public.reservations (id, tenant_id, booked_by, starts_at, ends_at, purpose)
    VALUES ('01920000-0000-7000-8000-00000000b002', '01920000-0000-7000-8000-00000000000a', '01920000-0000-7000-8000-0000000000a2', '2026-10-03 11:00+00', '2026-10-03 14:00+00', 'Local');
    INSERT INTO public.reservation_resources
      (tenant_id, reservation_id, resource_type, resource_id, during)
    VALUES ('01920000-0000-7000-8000-00000000000a', '01920000-0000-7000-8000-00000000b002', 'aircraft',
            '01920000-0000-7000-8000-0000000000f1', tstzrange('2026-10-03 11:00+00', '2026-10-03 14:00+00', '[)'));
    RAISE EXCEPTION 'the aeroplane was double-booked';
  EXCEPTION WHEN exclusion_violation THEN
    -- The index refused it. No SELECT ran, so there was no window in which
    -- two transactions could both have found the slot free.
    RAISE NOTICE '   ok: an overlapping booking is refused by the constraint';
  END;

  -- Back to back is not overlapping: the range is half-open, so noon to
  -- three is free the moment the morning ends.
  INSERT INTO public.reservations (id, tenant_id, booked_by, starts_at, ends_at, purpose)
  VALUES ('01920000-0000-7000-8000-00000000b003', '01920000-0000-7000-8000-00000000000a', '01920000-0000-7000-8000-0000000000a2', '2026-10-03 12:00+00', '2026-10-03 15:00+00', 'Local');
  INSERT INTO public.reservation_resources
    (tenant_id, reservation_id, resource_type, resource_id, during)
  VALUES ('01920000-0000-7000-8000-00000000000a', '01920000-0000-7000-8000-00000000b003', 'aircraft',
          '01920000-0000-7000-8000-0000000000f1', tstzrange('2026-10-03 12:00+00', '2026-10-03 15:00+00', '[)'));
  RAISE NOTICE '   ok: one booking may start exactly when another ends';
END
$t$;

-- ---------------------------------------------------------------------------
-- Cancelling gives the slot back without losing that it happened.
-- ---------------------------------------------------------------------------
DO $t$
BEGIN
  UPDATE public.reservations
     SET status = 'cancelled', cancelled_at = now(),
         cancelled_by = '01920000-0000-7000-8000-0000000000a2'
   WHERE id = '01920000-0000-7000-8000-00000000b001';

  IF (SELECT blocking FROM public.reservation_resources
       WHERE reservation_id = '01920000-0000-7000-8000-00000000b001') THEN
    RAISE EXCEPTION 'a cancelled booking still holds the slot';
  END IF;

  INSERT INTO public.reservations (id, tenant_id, booked_by, starts_at, ends_at, purpose)
  VALUES ('01920000-0000-7000-8000-00000000b004', '01920000-0000-7000-8000-00000000000a', '01920000-0000-7000-8000-0000000000a2', '2026-10-03 09:00+00', '2026-10-03 11:00+00', 'Local');
  INSERT INTO public.reservation_resources
    (tenant_id, reservation_id, resource_type, resource_id, during)
  VALUES ('01920000-0000-7000-8000-00000000000a', '01920000-0000-7000-8000-00000000b004', 'aircraft',
          '01920000-0000-7000-8000-0000000000f1', tstzrange('2026-10-03 09:00+00', '2026-10-03 11:00+00', '[)'));

  -- §10: cancelling is a status. The row is still there, and a club arguing
  -- about a Saturday needs it to be.
  IF NOT EXISTS (SELECT 1 FROM public.reservations
                  WHERE id = '01920000-0000-7000-8000-00000000b001') THEN
    RAISE EXCEPTION 'cancelling deleted the reservation';
  END IF;
  RAISE NOTICE '   ok: cancelling frees the slot and keeps the record';
END
$t$;

-- ---------------------------------------------------------------------------
-- Moving a booking moves what it holds.
-- ---------------------------------------------------------------------------
DO $t$
BEGIN
  UPDATE public.reservations
     SET starts_at = '2026-10-03 16:00+00', ends_at = '2026-10-03 18:00+00'
   WHERE id = '01920000-0000-7000-8000-00000000b003';

  IF (SELECT during FROM public.reservation_resources
       WHERE reservation_id = '01920000-0000-7000-8000-00000000b003')
     <> tstzrange('2026-10-03 16:00+00', '2026-10-03 18:00+00', '[)') THEN
    RAISE EXCEPTION 'the line did not follow the booking';
  END IF;

  -- And the afternoon it left is free again.
  INSERT INTO public.reservations (id, tenant_id, booked_by, starts_at, ends_at, purpose)
  VALUES ('01920000-0000-7000-8000-00000000b005', '01920000-0000-7000-8000-00000000000a', '01920000-0000-7000-8000-0000000000a2', '2026-10-03 13:00+00', '2026-10-03 15:00+00', 'Local');
  INSERT INTO public.reservation_resources
    (tenant_id, reservation_id, resource_type, resource_id, during)
  VALUES ('01920000-0000-7000-8000-00000000000a', '01920000-0000-7000-8000-00000000b005', 'aircraft',
          '01920000-0000-7000-8000-0000000000f1', tstzrange('2026-10-03 13:00+00', '2026-10-03 15:00+00', '[)'));
  RAISE NOTICE '   ok: moving a booking moves the hours it holds';
END
$t$;

-- ---------------------------------------------------------------------------
-- A blackout competes for the same hours, which is why it shares the space.
-- ---------------------------------------------------------------------------
DO $t$
BEGIN
  INSERT INTO public.blackouts
    (id, tenant_id, aircraft_id, reason, starts_at, ends_at, created_by)
  VALUES ('01920000-0000-7000-8000-00000000c001',
          '01920000-0000-7000-8000-00000000000a',
          '01920000-0000-7000-8000-0000000000f1',
          'Annual inspection', '2026-11-02 00:00+00', '2026-11-09 00:00+00',
          '01920000-0000-7000-8000-0000000000a2');
  INSERT INTO public.reservation_resources
    (tenant_id, blackout_id, resource_type, resource_id, during)
  VALUES ('01920000-0000-7000-8000-00000000000a',
          '01920000-0000-7000-8000-00000000c001', 'aircraft',
          '01920000-0000-7000-8000-0000000000f1',
          tstzrange('2026-11-02 00:00+00', '2026-11-09 00:00+00', '[)'));

  BEGIN
    INSERT INTO public.reservations (id, tenant_id, booked_by, starts_at, ends_at, purpose)
    VALUES ('01920000-0000-7000-8000-00000000b006', '01920000-0000-7000-8000-00000000000a', '01920000-0000-7000-8000-0000000000a2', '2026-11-04 09:00+00', '2026-11-04 12:00+00', 'Local');
    INSERT INTO public.reservation_resources
      (tenant_id, reservation_id, resource_type, resource_id, during)
    VALUES ('01920000-0000-7000-8000-00000000000a', '01920000-0000-7000-8000-00000000b006', 'aircraft',
            '01920000-0000-7000-8000-0000000000f1', tstzrange('2026-11-04 09:00+00', '2026-11-04 12:00+00', '[)'));
    RAISE EXCEPTION 'somebody booked the aeroplane during its annual';
  EXCEPTION WHEN exclusion_violation THEN
    RAISE NOTICE '   ok: a blackout holds the hours against a booking';
  END;

  -- One line, one holder. A row belonging to both, or to neither, is a row
  -- nothing can reason about.
  BEGIN
    INSERT INTO public.reservation_resources
      (tenant_id, reservation_id, blackout_id, resource_type, resource_id, during)
    VALUES ('01920000-0000-7000-8000-00000000000a',
            '01920000-0000-7000-8000-00000000b003',
            '01920000-0000-7000-8000-00000000c001', 'aircraft',
            '01920000-0000-7000-8000-0000000000f1',
            tstzrange('2027-01-01 00:00+00', '2027-01-02 00:00+00', '[)'));
    RAISE EXCEPTION 'a line was held by two things at once';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE '   ok: a line belongs to exactly one holder';
  END;
END
$t$;

-- ---------------------------------------------------------------------------
-- §3.5: "is Dave signed off in the 182?"
-- ---------------------------------------------------------------------------
SET LOCAL app.user_id = '01920000-0000-7000-8000-0000000000c1';   -- carol, Pilot
DO $t$
BEGIN
  BEGIN
    INSERT INTO public.reservations (id, tenant_id, booked_by, starts_at, ends_at, purpose)
    VALUES ('01920000-0000-7000-8000-00000000b010', '01920000-0000-7000-8000-00000000000a', '01920000-0000-7000-8000-0000000000a3', '2026-12-05 09:00+00', '2026-12-05 12:00+00', 'Local');
    INSERT INTO public.reservation_resources
      (tenant_id, reservation_id, resource_type, resource_id, during)
    VALUES ('01920000-0000-7000-8000-00000000000a', '01920000-0000-7000-8000-00000000b010', 'aircraft',
            '01920000-0000-7000-8000-0000000000f1', tstzrange('2026-12-05 09:00+00', '2026-12-05 12:00+00', '[)'));
    RAISE EXCEPTION 'a pilot booked an aircraft they are not signed off in';
  EXCEPTION WHEN SQLSTATE 'FS409' THEN
    RAISE NOTICE '   ok: an unauthorised pilot cannot book';
  END;
END
$t$;

SET LOCAL app.user_id = '01920000-0000-7000-8000-0000000000a1';   -- alice again
DO $t$
BEGIN
  -- An admin books the aeroplane they administer without being signed off
  -- in it: they are the person who grants authorisations in the first place.
  INSERT INTO public.reservations (id, tenant_id, booked_by, starts_at, ends_at, purpose)
  VALUES ('01920000-0000-7000-8000-00000000b011', '01920000-0000-7000-8000-00000000000a', '01920000-0000-7000-8000-0000000000a2', '2026-12-05 09:00+00', '2026-12-05 12:00+00', 'Local');
  INSERT INTO public.reservation_resources
    (tenant_id, reservation_id, resource_type, resource_id, during)
  VALUES ('01920000-0000-7000-8000-00000000000a', '01920000-0000-7000-8000-00000000b011', 'aircraft',
          '01920000-0000-7000-8000-0000000000f1', tstzrange('2026-12-05 09:00+00', '2026-12-05 12:00+00', '[)'));
  RAISE NOTICE '   ok: an admin books without a checkout of their own';

  -- ... but cannot put an unauthorised pilot in it either. The rule is about
  -- who is flying, not about who filled in the form.
  BEGIN
    INSERT INTO public.reservations (id, tenant_id, booked_by, starts_at, ends_at, purpose)
    VALUES ('01920000-0000-7000-8000-00000000b012', '01920000-0000-7000-8000-00000000000a', '01920000-0000-7000-8000-0000000000a3', '2026-12-06 09:00+00', '2026-12-06 12:00+00', 'Local');
    INSERT INTO public.reservation_resources
      (tenant_id, reservation_id, resource_type, resource_id, during)
    VALUES ('01920000-0000-7000-8000-00000000000a', '01920000-0000-7000-8000-00000000b012', 'aircraft',
            '01920000-0000-7000-8000-0000000000f1', tstzrange('2026-12-06 09:00+00', '2026-12-06 12:00+00', '[)'));
    RAISE EXCEPTION 'an admin booked an unauthorised pilot into an aircraft';
  EXCEPTION WHEN SQLSTATE 'FS409' THEN
    RAISE NOTICE '   ok: booking on somebody''s behalf checks their checkout';
  END;

  INSERT INTO public.member_aircraft_authorizations
    (tenant_id, membership_id, aircraft_id, authorized_by)
  VALUES ('01920000-0000-7000-8000-00000000000a',
          '01920000-0000-7000-8000-0000000000a3',
          '01920000-0000-7000-8000-0000000000f1',
          '01920000-0000-7000-8000-0000000000a2');
END
$t$;

SET LOCAL app.user_id = '01920000-0000-7000-8000-0000000000c1';
DO $t$
BEGIN
  INSERT INTO public.reservations (id, tenant_id, booked_by, starts_at, ends_at, purpose)
  VALUES ('01920000-0000-7000-8000-00000000b013', '01920000-0000-7000-8000-00000000000a', '01920000-0000-7000-8000-0000000000a3', '2026-12-07 09:00+00', '2026-12-07 12:00+00', 'Local');
  INSERT INTO public.reservation_resources
    (tenant_id, reservation_id, resource_type, resource_id, during)
  VALUES ('01920000-0000-7000-8000-00000000000a', '01920000-0000-7000-8000-00000000b013', 'aircraft',
          '01920000-0000-7000-8000-0000000000f1', tstzrange('2026-12-07 09:00+00', '2026-12-07 12:00+00', '[)'));
  RAISE NOTICE '   ok: once signed off, the same pilot books the same aircraft';
END
$t$;

-- ---------------------------------------------------------------------------
-- §3.3: a grounded aircraft blocks new bookings, and flags the old ones
-- rather than cancelling them.
-- ---------------------------------------------------------------------------
SET LOCAL app.user_id = '01920000-0000-7000-8000-0000000000a1';
DO $t$
DECLARE r record;
BEGIN
  INSERT INTO public.squawks
    (tenant_id, aircraft_id, summary, severity, grounding, reported_by)
  VALUES ('01920000-0000-7000-8000-00000000000a',
          '01920000-0000-7000-8000-0000000000f1',
          'Left brake soft', 'grounding', true,
          '01920000-0000-7000-8000-0000000000a2');

  BEGIN
    INSERT INTO public.reservations (id, tenant_id, booked_by, starts_at, ends_at, purpose)
    VALUES ('01920000-0000-7000-8000-00000000b020', '01920000-0000-7000-8000-00000000000a', '01920000-0000-7000-8000-0000000000a2', '2027-02-01 09:00+00', '2027-02-01 12:00+00', 'Local');
    INSERT INTO public.reservation_resources
      (tenant_id, reservation_id, resource_type, resource_id, during)
    VALUES ('01920000-0000-7000-8000-00000000000a', '01920000-0000-7000-8000-00000000b020', 'aircraft',
            '01920000-0000-7000-8000-0000000000f1', tstzrange('2027-02-01 09:00+00', '2027-02-01 12:00+00', '[)'));
    RAISE EXCEPTION 'a grounded aircraft was booked';
  EXCEPTION WHEN SQLSTATE 'FS409' THEN
    RAISE NOTICE '   ok: a grounded aircraft takes no new bookings';
  END;

  -- The ones already on the calendar are somebody's Saturday. They are
  -- flagged so the club can call those members — never cancelled by a
  -- trigger that has no idea what else was arranged around them.
  SELECT status, needs_review, review_reason INTO r
    FROM public.reservations WHERE id = '01920000-0000-7000-8000-00000000b013';

  IF r.status <> 'booked' THEN
    RAISE EXCEPTION 'an existing booking was cancelled by the grounding';
  END IF;
  IF NOT r.needs_review THEN
    RAISE EXCEPTION 'an existing booking was not flagged for review';
  END IF;
  IF r.review_reason NOT LIKE '%Left brake soft%' THEN
    RAISE EXCEPTION 'the flag does not say what grounded it: %', r.review_reason;
  END IF;
  RAISE NOTICE '   ok: existing bookings are flagged for a person, not cancelled';
END
$t$;

ROLLBACK;

-- ---------------------------------------------------------------------------
-- V1_SCOPE M3: "Edit or cancel your own. Admins can edit or cancel anyone's."
--
-- Enforced by policy rather than by a handler, so it holds for any path that
-- ever reaches this table. The calendar stays readable by everyone, because
-- what is scoped is the writing.
-- ---------------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '01920000-0000-7000-8000-00000000000a';
SET LOCAL app.user_id   = '01920000-0000-7000-8000-0000000000a1';   -- alice, Admin

INSERT INTO public.aircraft (id, tenant_id, registration)
VALUES ('01920000-0000-7000-8000-0000000000f2',
        '01920000-0000-7000-8000-00000000000a', 'N321XY');
INSERT INTO public.member_aircraft_authorizations
  (tenant_id, membership_id, aircraft_id)
VALUES ('01920000-0000-7000-8000-00000000000a',
        '01920000-0000-7000-8000-0000000000a3',
        '01920000-0000-7000-8000-0000000000f2');

-- Alice books her own Saturday.
INSERT INTO public.reservations (id, tenant_id, booked_by, starts_at, ends_at)
VALUES ('01920000-0000-7000-8000-00000000b100',
        '01920000-0000-7000-8000-00000000000a',
        '01920000-0000-7000-8000-0000000000a2',
        '2027-03-06 09:00+00', '2027-03-06 12:00+00');
INSERT INTO public.reservation_resources
  (tenant_id, reservation_id, resource_type, resource_id, during)
VALUES ('01920000-0000-7000-8000-00000000000a',
        '01920000-0000-7000-8000-00000000b100', 'aircraft',
        '01920000-0000-7000-8000-0000000000f2',
        tstzrange('2027-03-06 09:00+00', '2027-03-06 12:00+00', '[)'));

SET LOCAL app.user_id = '01920000-0000-7000-8000-0000000000c1';   -- carol, Pilot
DO $t$
DECLARE n bigint;
BEGIN
  -- She can see it. Who has the aeroplane on Saturday is the whole question.
  SELECT count(*) INTO n FROM public.reservations
   WHERE id = '01920000-0000-7000-8000-00000000b100';
  IF n <> 1 THEN RAISE EXCEPTION 'a pilot cannot read the club calendar'; END IF;
  RAISE NOTICE '   ok: every member reads the whole calendar';

  -- She cannot cancel it.
  UPDATE public.reservations
     SET status = 'cancelled', cancelled_at = now(),
         cancelled_by = '01920000-0000-7000-8000-0000000000a3'
   WHERE id = '01920000-0000-7000-8000-00000000b100';
  IF FOUND THEN
    RAISE EXCEPTION 'a pilot cancelled somebody else''s booking';
  END IF;
  RAISE NOTICE '   ok: a pilot cannot cancel another member''s booking';

  -- Nor take it over by putting her own name on it, which a single policy
  -- with a scoped WITH CHECK would have allowed. Two things stop it, and
  -- the outer one stops it first: `booked_by` is not in the column grant at
  -- all, so whose booking it is cannot be edited by anybody. The policy is
  -- behind that for the day somebody has a reason to widen the grant.
  BEGIN
    UPDATE public.reservations
       SET booked_by = '01920000-0000-7000-8000-0000000000a3'
     WHERE id = '01920000-0000-7000-8000-00000000b100';
    RAISE EXCEPTION 'a pilot took over somebody else''s booking';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE '   ok: whose booking it is cannot be edited at all';
  END;

  -- Her own, she may have.
  INSERT INTO public.reservations (id, tenant_id, booked_by, starts_at, ends_at)
  VALUES ('01920000-0000-7000-8000-00000000b101',
          '01920000-0000-7000-8000-00000000000a',
          '01920000-0000-7000-8000-0000000000a3',
          '2027-03-06 13:00+00', '2027-03-06 15:00+00');
  INSERT INTO public.reservation_resources
    (tenant_id, reservation_id, resource_type, resource_id, during)
  VALUES ('01920000-0000-7000-8000-00000000000a',
          '01920000-0000-7000-8000-00000000b101', 'aircraft',
          '01920000-0000-7000-8000-0000000000f2',
          tstzrange('2027-03-06 13:00+00', '2027-03-06 15:00+00', '[)'));

  UPDATE public.reservations SET notes = 'Taking the long way round'
   WHERE id = '01920000-0000-7000-8000-00000000b101';
  IF NOT FOUND THEN RAISE EXCEPTION 'a pilot cannot edit their own booking'; END IF;
  RAISE NOTICE '   ok: a pilot books and edits their own';

  -- And cannot book *for* somebody else, which is the insert side of the
  -- same rule.
  BEGIN
    INSERT INTO public.reservations (tenant_id, booked_by, starts_at, ends_at)
    VALUES ('01920000-0000-7000-8000-00000000000a',
            '01920000-0000-7000-8000-0000000000a2',
            '2027-03-07 09:00+00', '2027-03-07 11:00+00');
    RAISE EXCEPTION 'a pilot booked in somebody else''s name';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE '   ok: a pilot cannot book in another member''s name';
  END;
END
$t$;

-- The admin may do all of it.
SET LOCAL app.user_id = '01920000-0000-7000-8000-0000000000a1';
DO $t$
BEGIN
  UPDATE public.reservations SET notes = 'Moved at the member''s request'
   WHERE id = '01920000-0000-7000-8000-00000000b101';
  IF NOT FOUND THEN RAISE EXCEPTION 'an admin cannot edit a member''s booking'; END IF;
  RAISE NOTICE '   ok: an admin edits anybody''s';
END
$t$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- §3.2's leaseback case: one tail number, two clubs, two calendars.
-- ---------------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '01920000-0000-7000-8000-00000000000a';
SET LOCAL app.user_id   = '01920000-0000-7000-8000-0000000000a1';
INSERT INTO public.aircraft (id, tenant_id, registration)
VALUES ('01920000-0000-7000-8000-0000000000f7',
        '01920000-0000-7000-8000-00000000000a', 'N999LB');
INSERT INTO public.reservations (id, tenant_id, booked_by, starts_at, ends_at)
VALUES ('01920000-0000-7000-8000-00000000b030',
        '01920000-0000-7000-8000-00000000000a',
        '01920000-0000-7000-8000-0000000000a2',
        '2026-10-10 09:00+00', '2026-10-10 12:00+00');
INSERT INTO public.reservation_resources
  (tenant_id, reservation_id, resource_type, resource_id, during)
VALUES ('01920000-0000-7000-8000-00000000000a',
        '01920000-0000-7000-8000-00000000b030', 'aircraft',
        '01920000-0000-7000-8000-0000000000f7',
        tstzrange('2026-10-10 09:00+00', '2026-10-10 12:00+00', '[)'));

SET LOCAL app.tenant_id = '01920000-0000-7000-8000-00000000000b';
SET LOCAL app.user_id   = '01920000-0000-7000-8000-0000000000b1';
DO $t$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM public.reservations;
  IF n <> 0 THEN RAISE EXCEPTION 'another club''s calendar is visible'; END IF;

  SELECT count(*) INTO n FROM public.reservation_resources;
  IF n <> 0 THEN RAISE EXCEPTION 'another club''s resource lines are visible'; END IF;
  RAISE NOTICE '   ok: a calendar stops at the club it belongs to';
END
$t$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- Shape, outside the transaction where the grants are real.
-- ---------------------------------------------------------------------------
DO $t$
DECLARE t text;
BEGIN
  -- §10: cancelling is a status, so nothing here is deletable.
  IF has_table_privilege('app_role', 'public.reservations', 'DELETE') THEN
    RAISE EXCEPTION 'a reservation can be deleted — cancelling is a status';
  END IF;

  -- The copies the constraint depends on are not the application's to write.
  -- If they were, the guarantee would be a suggestion (§3.4's argument).
  IF has_column_privilege('app_role', 'public.reservation_resources', 'during', 'UPDATE')
     OR has_column_privilege('app_role', 'public.reservation_resources', 'blocking', 'UPDATE') THEN
    RAISE EXCEPTION 'app_role can move a line without moving its booking';
  END IF;

  -- §7.2: a calendar says who was where and when.
  FOREACH t IN ARRAY ARRAY['reservations', 'reservation_resources', 'blackouts',
                           'member_aircraft_authorizations'] LOOP
    IF has_any_column_privilege('admin_role', 'public.' || t, 'SELECT') THEN
      RAISE EXCEPTION 'admin_role can read % — that is content (§7.2)', t;
    END IF;
  END LOOP;
  RAISE NOTICE '   ok: no deletes, no hand-written ranges, no control-plane reads';
END
$t$;
