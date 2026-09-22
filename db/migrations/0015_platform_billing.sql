-- ===========================================================================
-- 0015_platform_billing.sql — M7: what the tenant pays FlightSquare
--
-- The other money system (§3.7's left-hand column). Member billing is pilot
-- to club and shipped in 0013; this is tenant to FlightSquare, and the two
-- must never be called "billing" without a qualifier.
--
-- The whole entitlement substrate already exists — plans, plan_entitlements,
-- overrides, tenant_usage, assert_quota, and the §1.4 chain over them. What
-- has never existed is anything that can *change a plan*: `tenants.plan_code`
-- carries no grant for app_role (0001 gives it UPDATE on name and branding,
-- and nothing else), so until now the only writer was the test fixture.
--
-- That gap is deliberate and this migration keeps it. A role that can write
-- its own plan_code grants itself every entitlement in the registry, which is
-- the same shape of hole as a role that can zero its own usage counters
-- (§4.5). So the write arrives as a §2.3 privileged helper rather than as a
-- grant, and the application still cannot reach the column.
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

-- ===========================================================================
-- The catalogue learns what can be bought
--
-- A lookup key, not a price id. Stripe issues a different price id in test
-- mode and in live, and a migration cannot know which database it is running
-- against — so the durable thing to store is the name we gave the price
-- (`lookup_key` on Stripe's side), and the provider resolves it at checkout.
--
-- No amount is stored. The plan screen shows what the provider will actually
-- charge, fetched by lookup key, because a price kept in two places is the
-- same failure as a charge that references a mutable rate (§3.7 rule 1): the
-- copy drifts and the first person to notice is the customer.
-- ===========================================================================

ALTER TABLE public.plans
  ADD COLUMN self_serve       boolean NOT NULL DEFAULT false,
  ADD COLUMN price_lookup_key text;

COMMENT ON COLUMN public.plans.self_serve IS
  'Whether this plan can be bought without talking to anybody. Free is not '
  'self-serve because there is nothing to buy; a plan with no '
  'price_lookup_key cannot be, whatever this says.';
COMMENT ON COLUMN public.plans.price_lookup_key IS
  'The billing provider''s lookup key for this plan''s price — stable across '
  'test and live, unlike a price id. NULL means "not for sale here".';

UPDATE public.plans
   SET self_serve = true, price_lookup_key = 'pro_monthly'
 WHERE code = 'pro';
UPDATE public.plans
   SET self_serve = true, price_lookup_key = 'enterprise_monthly'
 WHERE code = 'enterprise';

-- ===========================================================================
-- subscriptions — tenant-scoped (§2.2), readable by the tenant, written by
-- nobody but the helper below.
--
-- One row per tenant. A tenant that has never paid has no row at all, and
-- resolves against `tenants.plan_code`, which is 'free' by default — so the
-- absence of a subscription is a valid, complete state rather than a gap.
-- ===========================================================================

CREATE TABLE public.subscriptions (
  id                       uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id                uuid NOT NULL UNIQUE REFERENCES public.tenants(id),

  provider                 text NOT NULL DEFAULT 'stripe',
  /**
   * The provider's id for the subscription. Unique across tenants: two
   * tenants pointing at one subscription would mean a billing mix-up we
   * would rather fail loudly on than reconcile later.
   */
  provider_subscription_id text NOT NULL,

  /**
   * What the subscription is *for*, which is not always what the tenant is
   * *on*. A cancelled Pro subscription leaves this at 'pro' and moves
   * `tenants.plan_code` to 'free', so the screen can say "your Pro
   * subscription ended on the 14th" rather than losing the fact that there
   * ever was one.
   */
  plan_code                text NOT NULL REFERENCES public.plans(code),

  /**
   * The provider's vocabulary, kept as the provider says it. Mapping it onto
   * our own `tenants.status` is a decision, and decisions belong where they
   * can be read (the API), not buried in a column that has lost the original.
   */
  status                   text NOT NULL,

  current_period_end       timestamptz,
  /**
   * §5.1: downgrades take effect at the end of the current paid period. For
   * paid → free that is exactly this flag, and it is what lets the UI say
   * "Pro until 14 October, then Free" rather than springing it on somebody.
   */
  cancel_at_period_end     boolean NOT NULL DEFAULT false,

  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT subscriptions_provider_subscription_key
    UNIQUE (provider, provider_subscription_id),
  CONSTRAINT subscriptions_status_check CHECK (status IN (
    'trialing', 'active', 'past_due', 'unpaid',
    'canceled', 'incomplete', 'incomplete_expired', 'paused'
  ))
);

-- §6.1 item 4: an index leading with tenant_id. The UNIQUE above is one.

CREATE TRIGGER subscriptions_set_updated_at
  BEFORE UPDATE ON public.subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ===========================================================================
-- billing_events — tenant-scoped, append-only, and the whole of our
-- idempotency story.
--
-- A provider retries a webhook it did not hear a 200 for, and it is entitled
-- to: the delivery failed, as far as it knows. The unique key is what makes
-- the second delivery a no-op instead of a second plan change.
--
-- The payload is deliberately not stored. The provider keeps that, and it is
-- their customer's billing detail; what we need to know is that we saw event
-- X, of type Y, and acted. That keeps this row in §7.2's metadata tier where
-- support can read it, rather than in the content tier where it would need a
-- consent grant to look at.
-- ===========================================================================

CREATE TABLE public.billing_events (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id         uuid NOT NULL REFERENCES public.tenants(id),
  provider          text NOT NULL DEFAULT 'stripe',
  provider_event_id text NOT NULL,
  type              text NOT NULL,
  received_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT billing_events_provider_event_key
    UNIQUE (provider, provider_event_id)
);

CREATE INDEX billing_events_tenant_idx
  ON public.billing_events (tenant_id, received_at DESC);

-- ===========================================================================
-- §2.3 privileged helper, entry 9 — the mapping from a customer to a tenant
--
-- Could app_role simply be granted UPDATE (billing_customer_id) on tenants?
-- No. That column is the only thing that tells a webhook which tenant an
-- event belongs to (auth.tenant_for_billing_customer, §2.1). A role that can
-- write it can point its own tenant at another club's customer id and
-- inherit whatever that club is paying for, and the audit trail would show
-- nothing but a settings save.
--
-- Write-once, and only from NULL. Re-pointing an existing mapping is not a
-- thing the product does; if it ever becomes one it is an admin action with
-- a reason attached, not a side effect of somebody pressing Upgrade.
-- ===========================================================================

CREATE FUNCTION public.set_billing_customer(p_customer_id text)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET app.auth_bootstrap = 'billing'
AS $$
DECLARE
  v_tenant   uuid := app.current_tenant_id();
  v_existing text;
BEGIN
  -- §2.3 rule 1: no context is an exception, never a permissive default.
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'set_billing_customer requires tenant context'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_customer_id IS NULL OR p_customer_id = '' THEN
    RAISE EXCEPTION 'set_billing_customer requires a customer id'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT t.billing_customer_id INTO v_existing
    FROM public.tenants t WHERE t.id = v_tenant FOR UPDATE;

  IF v_existing IS NOT NULL THEN
    IF v_existing = p_customer_id THEN
      RETURN;  -- Already ours. Idempotent, because checkout can be retried.
    END IF;
    RAISE EXCEPTION 'tenant already has a billing customer'
      USING ERRCODE = 'unique_violation';
  END IF;

  UPDATE public.tenants
     SET billing_customer_id = p_customer_id, updated_at = now()
   WHERE id = v_tenant;
END
$$;

REVOKE ALL ON FUNCTION public.set_billing_customer(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_billing_customer(text) TO app_role;

COMMENT ON FUNCTION public.set_billing_customer(text) IS
  '§2.3 privileged helper. Records this tenant''s billing-provider customer '
  'id, once, from NULL only. Takes no tenant argument: the tenant comes from '
  'context, so it cannot be aimed at another club''s account.';

-- ===========================================================================
-- §2.3 privileged helper, entry 10 — the plan change itself
--
-- Could app_role simply be granted UPDATE (plan_code, status) on tenants?
-- Emphatically not. plan_code is the left-hand layer of §1.4's chain: a role
-- that can write it resolves itself onto every flag and every quota in the
-- registry, and `assert_quota` would go on dutifully enforcing a limit the
-- caller had just rewritten. It is the single most valuable column in the
-- schema to an attacker who has reached the application role, and the answer
-- is the same one §4.5 gives for usage counters — hold the privilege here,
-- behind a function whose tenant comes from context.
--
-- What it will not do:
--   * point at another tenant (no tenant argument, §2.3 rule 2),
--   * invent a plan (plan_code is a foreign key into the catalogue),
--   * resurrect a suspended or closed tenant. §7.3 makes those admin acts,
--     and a payment succeeding is not an appeal.
--
-- The *mapping* from a provider's status to ours is not here on purpose. It
-- is a decision, it will be argued about, and it belongs where somebody can
-- read it next to its reasons (api/src/billing) rather than inside a
-- function that only holds a privilege. This checks what it is handed and
-- writes it.
-- ===========================================================================

CREATE FUNCTION public.apply_subscription(
  p_provider                 text,
  p_provider_subscription_id text,
  /** What the subscription is for — 'pro' even once it is cancelled. */
  p_subscription_plan_code   text,
  /** What the tenant is entitled to now — 'free' once it is cancelled. */
  p_effective_plan_code      text,
  p_subscription_status      text,
  p_tenant_status            text,
  p_current_period_end       timestamptz,
  p_cancel_at_period_end     boolean
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET app.auth_bootstrap = 'billing'
AS $$
DECLARE
  v_tenant  uuid := app.current_tenant_id();
  v_current text;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'apply_subscription requires tenant context'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- The three a webhook may ever produce. 'suspended' and 'closed' are not
  -- on this list, so no payment event can reach them even by accident.
  IF p_tenant_status NOT IN ('trial', 'active', 'past_due') THEN
    RAISE EXCEPTION 'apply_subscription cannot set tenant status %', p_tenant_status
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  INSERT INTO public.subscriptions AS s (
    tenant_id, provider, provider_subscription_id, plan_code, status,
    current_period_end, cancel_at_period_end
  )
  VALUES (
    v_tenant, p_provider, p_provider_subscription_id, p_subscription_plan_code,
    p_subscription_status, p_current_period_end, p_cancel_at_period_end
  )
  ON CONFLICT (tenant_id) DO UPDATE SET
    provider                 = EXCLUDED.provider,
    provider_subscription_id = EXCLUDED.provider_subscription_id,
    plan_code                = EXCLUDED.plan_code,
    status                   = EXCLUDED.status,
    current_period_end       = EXCLUDED.current_period_end,
    cancel_at_period_end     = EXCLUDED.cancel_at_period_end,
    updated_at               = now();

  SELECT t.status INTO v_current FROM public.tenants t WHERE t.id = v_tenant;

  UPDATE public.tenants
     SET plan_code  = p_effective_plan_code,
         -- An admin who suspended or closed this tenant outranks the
         -- provider. Their plan still moves — they are still being billed
         -- for something — but the door stays shut.
         status     = CASE WHEN v_current IN ('trial', 'active', 'past_due')
                           THEN p_tenant_status ELSE v_current END,
         updated_at = now()
   WHERE id = v_tenant;
END
$$;

REVOKE ALL ON FUNCTION public.apply_subscription(
  text, text, text, text, text, text, timestamptz, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_subscription(
  text, text, text, text, text, text, timestamptz, boolean) TO app_role;

COMMENT ON FUNCTION public.apply_subscription(
  text, text, text, text, text, text, timestamptz, boolean) IS
  '§2.3 privileged helper. The only path to tenants.plan_code. Takes no '
  'tenant argument — the tenant comes from context — and cannot set a tenant '
  'to suspended or closed, nor move one that already is.';

-- ===========================================================================
-- Row-level security
-- ===========================================================================

ALTER TABLE public.subscriptions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscriptions  FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.billing_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_events FORCE  ROW LEVEL SECURITY;

-- A tenant reads its own subscription and cannot write it. The USING and
-- WITH CHECK pair is still both halves (§1.1) — the WITH CHECK is what the
-- owner-side policy below is measured against, and without it a future grant
-- would silently open a write with no tenant predicate.
CREATE POLICY tenant_isolation ON public.subscriptions
  FOR ALL TO app_role, flightsquare_owner
  USING      (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY tenant_isolation ON public.billing_events
  FOR ALL TO app_role, flightsquare_owner
  USING      (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

-- The 'billing' level: what the two helpers above need, and nothing else.
-- They run as the owner, and the owner is subject to FORCE RLS like anyone
-- else, so without these they would fail exactly as app_role does.
CREATE POLICY definer_billing ON public.subscriptions
  FOR ALL TO flightsquare_owner
  USING      (current_setting('app.auth_bootstrap', true) = 'billing')
  WITH CHECK (current_setting('app.auth_bootstrap', true) = 'billing');

-- tenants gains an UPDATE door at this level. The existing definer_bootstrap
-- on tenants is FOR SELECT, and is left alone: reading a tenant to log
-- somebody in must not become a way to write one.
CREATE POLICY definer_billing ON public.tenants
  FOR UPDATE TO flightsquare_owner
  USING      (current_setting('app.auth_bootstrap', true) = 'billing')
  WITH CHECK (current_setting('app.auth_bootstrap', true) = 'billing');

-- The helpers read the tenant row they are about to write (FOR UPDATE, and
-- the status check), which needs a SELECT the bootstrap policy does not give
-- at this level.
CREATE POLICY definer_billing_read ON public.tenants
  FOR SELECT TO flightsquare_owner
  USING (current_setting('app.auth_bootstrap', true) = 'billing');

-- §7.2 metadata tier. `subscriptions` is named there explicitly: it is what
-- support needs to answer "what are they paying for and is it failing?"
-- without touching a squawk or a flight.
CREATE POLICY admin_read ON public.subscriptions
  FOR SELECT TO admin_role USING (true);
CREATE POLICY admin_read ON public.billing_events
  FOR SELECT TO admin_role USING (true);

-- ===========================================================================
-- Privileges
--
-- subscriptions is read-only to app_role for the same reason tenant_usage is
-- (§4.5): the row says what the tenant is entitled to, so a role that can
-- write it can award itself a plan without going near plan_code.
--
-- billing_events takes an INSERT because the idempotency check *is* the
-- insert — the unique key refuses the replay. No UPDATE and no DELETE, so
-- the record of what we acted on cannot be rewritten afterwards.
-- ===========================================================================

GRANT SELECT         ON public.subscriptions  TO app_role, admin_role;
GRANT SELECT, INSERT ON public.billing_events TO app_role;
GRANT SELECT         ON public.billing_events TO admin_role;
