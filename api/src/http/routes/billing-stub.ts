import type { FastifyInstance } from 'fastify';

import { billingProvider, StubProvider } from '../../billing/index.js';
import { config } from '../../config.js';
import { NotFoundError } from '../errors.js';

/**
 * The provider's own pages, when the provider is the stub.
 *
 * Stripe hosts checkout and the billing portal; with no key configured,
 * somebody has to, and it is these two routes. They are deliberately ugly:
 * they stand in for pages we do not own and will never ship, and making them
 * look like FlightSquare would only invite somebody to mistake one for a
 * screen we are responsible for.
 *
 * What they are good for is the part that is hard to test any other way —
 * cancelling at period end, a failed payment, a switch between paid plans —
 * each of which signs a real event and posts it at the real webhook, so the
 * path exercised is the path Stripe would exercise.
 *
 * Never registered when a key is configured, and never in production.
 */
export async function billingStubRoutes(app: FastifyInstance): Promise<void> {
  function stub(): StubProvider {
    const provider = billingProvider();
    // Belt and braces: registration is already conditional, and an endpoint
    // that can set a tenant's plan should refuse twice.
    if (!(provider instanceof StubProvider)) throw new NotFoundError();
    return provider;
  }

  app.get<{ Querystring: { customer?: string; price?: string; return_to?: string } }>(
    '/billing/stub/checkout',
    async (request, reply) => {
      const provider = stub();
      const { customer, price, return_to: returnTo } = request.query;
      if (!customer || !price || !returnTo) throw new NotFoundError();

      const subscription = provider.start(customer, price);
      await deliver(provider, 'customer.subscription.created', customer, subscription);

      return reply.redirect(returnTo, 303);
    },
  );

  app.get<{ Querystring: { customer?: string; return_to?: string; do?: string } }>(
    '/billing/stub/portal',
    async (request, reply) => {
      const provider = stub();
      const { customer, return_to: returnTo } = request.query;
      if (!customer || !returnTo) throw new NotFoundError();

      const action = request.query.do;
      if (action) {
        const applied = await act(provider, customer, action);
        if (applied) return reply.redirect(returnTo, 303);
      }

      const subscription = provider.subscriptionFor(customer);
      return reply
        .header('content-type', 'text/html; charset=utf-8')
        .send(portalPage(customer, returnTo, subscription));
    },
  );

  async function act(provider: StubProvider, customer: string, action: string): Promise<boolean> {
    const changes: Record<string, Parameters<StubProvider['update']>[1]> = {
      pro: { priceLookupKey: 'pro_monthly' },
      enterprise: { priceLookupKey: 'enterprise_monthly' },
      cancel: { cancelAtPeriodEnd: true },
      resume: { cancelAtPeriodEnd: false },
      fail: { status: 'past_due' },
      recover: { status: 'active' },
      // The period actually ending, which is what turns §5.1's "at the end
      // of the paid period" into a plan change.
      end: { status: 'canceled', cancelAtPeriodEnd: false },
    };

    const change = changes[action];
    if (!change) return false;

    const updated = provider.update(customer, change);
    if (!updated) return false;

    await deliver(
      provider,
      action === 'end' ? 'customer.subscription.deleted' : 'customer.subscription.updated',
      customer,
      updated,
    );
    return true;
  }
}

/**
 * Sign the event and post it at our own webhook, over HTTP.
 *
 * A direct function call would be simpler and would skip the two things most
 * likely to be wrong: the raw-body parser and the signature check. This is a
 * loopback request precisely so those are not skipped.
 */
async function deliver(
  provider: StubProvider,
  type: string,
  customer: string,
  subscription: Parameters<StubProvider['deliverable']>[2],
): Promise<void> {
  const { body, signature } = provider.deliverable(type, customer, subscription);

  await fetch(`${config.billing.apiBaseUrl}/webhooks/stripe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': signature },
    body,
  });
}

function portalPage(
  customer: string,
  returnTo: string,
  subscription: { status: string; priceLookupKey: string | null; cancelAtPeriodEnd: boolean } | undefined,
): string {
  const link = (action: string, label: string): string =>
    `<li><a href="/billing/stub/portal?customer=${encodeURIComponent(customer)}` +
    `&return_to=${encodeURIComponent(returnTo)}&do=${action}">${label}</a></li>`;

  const state = subscription
    ? `${subscription.status}, ${subscription.priceLookupKey ?? 'no price'}` +
      `${subscription.cancelAtPeriodEnd ? ', cancelling at period end' : ''}`
    : 'no subscription';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Billing portal (stub)</title></head>
<body style="font-family: ui-monospace, monospace; max-width: 40rem; margin: 3rem auto">
  <h1>Billing portal — stub</h1>
  <p>This stands in for the provider's hosted portal. It is not part of
     FlightSquare and is never deployed.</p>
  <p><strong>${state}</strong></p>
  <ul>
    ${link('pro', 'Switch to Pro')}
    ${link('enterprise', 'Switch to Enterprise')}
    ${link('cancel', 'Cancel at period end')}
    ${link('resume', 'Resume (undo cancellation)')}
    ${link('end', 'End the period now (becomes Free)')}
    ${link('fail', 'Fail the payment (past due)')}
    ${link('recover', 'Recover the payment (active)')}
  </ul>
  <p><a href="${returnTo}">Back to FlightSquare</a></p>
</body></html>`;
}
