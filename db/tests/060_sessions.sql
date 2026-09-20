-- ===========================================================================
-- Sessions, refresh-token rotation, and the audit log.
--
-- sessions, refresh_tokens and device_registrations are scoped by USER rather
-- than by tenant, so §6.1's two tests take their user-shaped form here: one
-- session cannot see another user's, and cannot create one carrying another
-- user's id. audit_log is ordinary tenant-scoped and gets the tenant form.
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

-- ---------------------------------------------------------------------------
-- A session belongs to the user who is in context, and to nobody else.
-- ---------------------------------------------------------------------------
BEGIN;
SET LOCAL app.user_id = '01920000-0000-7000-8000-0000000000a1';  -- alice
DO $t$
DECLARE n bigint;
BEGIN
  INSERT INTO public.sessions
    (id, user_id, access_token_hash, access_expires_at, expires_at)
  VALUES ('01920000-0000-7000-8000-0000000000d1',
          '01920000-0000-7000-8000-0000000000a1',
          'sha256:alice-access', now() + interval '15 minutes',
          now() + interval '30 days');

  SELECT count(*) INTO n FROM public.sessions;
  IF n <> 1 THEN RAISE EXCEPTION 'alice sees % sessions, expected her own', n; END IF;
  RAISE NOTICE '   ok: a user can create and read their own session';

  -- §6.1 item 6, user-shaped: a session carrying somebody else's user id.
  BEGIN
    INSERT INTO public.sessions
      (user_id, access_token_hash, access_expires_at, expires_at)
    VALUES ('01920000-0000-7000-8000-0000000000b1',  -- bob
            'sha256:forged', now() + interval '15 minutes',
            now() + interval '30 days');
    RAISE EXCEPTION 'WITH CHECK did not reject a session for another user';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE '   ok: cannot mint a session for another user';
  END;

  -- A refresh token hangs off the session, so the policy reaches through it.
  INSERT INTO public.refresh_tokens (session_id, token_hash, expires_at)
  VALUES ('01920000-0000-7000-8000-0000000000d1',
          'sha256:alice-refresh', now() + interval '30 days');

  SELECT count(*) INTO n FROM public.refresh_tokens;
  IF n <> 1 THEN RAISE EXCEPTION 'expected 1 refresh token, got %', n; END IF;

  -- The token itself is never stored, only its hash — a database dump must
  -- not be a set of live sessions.
  SELECT count(*) INTO n FROM public.sessions
   WHERE access_token_hash NOT LIKE 'sha256:%';
  IF n <> 0 THEN RAISE EXCEPTION 'a session holds something that is not a hash'; END IF;

  -- app_role cannot forge an impersonation session: the column is not granted.
  BEGIN
    UPDATE public.sessions SET session_type = 'impersonation'
     WHERE id = '01920000-0000-7000-8000-0000000000d1';
    RAISE EXCEPTION 'app_role promoted its own session to impersonation';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE '   ok: app_role cannot write session_type (§7.5)';
  END;
END
$t$;

-- ---------------------------------------------------------------------------
-- The §2.1 lookups, called with no context at all — the state every
-- authenticated request arrives in.
-- ---------------------------------------------------------------------------
SET LOCAL app.user_id = '';
DO $t$
DECLARE r record; n bigint;
BEGIN
  SELECT count(*) INTO n FROM public.sessions;
  IF n <> 0 THEN RAISE EXCEPTION 'sessions readable with no user context'; END IF;

  SELECT * INTO r FROM auth.resolve_session_token('sha256:alice-access');
  IF r.user_id <> '01920000-0000-7000-8000-0000000000a1' THEN
    RAISE EXCEPTION 'resolve_session_token returned %', r.user_id;
  END IF;
  IF r.selected_tenant_id IS NOT NULL THEN
    RAISE EXCEPTION 'a fresh session should have no tenant selected';
  END IF;
  IF r.user_status <> 'active' THEN
    RAISE EXCEPTION 'expected the user status back, got %', r.user_status;
  END IF;
  RAISE NOTICE '   ok: a session resolves with no context, which is the point';

  SELECT count(*) INTO n FROM auth.resolve_session_token('sha256:nonexistent');
  IF n <> 0 THEN RAISE EXCEPTION 'an unknown token resolved'; END IF;
  RAISE NOTICE '   ok: an unknown token resolves to nothing';
END
$t$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- Expiry and revocation are indistinguishable from never having existed.
-- ---------------------------------------------------------------------------
BEGIN;
SET LOCAL app.user_id = '01920000-0000-7000-8000-0000000000a1';
INSERT INTO public.sessions
  (id, user_id, access_token_hash, access_expires_at, expires_at)
VALUES ('01920000-0000-7000-8000-0000000000d2',
        '01920000-0000-7000-8000-0000000000a1',
        'sha256:expired-access', now() - interval '1 minute',
        now() + interval '30 days'),
       ('01920000-0000-7000-8000-0000000000d3',
        '01920000-0000-7000-8000-0000000000a1',
        'sha256:revoked-access', now() + interval '15 minutes',
        now() + interval '30 days');
