import { sql } from 'kysely';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type {
  BillingRedirectResponse,
  PlanResponse,
  SubscriptionResponse,
  SubscriptionStatus,
} from '@flightsquare/shared';

import { billingProvider, type ProviderPrice } from '../../billing/index.js';
import { config } from '../../config.js';
import { Entitlements } from '../../entitlements/resolver.js';
import { isUnlimited, type QuotaValue } from '../../entitlements/values.js';
import { InvalidRequestError, NotFoundError } from '../errors.js';

const checkoutSchema = {
  body: {
    type: 'object',
    required: ['plan_code'],
    additionalProperties: false,
    properties: {
      plan_code: { type: 'string', maxLength: 32 },
    },
  },
} as const;

/**
 * Platform billing (§3.7's left-hand column) — what the tenant pays
 * FlightSquare. Not `/billing`, which is member billing and belongs to the
 * club's own treasurer.
 *
 * Every route here is web-only, and that is not a preference. §8.3 keeps
 * subscription purchase off the iOS app because Apple's 3.1.3(f) exempts a
 * free companion app from in-app purchase *provided there is no purchasing
 * inside the app and no call to action to purchase outside it* — and because
 * an in-app-purchase subscription belongs to an Apple ID rather than to an
 * organisation, which for a multi-tenant product is structurally broken
 * rather than merely expensive. The app hits a quota, reads the 402, and
 * explains the limit without mentioning a price or a URL.
 *
 * Refusing a non-web client here is belt and braces: nothing in the app calls
 * these, and if a future build did, the server would not help it.
 */
