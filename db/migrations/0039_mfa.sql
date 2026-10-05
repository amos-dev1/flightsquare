-- ===========================================================================
-- 0039_mfa.sql — the second factor, by email, for everybody
--
-- `users.mfa_enabled` and `users.mfa_secret` have existed since `0001`,
-- `auth.find_user_by_email` has returned the first of them since `0002`, and
-- `/auth/login` has reported it as `mfa_required` ever since. Nothing has ever
-- set it, no client has ever read it, and no code path has ever acted on it.
-- This is that column becoming true, and meaning something.
--
-- ---------------------------------------------------------------------------
-- No twelfth door (§2.1)
--
-- The obvious instinct is a pair of new `auth.*` functions: one to send a code,
-- one to check it. Both would run with no tenant context, so both would qualify
-- — and both already exist. `auth.request_email_token` writes a hashed token and
-- queues a message; `auth.consume_auth_token` spends one, once, and will not let
-- a token of one kind be spent as another. A login code is an email token whose
-- kind nobody had declared yet.
--
-- So this migration adds a `kind` to two CHECK constraints and the list stays at
-- eleven. §2.1 says adding a function "is an architectural decision requiring
-- review"; not needing one is the better outcome.
--
-- **The code is salted with a challenge id, and that is load-bearing.**
-- `auth_tokens.token_hash` is UNIQUE and `consume_auth_token` looks a token up
-- by hash alone. Six digits hashed on their own would collide between two users
-- who happened to get the same code — and worse, either could spend the other's.
-- So the API hashes `${challenge_id}:${code}`, where the challenge id is 32
-- random bytes minted at the password check and returned to that caller only.
-- The row is then unique per attempt, and a code is worthless without the
-- challenge it belongs to.
--
-- ---------------------------------------------------------------------------
-- Mandatory, expressed as data rather than as an `if`
--
-- Every user gets it. That is not written as a constant in a route: the column
-- defaults to true, every existing row is backfilled to true, and **no grant
-- exists that could set it false** — `0009` gave `app_role` UPDATE on four
-- columns of `users` and this is not one of them. Mandatory is therefore the
-- default plus the absence of a door, which is the shape §1.3 asks for and which
-- leaves a per-user policy possible later without a release.
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
-- 1. Everybody, including everybody who already exists
-- ---------------------------------------------------------------------------

ALTER TABLE public.users ALTER COLUMN mfa_enabled SET DEFAULT true;

-- The backfill is the policy. A column that defaulted false for thirty-eight
-- migrations has rows in it that predate the decision.
UPDATE public.users SET mfa_enabled = true WHERE mfa_enabled = false;

COMMENT ON COLUMN public.users.mfa_enabled IS
  'True for everybody, and there is no grant that could make it false: '
  'mandatory email MFA is the default plus the absence of a door. Read by '
  'auth.find_user_by_email at the password check.';

COMMENT ON COLUMN public.users.mfa_secret IS
  'Unused, and expected to stay that way. Email MFA has no shared secret — the '
  'code is a single-use token in auth_tokens, hashed like every other. The '
  'column was speculative in 0001 and is left alone rather than dropped, '
  'because a TOTP factor would want exactly this and nothing reads it meanwhile.';

-- ---------------------------------------------------------------------------
-- 2. A login code is a kind of email token
-- ---------------------------------------------------------------------------

ALTER TABLE public.auth_tokens
  DROP CONSTRAINT auth_tokens_kind_check,
  ADD  CONSTRAINT auth_tokens_kind_check
    CHECK (kind IN ('email_verification', 'password_reset', 'mfa_code'));

ALTER TABLE public.outbox
  DROP CONSTRAINT outbox_kind_check,
  ADD  CONSTRAINT outbox_kind_check CHECK (kind IN (
    'email_verification', 'password_reset', 'invite',
    'booking_confirmed', 'booking_cancelled', 'squawk_filed',
    'maintenance_due', 'over_quota', 'mfa_code'));

-- ---------------------------------------------------------------------------
-- 3. A device that has already proved itself
--
-- Mandatory MFA without this is unusable in this product, and the reason is
-- §3.4's: the most important screen is filled in at a tiedown on a rural field
-- with one bar or none. A sign-in that depends on receiving an email at that
-- moment is a post-flight entry that does not happen, and §3.4 is explicit about
-- where that ends — stale meters and every maintenance number quietly wrong.
--
-- So a device that has passed a code once may skip it for thirty days. The row
-- belongs to a user and not to a tenant: one human has one login and many
-- memberships (§3.1), and the device is theirs across all of them.
-- ---------------------------------------------------------------------------

