import Stripe from 'stripe';

import type { SubscriptionStatus } from '@flightsquare/shared';

import {
  WebhookVerificationError,
  type BillingEvent,
  type BillingProvider,
  type CheckoutInput,
  type CustomerInput,
  type PortalInput,
  type ProviderPrice,
  type ProviderSubscription,
} from './provider.js';

/**
 * Stripe, which is the system of record for platform billing (§8.3).
 *
 * Constructed only when a secret key is configured. Everything Stripe-shaped
 * stops at this file: the routes see `BillingEvent`, not `Stripe.Event`.
 */
export class StripeProvider implements BillingProvider {
  readonly name = 'stripe';
  readonly configured = true;

  readonly #stripe: Stripe;
  readonly #webhookSecret: string;

  constructor(secretKey: string, webhookSecret: string) {
    this.#stripe = new Stripe(secretKey);
    this.#webhookSecret = webhookSecret;
  }

  async ensureCustomer(input: CustomerInput): Promise<string> {
    const customer = await this.#stripe.customers.create({
      name: input.tenantName,
      email: input.email,
      // Our id on their record, so a support conversation that starts in the
      // Stripe dashboard can find its way back here.
      metadata: { tenant_id: input.tenantId },
    });
    return customer.id;
  }

  async createCheckoutSession(input: CheckoutInput): Promise<{ url: string }> {
    const price = await this.#priceIdFor(input.priceLookupKey);

    const session = await this.#stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: input.customerId,
      line_items: [{ price, quantity: 1 }],
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      // Echoed on the completed event. Read only as a cross-check in the
      // log: the tenant a webhook acts on is resolved from the customer id
      // through §2.1's door, never from anything in a request body (§1.1).
      client_reference_id: input.tenantId,
    });

    if (!session.url) {
      throw new Error('stripe returned a checkout session with no url');
    }
    return { url: session.url };
  }

  async createPortalSession(input: PortalInput): Promise<{ url: string }> {
    const session = await this.#stripe.billingPortal.sessions.create({
      customer: input.customerId,
      return_url: input.returnUrl,
    });
    return { url: session.url };
  }

  async pricesFor(lookupKeys: string[]): Promise<Map<string, ProviderPrice>> {
    const found = new Map<string, ProviderPrice>();
    if (lookupKeys.length === 0) return found;

    const prices = await this.#stripe.prices.list({
      lookup_keys: lookupKeys,
      active: true,
      limit: 100,
    });

    for (const price of prices.data) {
      if (!price.lookup_key || price.unit_amount === null) continue;
      found.set(price.lookup_key, {
        amount_cents: price.unit_amount,
        currency: price.currency.toUpperCase(),
        interval: price.recurring?.interval ?? 'month',
      });
    }
    return found;
  }

  verifyWebhook(rawBody: Buffer, signature: string | undefined): BillingEvent {
    if (!signature) throw new WebhookVerificationError('no signature header');

    let event: Stripe.Event;
    try {
      // Handles the timestamp tolerance and the constant-time comparison.
      // This is the one place in the product where rolling our own would be
      // a genuinely bad idea, and the reason the SDK is a dependency at all.
      event = this.#stripe.webhooks.constructEvent(
        rawBody,
        signature,
        this.#webhookSecret,
      );
    } catch (error) {
      throw new WebhookVerificationError((error as Error).message);
    }

    return normalise(event);
  }

  async #priceIdFor(lookupKey: string): Promise<string> {
    const prices = await this.#stripe.prices.list({
      lookup_keys: [lookupKey],
      active: true,
      limit: 1,
    });
    const price = prices.data[0];
    if (!price) {
      throw new Error(`no active stripe price with lookup key ${lookupKey}`);
    }
    return price.id;
  }
}

function normalise(event: Stripe.Event): BillingEvent {
  const object = event.data.object as unknown as Record<string, unknown>;

  const customerId =
    typeof object.customer === 'string'
      ? object.customer
      : ((object.customer as { id?: string } | null)?.id ?? null);

  const base = { id: event.id, type: event.type, customerId };

  if (event.type.startsWith('customer.subscription.')) {
    return { ...base, subscription: normaliseSubscription(object as unknown as Stripe.Subscription) };
  }

  // checkout.session.completed and the invoice events carry no subscription
  // body worth trusting — Stripe sends the authoritative one immediately
  // afterwards as customer.subscription.*, so these are recorded and act on
  // nothing. That is deliberate: one shape of event changes a plan.
  return base;
}

function normaliseSubscription(subscription: Stripe.Subscription): ProviderSubscription {
  const item = subscription.items?.data?.[0];

  return {
    id: subscription.id,
    status: subscription.status as SubscriptionStatus,
    priceLookupKey: item?.price?.lookup_key ?? null,
    currentPeriodEnd: periodEnd(subscription, item),
    cancelAtPeriodEnd: subscription.cancel_at_period_end === true,
  };
}

/**
 * Where the period end lives depends on the API version.
 *
 * Stripe moved `current_period_end` off the subscription and onto each item
 * in 2025, because a subscription can hold items on different cycles. Older
 * API versions still send the top-level field. Read the item first and fall
 * back, so this keeps working whichever version the account is pinned to —
 * the alternative is a screen that says "then Free" with no date, which is
 * exactly the surprise §5.4 says never to spring on anybody.
 */
function periodEnd(
  subscription: Stripe.Subscription,
  item: Stripe.SubscriptionItem | undefined,
): Date | null {
  const seconds =
    (item as unknown as { current_period_end?: number } | undefined)?.current_period_end ??
    (subscription as unknown as { current_period_end?: number }).current_period_end;

  return typeof seconds === 'number' ? new Date(seconds * 1000) : null;
}
