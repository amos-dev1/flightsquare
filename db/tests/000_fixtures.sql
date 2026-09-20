-- ===========================================================================
-- Fixtures. Loaded as the container superuser.
--
-- Seeding is out-of-band on purpose: there is no legitimate in-application
-- path that writes rows belonging to two different tenants, and that is
-- precisely the property the rest of the suite asserts. Building the fixture
-- through the app role would mean weakening the thing under test.
--
-- Ids are fixed literals so assertions can name them. They are shaped like
-- UUIDv7 (version nibble 7, RFC 9562 variant) to match what the application
-- will generate client-side (§8.2).
--
--   tenant A  01920000-...-00000000000a  alpha    club, active
--   tenant B  01920000-...-00000000000b  bravo    partnership, active
--   tenant C  01920000-...-00000000000c  charlie  soft-deleted
--   alice     ...a1  member of A
--   bob       ...b1  member of B
--   carol     ...c1  member of BOTH — the §3.1 case that makes users global
-- ===========================================================================

DO $guard$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'fixtures load as a superuser; current_user is %', current_user;
  END IF;
END
$guard$;

DELETE FROM public.invites
 WHERE tenant_id IN ('01920000-0000-7000-8000-00000000000a',
                     '01920000-0000-7000-8000-00000000000b',
                     '01920000-0000-7000-8000-00000000000c');
DELETE FROM public.memberships
 WHERE tenant_id IN ('01920000-0000-7000-8000-00000000000a',
                     '01920000-0000-7000-8000-00000000000b',
                     '01920000-0000-7000-8000-00000000000c');
DELETE FROM public.users
 WHERE id IN ('01920000-0000-7000-8000-0000000000a1',
              '01920000-0000-7000-8000-0000000000b1',
              '01920000-0000-7000-8000-0000000000c1');
DELETE FROM public.tenants
 WHERE id IN ('01920000-0000-7000-8000-00000000000a',
              '01920000-0000-7000-8000-00000000000b',
              '01920000-0000-7000-8000-00000000000c');

INSERT INTO public.tenants
  (id, slug, name, host, status, archetype, plan_code, billing_customer_id,
   branding, deleted_at)
VALUES
  ('01920000-0000-7000-8000-00000000000a', 'alpha', 'Alpha Flying Club',
   'alpha.flightsquare.test', 'active', 'club', 'pro', 'cus_alpha',
   '{"primary_color": "#123456"}'::jsonb, NULL),
  ('01920000-0000-7000-8000-00000000000b', 'bravo', 'Bravo Partners',
   'bravo.flightsquare.test', 'active', 'partnership', 'free', 'cus_bravo',
   '{}'::jsonb, NULL),
  ('01920000-0000-7000-8000-00000000000c', 'charlie', 'Charlie Aviation',
   'charlie.flightsquare.test', 'closed', 'solo', 'free', 'cus_charlie',
   '{}'::jsonb, now());

INSERT INTO public.users (id, email, password_hash, mfa_enabled, status)
VALUES
  ('01920000-0000-7000-8000-0000000000a1', 'alice@alpha.test',
   'argon2id$fixture$alice', false, 'active'),
  ('01920000-0000-7000-8000-0000000000b1', 'bob@bravo.test',
   'argon2id$fixture$bob', true, 'active'),
  ('01920000-0000-7000-8000-0000000000c1', 'carol@example.test',
   'argon2id$fixture$carol', false, 'active');

INSERT INTO public.memberships (id, tenant_id, user_id, status, joined_at)
VALUES
  ('01920000-0000-7000-8000-0000000000a2',
   '01920000-0000-7000-8000-00000000000a',
   '01920000-0000-7000-8000-0000000000a1', 'active', now()),
  ('01920000-0000-7000-8000-0000000000a3',
   '01920000-0000-7000-8000-00000000000a',
   '01920000-0000-7000-8000-0000000000c1', 'active', now()),
  ('01920000-0000-7000-8000-0000000000b2',
   '01920000-0000-7000-8000-00000000000b',
   '01920000-0000-7000-8000-0000000000b1', 'active', now()),
  ('01920000-0000-7000-8000-0000000000b3',
   '01920000-0000-7000-8000-00000000000b',
   '01920000-0000-7000-8000-0000000000c1', 'active', now());

INSERT INTO public.invites
  (id, tenant_id, email, token_hash, invited_by, expires_at,
   accepted_at, accepted_by, revoked_at)
VALUES
  -- live
  ('01920000-0000-7000-8000-0000000000a4',
   '01920000-0000-7000-8000-00000000000a', 'dave@example.test',
   'sha256:alpha-pending', '01920000-0000-7000-8000-0000000000a1',
   now() + interval '7 days', NULL, NULL, NULL),
  -- expired
  ('01920000-0000-7000-8000-0000000000a5',
   '01920000-0000-7000-8000-00000000000a', 'erin@example.test',
   'sha256:alpha-expired', '01920000-0000-7000-8000-0000000000a1',
   now() - interval '1 day', NULL, NULL, NULL),
  -- already consumed
  ('01920000-0000-7000-8000-0000000000b4',
   '01920000-0000-7000-8000-00000000000b', 'bob@bravo.test',
   'sha256:bravo-accepted', '01920000-0000-7000-8000-0000000000b1',
   now() + interval '7 days', now(), '01920000-0000-7000-8000-0000000000b1',
   NULL);

\echo '   fixtures loaded'