CREATE TABLE public.trusted_devices (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id     uuid NOT NULL REFERENCES public.users(id),

  /*
    The hash, never the token — the same rule `auth_tokens` and `sessions`
    follow. What the device holds is a bearer credential that skips a factor,
    so a database that leaked would otherwise hand over exactly that.
  */
  token_hash  text NOT NULL UNIQUE,

  /** 'ios' or 'web', for a list somebody has to recognise their own device in. */
  client      text,

  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  last_used_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX trusted_devices_user_idx
  ON public.trusted_devices (user_id, created_at DESC);

COMMENT ON TABLE public.trusted_devices IS
  'A device that has passed an email code and may skip the next one for thirty '
  'days. Keyed to a user rather than a tenant (§3.1). Read at the password '
  'check through auth.find_user_by_email, which is why it carries a bootstrap '
  'policy as well as the ordinary one.';

ALTER TABLE public.trusted_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trusted_devices FORCE  ROW LEVEL SECURITY;

/*
  Keyed on the user, like `sessions` and `refresh_tokens`.

  Not on the tenant: there is no tenant at the moment this is written — the
  device is trusted as the session is created, before anybody has chosen one.
*/
CREATE POLICY user_isolation ON public.trusted_devices
  FOR ALL TO app_role, flightsquare_owner
  USING      (user_id = app.current_user_id())
  WITH CHECK (user_id = app.current_user_id());

/*
  And the bootstrap read, because the lookup happens before there is a user.

  `auth.find_user_by_email` runs at `app.auth_bootstrap = 'on'` — the level
  `0001` defined as "read the lookups" — and it now has one more thing to read.
  The ladder is unchanged and nothing new is grantable: `db/tests/040` proves
  that `app_role` setting this flag by hand gains it nothing, which is what
  keeps the whole arrangement from being BYPASSRLS with extra steps.
*/
CREATE POLICY definer_bootstrap ON public.trusted_devices
  FOR SELECT TO flightsquare_owner
  USING (current_setting('app.auth_bootstrap', true) = 'on');

/*
  Insert when a code is accepted, and update only to retire one or stamp it.

  No DELETE: a device somebody revokes should still be a row, because "this
  laptop was trusted from March to June" is the question asked after an account
  is compromised. `token_hash` and `expires_at` are not updatable — a trust that
  could be extended in place is a thirty-day limit that means nothing.
*/
GRANT SELECT, INSERT ON public.trusted_devices TO app_role;
GRANT UPDATE (revoked_at, last_used_at) ON public.trusted_devices TO app_role;

-- §7.2: not even metadata. Which devices a person signs in from is of no use in
-- answering a support ticket, and `030` already refuses the control plane
-- `refresh_tokens` and `device_registrations` for the same reason.

-- ---------------------------------------------------------------------------
-- 4. The credential check learns about trusted devices
--
-- One lookup rather than two, because it is one decision: this address, this
-- hash, does this account need a second factor, and has this device already
-- given one. Rule 3 of §2.1 is satisfied — the new argument is a scalar matched
-- on equality, which is what a token hash is.
--
-- **Still STABLE.** The temptation is to stamp `last_used_at` here, which would
-- make the function a writer and move it onto `db/tests/030`'s list of auth
-- functions that write. The stamp happens afterwards, under the user context the
-- session creation already has.
--
-- DROP and CREATE rather than CREATE OR REPLACE: the return type gains a column
-- and Postgres will not replace a function's signature. The new argument carries
-- a default, so every existing one-argument call site — including `db/tests/040`
-- — still resolves.
-- ---------------------------------------------------------------------------

DROP FUNCTION auth.find_user_by_email(text);

CREATE FUNCTION auth.find_user_by_email(
  p_email             text,
  p_device_token_hash text DEFAULT NULL
)
RETURNS TABLE (
  user_id        uuid,
  password_hash  text,
  mfa_enabled    boolean,
  status         text,
  device_trusted boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET app.auth_bootstrap = 'on'
AS $$
  SELECT u.id, u.password_hash, u.mfa_enabled, u.status,
         -- A device is trusted for this user only. The join is on both, so a
         -- token lifted from one account is worth nothing against another.
         EXISTS (
           SELECT 1
             FROM public.trusted_devices d
            WHERE d.user_id = u.id
              AND p_device_token_hash IS NOT NULL
              AND d.token_hash = p_device_token_hash
              AND d.revoked_at IS NULL
              AND d.expires_at > now()
         ) AS device_trusted
    FROM public.users u
   WHERE lower(u.email) = lower(p_email)
     AND u.deleted_at IS NULL
$$;

REVOKE ALL ON FUNCTION auth.find_user_by_email(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.find_user_by_email(text, text) TO app_role;

COMMENT ON FUNCTION auth.find_user_by_email(text, text) IS
  '§2.1. Equality on lower(email), matching the unique index. The caller '
  'compares the hash and must take the same time whether or not a row came '
  'back — this function is an existence oracle if the caller lets it be. '
  '`device_trusted` answers the second half of the same question: whether this '
  'device has already passed a code, which is read here because there is no '
  'user context yet to read it under.';