UPDATE public.sessions SET revoked_at = now()
 WHERE id = '01920000-0000-7000-8000-0000000000d3';
SET LOCAL app.user_id = '';
DO $t$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM auth.resolve_session_token('sha256:expired-access');
  IF n <> 0 THEN RAISE EXCEPTION 'an expired access token resolved'; END IF;

  SELECT count(*) INTO n FROM auth.resolve_session_token('sha256:revoked-access');
  IF n <> 0 THEN RAISE EXCEPTION 'a revoked session resolved'; END IF;
  RAISE NOTICE '   ok: expired and revoked sessions resolve to nothing';
END
$t$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- Refresh rotation, and what happens when a rotated token comes back.
--
-- This is the whole reason refresh tokens are rows rather than a column that
-- gets overwritten: a token that has already been exchanged is evidence, and
-- issuing another one instead would hand a thief a live session.
-- ---------------------------------------------------------------------------
BEGIN;
SET LOCAL app.user_id = '01920000-0000-7000-8000-0000000000a1';
INSERT INTO public.sessions
  (id, user_id, access_token_hash, access_expires_at, expires_at)
VALUES ('01920000-0000-7000-8000-0000000000d4',
        '01920000-0000-7000-8000-0000000000a1',
        'sha256:rotate-access', now() + interval '15 minutes',
        now() + interval '30 days');
INSERT INTO public.refresh_tokens (session_id, token_hash, expires_at)
VALUES ('01920000-0000-7000-8000-0000000000d4',
        'sha256:rotate-refresh', now() + interval '30 days');
SET LOCAL app.user_id = '';
DO $t$
DECLARE r record; n bigint;
BEGIN
  SELECT * INTO r FROM auth.consume_refresh_token('sha256:rotate-refresh');
  IF r.session_id IS NULL OR r.reuse_detected THEN
    RAISE EXCEPTION 'first exchange should succeed, got reuse=%', r.reuse_detected;
  END IF;
  RAISE NOTICE '   ok: a refresh token can be exchanged once';

  -- Presenting it again is theft, not a retry.
  SELECT * INTO r FROM auth.consume_refresh_token('sha256:rotate-refresh');
  IF NOT r.reuse_detected THEN
    RAISE EXCEPTION 'a reused refresh token was not detected';
  END IF;

  -- And the session it belonged to is gone, not merely refused.
  SELECT count(*) INTO n FROM auth.resolve_session_token('sha256:rotate-access');
  IF n <> 0 THEN
    RAISE EXCEPTION 'reuse was detected but the session still resolves';
  END IF;
  RAISE NOTICE '   ok: reuse revokes the whole session, not just the token';
END
$t$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- audit_log: ordinary tenant isolation, and append-only.
-- ---------------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '01920000-0000-7000-8000-00000000000a';
SET LOCAL app.user_id   = '01920000-0000-7000-8000-0000000000a1';
DO $t$
DECLARE n bigint;
BEGIN
  INSERT INTO public.audit_log (tenant_id, actor_user_id, resource, action, after)
  VALUES ('01920000-0000-7000-8000-00000000000a',
          '01920000-0000-7000-8000-0000000000a1',
          'tenant', 'update', '{"name": "renamed"}'::jsonb);

  SELECT count(*) INTO n FROM public.audit_log;
  IF n <> 1 THEN RAISE EXCEPTION 'expected 1 audit row, got %', n; END IF;

  BEGIN
    INSERT INTO public.audit_log (tenant_id, resource, action)
    VALUES ('01920000-0000-7000-8000-00000000000b', 'tenant', 'update');
    RAISE EXCEPTION 'WITH CHECK did not reject an audit row for tenant B';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE '   ok: cannot write an audit row into another tenant';
  END;

  BEGIN
    UPDATE public.audit_log SET action = 'something else';
    RAISE EXCEPTION 'an audit row was edited';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE '   ok: audit rows cannot be edited after the fact';
  END;
END
$t$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- The third flag level is no more of a backdoor than the other two.
-- ---------------------------------------------------------------------------
DO $t$
DECLARE n bigint;
BEGIN
  PERFORM set_config('app.auth_bootstrap', 'session', true);

  SELECT count(*) INTO n FROM public.sessions;
  IF n <> 0 THEN
    RAISE EXCEPTION 'app.auth_bootstrap=session leaked % session rows to app_role', n;
  END IF;

  SELECT count(*) INTO n FROM public.refresh_tokens;
  IF n <> 0 THEN
    RAISE EXCEPTION 'app.auth_bootstrap=session leaked % refresh tokens to app_role', n;
  END IF;

  SELECT count(*) INTO n FROM public.tenants;
  IF n <> 0 THEN
    RAISE EXCEPTION 'app.auth_bootstrap=session leaked % tenant rows to app_role', n;
  END IF;

  RAISE NOTICE '   ok: the session level grants app_role nothing either';
END
$t$;