export async function subscriptionRoutes(app: FastifyInstance): Promise<void> {
  /**
   * The catalogue, with what each plan would actually give.
   *
   * §8.1: the client must never carry a table of what Pro includes, because
   * that table goes stale on the App Store and cannot be corrected without a
   * release. So the comparison is resolved here, from the same rows §1.4
   * resolves against, and the price is asked of the provider rather than
   * stored — a price kept in two places drifts, and the first to notice is
   * the customer.
   */
  app.get(
    '/plans',
    { config: { requiresTenant: true, permission: ['subscription', 'read'] } },
    async (request) => {
      const { entitlements } = await request.loadGates();

      const [plans, rows] = await request.withTenant((trx) =>
        Promise.all([
          trx
            .selectFrom('plans')
            .select(['code', 'name', 'description', 'sort_order', 'self_serve', 'price_lookup_key'])
            .orderBy('sort_order')
            .execute(),
          trx.selectFrom('plan_entitlements').select(['plan_code', 'key', 'value']).execute(),
        ]),
      );

      const provider = billingProvider();
      const lookupKeys = plans
        .map((plan) => plan.price_lookup_key)
        .filter((key): key is string => key !== null);

      // A provider that cannot be reached must not take the screen down with
      // it: the plans are still worth showing, just without their prices.
      const prices = await provider
        .pricesFor(lookupKeys)
        .catch((): Map<string, ProviderPrice> => new Map());

      return plans.map((plan): PlanResponse => {
        // Resolved against the plan alone — an override is a bespoke
        // arrangement with one tenant, not part of what this plan is.
        const resolved = new Entitlements({
          planCode: plan.code,
          plan: new Map(
            rows.filter((row) => row.plan_code === plan.code).map((row) => [row.key, row.value]),
          ),
          overrides: new Map(),
        });

        const flags: Record<string, boolean> = {};
        const quotas: Record<string, number | 'unlimited'> = {};
        for (const entry of resolved.all()) {
          const kind = resolved.kindOf(entry.key);
          if (kind === 'flag') flags[entry.key] = entry.value as boolean;
          else if (kind === 'quota') {
            const quota = entry.value as QuotaValue;
            quotas[entry.key] = isUnlimited(quota) ? 'unlimited' : (quota as { value: number }).value;
          }
        }

        const price = plan.price_lookup_key ? prices.get(plan.price_lookup_key) : undefined;

        return {
          code: plan.code,
          name: plan.name,
          description: plan.description,
          sort_order: plan.sort_order,
          // A plan with no price cannot be bought here whatever the column
          // says — and saying otherwise would offer a button that 500s.
          self_serve: plan.self_serve && price !== undefined,
          ...(price ? { price } : {}),
          flags,
          quotas,
          current: plan.code === entitlements.planCode,
        };
      });
    },
  );

  /** What they are on, and what is about to happen to it. */
  app.get(
    '/subscription',
    { config: { requiresTenant: true, permission: ['subscription', 'read'] } },
    async (request) => {
      const { entitlements } = await request.loadGates();

      const subscription = await request.withTenant((trx) =>
        trx
          .selectFrom('subscriptions')
          .select(['status', 'current_period_end', 'cancel_at_period_end'])
          .executeTakeFirst(),
      );

      return {
        plan_code: entitlements.planCode,
        // Null is a complete answer: a tenant that has never paid has no
        // subscription row, and Free is a product rather than an absence.
        status: (subscription?.status as SubscriptionStatus | undefined) ?? null,
        current_period_end: subscription?.current_period_end?.toISOString() ?? null,
        cancel_at_period_end: subscription?.cancel_at_period_end ?? false,
        provider_configured: billingProvider().configured,
      } satisfies SubscriptionResponse;
    },
  );

  /**
   * Start a purchase.
   *
   * The customer is created *here*, inside a request that has a real session
   * and real tenant context, and stored through a §2.3 helper. That is what
   * lets every webhook afterwards resolve its tenant from the customer id
   * through §2.1's door instead of trusting something in a request body,
   * which §1.1 forbids outright.
   */
  app.post<{ Body: { plan_code: string } }>(
    '/subscription/checkout',
    {
      schema: checkoutSchema,
      config: { requiresTenant: true, permission: ['subscription', 'write'] },
    },
    async (request) => {
      requireWebClient(request);
      const provider = billingProvider();

      const plan = await request.withTenant((trx) =>
        trx
          .selectFrom('plans')
          .select(['code', 'name', 'self_serve', 'price_lookup_key'])
          .where('code', '=', request.body.plan_code)
          .executeTakeFirst(),
      );

      if (!plan?.self_serve || !plan.price_lookup_key) {
        // Enterprise-by-conversation, a retired plan, or a typo. §6: the
        // three read the same from outside.
        throw new NotFoundError();
      }

      const { tenant, email, customerId } = await request.withTenant(async (trx) => {
        const [tenantRow, userRow] = await Promise.all([
          trx.selectFrom('tenants').select(['name', 'billing_customer_id']).executeTakeFirst(),
          trx
            .selectFrom('users')
            .select('email')
            .where('id', '=', request.ctx!.userId)
            .executeTakeFirst(),
        ]);
        return {
          tenant: tenantRow,
          email: userRow?.email ?? '',
          customerId: tenantRow?.billing_customer_id ?? null,
        };
      });

      if (!tenant) throw new NotFoundError();

      const customer =
        customerId ??
        (await createCustomer(request, {
          tenantId: request.ctx!.tenantId!,
          tenantName: tenant.name,
          email,
        }));

      const session = await provider.createCheckoutSession({
        customerId: customer,
        priceLookupKey: plan.price_lookup_key,
        tenantId: request.ctx!.tenantId!,
        successUrl: `${config.web.baseUrl}/settings/subscription?checkout=success`,
        cancelUrl: `${config.web.baseUrl}/settings/subscription?checkout=cancelled`,
      });

      return { url: session.url } satisfies BillingRedirectResponse;
    },
  );

  /**
   * Everything after the first purchase: card, invoices, switching plan, and
   * cancelling.
   *
   * §5.1 wants a downgrade to take effect at the end of the paid period, and
   * the provider's own "cancel at period end" is exactly that — so sending
   * people here rather than building a second plan-change UI keeps one
   * system of record and avoids subscription schedules entirely.
   */
  app.post(
    '/subscription/portal',
    { config: { requiresTenant: true, permission: ['subscription', 'write'] } },
    async (request) => {
      requireWebClient(request);

      const tenant = await request.withTenant((trx) =>
        trx.selectFrom('tenants').select('billing_customer_id').executeTakeFirst(),
      );

      // Never paid, so there is nothing to manage. Not an error state worth
      // its own code — there is simply no portal for this tenant yet.
      if (!tenant?.billing_customer_id) throw new NotFoundError();

      const session = await billingProvider().createPortalSession({
        customerId: tenant.billing_customer_id,
        returnUrl: `${config.web.baseUrl}/settings/subscription`,
      });

      return { url: session.url } satisfies BillingRedirectResponse;
    },
  );
}

/**
 * §8.3, enforced rather than documented.
 *
 * 404 rather than 403: a route that answers "you are not allowed to buy
 * things from this client" is itself a call to action, and the clause the
 * iOS app relies on is about there being none.
 */
function requireWebClient(request: FastifyRequest): void {
  const client = request.headers['x-flightsquare-client'];
  if (client !== 'web') throw new NotFoundError();
}

async function createCustomer(
  request: FastifyRequest,
  input: { tenantId: string; tenantName: string; email: string },
): Promise<string> {
  if (!input.email) {
    throw new InvalidRequestError('an account needs an email address before it can be billed');
  }

  const customerId = await billingProvider().ensureCustomer(input);

  // §2.3 helper: app_role holds no grant on this column, because a role that
  // can write it can point its tenant at another club's customer and inherit
  // whatever they are paying for.
  await request.withTenant((trx) =>
    sql`SELECT public.set_billing_customer(${customerId})`.execute(trx),
  );

  return customerId;
}
