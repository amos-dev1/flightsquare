import type { FastifyInstance } from 'fastify';
import type { PlanResponse } from '@flightsquare/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { setBillingProvider, StubProvider } from '../src/billing/index.js';
import { config } from '../src/config.js';
import { closeDatabase } from '../src/db/pool.js';
import { buildServer } from '../src/http/server.js';
import type { ResolvedSession } from '../src/http/session.js';
import { UnauthorizedError } from '../src/http/errors.js';
import {
  addTestMember,
  cleanupTestTenants,
  provisionTestTenant,
  readAuditLog,
  readTenantRow,
} from './helpers/fixtures.js';

const SESSION_ID = '01920000-0000-7000-8000-0000000000e0';

afterAll(async () => {
  await cleanupTestTenants();
  setBillingProvider(null);
  await closeDatabase();
});

/**
 * Platform billing (§3.7's left-hand column) through the API.
 *
 * The assertions that matter most are the two that are easy to get wrong and
 * expensive to discover: an unverifiable webhook changes nothing, and a
 * replayed one changes nothing a second time. Everything else is in service
 * of a plan that only ever moves because the provider said so.
 */
describe('platform billing', () => {
  let app: FastifyInstance;
  let stub: ResolvedSession | null = null;
  let provider: StubProvider;
  let club: Awaited<ReturnType<typeof provisionTestTenant>>;
  let pilot: Awaited<ReturnType<typeof addTestMember>>;

  beforeAll(async () => {
    await cleanupTestTenants();
    club = await provisionTestTenant('subscription');
    pilot = await addTestMember(club.tenant_id, 'subscription-pilot', 'pilot');

    // The stub signs the way Stripe does, so the route under test is the
    // route that runs in production — parser, signature check and all.
    provider = new StubProvider(config.billing.webhookSecret, config.billing.apiBaseUrl);
    setBillingProvider(provider);

    app = buildServer({
      resolveSession: async () => {
        if (!stub) throw new UnauthorizedError();
        return stub;
      },
    });
    await app.ready();
    asAdmin();
  });

  afterAll(async () => {
    await app.close();
  });

  function asAdmin(): void {
    stub = { sessionId: SESSION_ID, userId: club.user_id, tenantId: club.tenant_id };
  }
  function asPilot(): void {
    stub = { sessionId: SESSION_ID, userId: pilot.user_id, tenantId: club.tenant_id };
  }

  /** Whatever the provider would have sent, delivered the way it would. */
  function deliver(type: string, customerId: string) {
    const subscription = provider.subscriptionFor(customerId);
    const { body, signature } = provider.deliverable(type, customerId, subscription);
    return app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': signature },
      payload: body,
    });
  }

  function customerId(): string {
    return `cus_stub_${club.tenant_id.replaceAll('-', '').slice(0, 16)}`;
  }

  async function planCode(): Promise<string> {
    const entitlements = await app.inject({ method: 'GET', url: '/entitlements' });
    return entitlements.json().plan_code;
  }

  it('is invisible to somebody who does not hold the subscription resource', async () => {
    asPilot();
    // §4.4 gives a Pilot `subscription: none`, and §1.6 answers a missing
    // level with 403 — the module exists, they simply may not use it.
    expect((await app.inject({ method: 'GET', url: '/subscription' })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/plans' })).statusCode).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/subscription/checkout',
          headers: { 'x-flightsquare-client': 'web' },
          payload: { plan_code: 'pro' },
        })
      ).statusCode,
    ).toBe(403);
    asAdmin();
  });

  it('will not sell anything to a client that is not the web app', async () => {
    // §8.3: the iOS app relies on Apple's 3.1.3(f), which exempts a free
    // companion app from in-app purchase only while there is no purchasing
    // inside it and no call to action to purchase outside it. 404 rather
    // than 403, because "you may not buy here" is itself a call to action.
    const fromPhone = await app.inject({
      method: 'POST',
      url: '/subscription/checkout',
      headers: { 'x-flightsquare-client': 'ios' },
      payload: { plan_code: 'pro' },
    });
    expect(fromPhone.statusCode).toBe(404);
  });

  it('offers the plans with what each one would actually give', async () => {
    const plans = await app.inject({
      method: 'GET',
      url: '/plans',
      headers: { 'x-flightsquare-client': 'web' },
    });
    expect(plans.statusCode).toBe(200);

    const byCode = new Map<string, PlanResponse>(
      (plans.json() as PlanResponse[]).map((plan) => [plan.code, plan] as const),
    );

    // §8.1: resolved here, never a table compiled into a client.
    expect(byCode.get('free')?.quotas['members.active']).toBe(1);
    expect(byCode.get('pro')?.quotas['members.active']).toBe(5);
    expect(byCode.get('enterprise')?.quotas['members.active']).toBe('unlimited');
    expect(byCode.get('pro')?.flags['member_billing']).toBe(true);

    // Free is not for sale; the other two are, and carry a price.
    expect(byCode.get('free')?.self_serve).toBe(false);
    expect(byCode.get('pro')?.self_serve).toBe(true);
    expect(byCode.get('pro')?.price?.amount_cents).toBeGreaterThan(0);
    expect(byCode.get('free')?.current).toBe(true);
  });

  it('creates the customer once, in the request that has a session', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/subscription/checkout',
      headers: { 'x-flightsquare-client': 'web' },
      payload: { plan_code: 'pro' },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().url).toContain('/billing/stub/checkout');

    // §1.1: the webhook resolves its tenant from this mapping rather than
    // from anything in a request body, which is why it is written here —
    // under a real session — and not discovered later.
    const second = await app.inject({
      method: 'POST',
      url: '/subscription/checkout',
      headers: { 'x-flightsquare-client': 'web' },
      payload: { plan_code: 'pro' },
    });
    expect(second.statusCode).toBe(200);

    const rows = await readTenantRow(club.tenant_id);
    expect(rows.billing_customer_id).toBe(customerId());
  });

  it('refuses to sell a plan that is not for sale', async () => {
    const free = await app.inject({
      method: 'POST',
      url: '/subscription/checkout',
      headers: { 'x-flightsquare-client': 'web' },
      payload: { plan_code: 'free' },
    });
    expect(free.statusCode).toBe(404);
  });

  it('changes nothing for a webhook it cannot verify', async () => {
    provider.start(customerId(), 'pro_monthly');
    const { body } = provider.deliverable(
      'customer.subscription.created',
      customerId(),
      provider.subscriptionFor(customerId()),
    );

    const forged = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=deadbeef' },
      payload: body,
    });

    expect(forged.statusCode).toBe(400);
    expect(await planCode()).toBe('free');

    const unsigned = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      headers: { 'content-type': 'application/json' },
      payload: body,
    });
    expect(unsigned.statusCode).toBe(400);
    expect(await planCode()).toBe('free');
  });

  it('moves the plan, and records what the tenant gained', async () => {
    const before = await readAuditLog(club.tenant_id);

    const delivered = await deliver('customer.subscription.created', customerId());
    expect(delivered.statusCode).toBe(200);
    expect(delivered.json().status).toBe('applied');

    expect(await planCode()).toBe('pro');

    const entitlements = await app.inject({ method: 'GET', url: '/entitlements' });
    expect(entitlements.json().quotas['members.active'].limit).toBe(5);
    expect(entitlements.json().flags.member_billing).toBe(true);
    // §4.5 counts in the database; this is the count coming back out, which
    // is what lets a screen say "2 of 5" rather than waiting for a 402.
    expect(entitlements.json().quotas['members.active'].current).toBe(2);

    // §5.9: the before and after are the resolved entitlements, not the plan
    // code — "why did they lose maintenance in March" is not answerable from
    // `pro → free`.
    const after = await readAuditLog(club.tenant_id);
    expect(after.length).toBe(before.length + 1);
    const entry = after.at(-1)!;
    expect(entry.action).toBe('plan_changed');
    expect(entry.actor_user_id).toBeNull();
    expect((entry.before as { plan_code: string }).plan_code).toBe('free');
    expect((entry.after as { plan_code: string }).plan_code).toBe('pro');
    expect((entry.before as { flags: Record<string, boolean> }).flags.member_billing).toBe(false);
    expect((entry.after as { flags: Record<string, boolean> }).flags.member_billing).toBe(true);
  });

  it('does nothing at all the second time it is told', async () => {
    const subscription = provider.subscriptionFor(customerId());
    const { body, signature } = provider.deliverable(
      'customer.subscription.updated',
      customerId(),
      subscription,
    );

    const send = () =>
      app.inject({
        method: 'POST',
        url: '/webhooks/stripe',
        headers: { 'content-type': 'application/json', 'stripe-signature': signature },
        payload: body,
      });

    expect((await send()).json().status).not.toBe('replayed');
    // A provider retries anything it did not hear a 200 for, and it is right
    // to. The unique key is what makes the second delivery a no-op.
    expect((await send()).json().status).toBe('replayed');
  });

  it('says when a cancellation takes effect rather than springing it', async () => {
    provider.update(customerId(), { cancelAtPeriodEnd: true });
    await deliver('customer.subscription.updated', customerId());

    const subscription = await app.inject({ method: 'GET', url: '/subscription' });
    expect(subscription.json().cancel_at_period_end).toBe(true);
    expect(subscription.json().current_period_end).toBeTruthy();
    // §5.1: it takes effect at the end of the paid period, so until then
    // nothing has been taken away.
    expect(subscription.json().plan_code).toBe('pro');
    expect(await planCode()).toBe('pro');
  });

  it('keeps a club running on a failed card', async () => {
    provider.update(customerId(), { status: 'past_due' });
    await deliver('customer.subscription.updated', customerId());

    // §7.3 has past_due as a usable state, and session resolution already
    // treats it as one. Locking a club out of its maintenance records over
    // an expired Visa would be both hostile and unsafe.
    expect((await app.inject({ method: 'GET', url: '/tenant' })).statusCode).toBe(200);
    expect(await planCode()).toBe('pro');
    expect((await readTenantRow(club.tenant_id)).status).toBe('past_due');

    provider.update(customerId(), { status: 'active' });
    await deliver('customer.subscription.updated', customerId());
    expect((await readTenantRow(club.tenant_id)).status).toBe('active');
  });

  it('drops to free at the end without destroying anything', async () => {
    const membersBefore = await app.inject({ method: 'GET', url: '/members' });
    expect(membersBefore.json()).toHaveLength(2);

    provider.update(customerId(), { status: 'canceled', cancelAtPeriodEnd: false });
    await deliver('customer.subscription.deleted', customerId());

    expect(await planCode()).toBe('free');

    // §5: a plan change never destroys data. The second member is still
    // there, over the limit and entirely intact — creating another is what
    // gets refused, not keeping this one.
    const membersAfter = await app.inject({ method: 'GET', url: '/members' });
    expect(membersAfter.json()).toHaveLength(2);

    const entitlements = await app.inject({ method: 'GET', url: '/entitlements' });
    expect(entitlements.json().quotas['members.active'].limit).toBe(1);
    expect(entitlements.json().quotas['members.active'].current).toBe(2);

    // The subscription row keeps what it was for, so the screen can say
    // which plan ended rather than losing that there ever was one.
    const subscription = await app.inject({ method: 'GET', url: '/subscription' });
    expect(subscription.json().status).toBe('canceled');
    expect(subscription.json().plan_code).toBe('free');
  });

  it('ignores an event for a customer that is not ours', async () => {
    const { body, signature } = provider.deliverable(
      'customer.subscription.updated',
      'cus_somebody_else',
      undefined,
    );

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': signature },
      payload: body,
    });

    // 200, not 404: anything else and the provider retries forever for an
    // event we will never own.
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('unknown_customer');
  });
});
