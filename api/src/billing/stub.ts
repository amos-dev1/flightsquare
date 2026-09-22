import { createHmac, timingSafeEqual } from 'node:crypto';

import type { SubscriptionStatus } from '@flightsquare/shared';

import {
  WebhookVerificationError,
  type BillingEvent,
  type BillingProvider,
  type CheckoutInput,
  type CustomerInput,
  type PortalInput,
  type ProviderPrice,
} from './provider.js';

/**
 * The provider that runs when no key is configured.
 *
 * Not a mock. It signs its events the way Stripe does, delivers them to the
 * real webhook endpoint over HTTP, and the route that receives them cannot
 * tell the difference — so checkout, the plan change, the audit row, a
 * failed payment and a cancellation at period end are all exercisable in dev
 * and in the suite with no account, no network and no card.
 *
 * What it is not is a fixture. Its state lives in memory and dies with the
 * process; the database keeps everything that matters, and a restart leaves
 * a tenant on whatever plan the last delivered event gave them.
 */
export class StubProvider implements BillingProvider {
  readonly name = 'stub';
  /**
   * True: a stub that reported itself unconfigured would hide the very
   * screens it exists to let us build. What is false is that it can take
   * money, and nothing in the product asks it to.
   */
  readonly configured = true;

  readonly #webhookSecret: string;
  readonly #baseUrl: string;
  /** customerId -> its current subscription, so the portal has something to act on. */
  readonly #subscriptions = new Map<string, StubSubscription>();

  constructor(webhookSecret: string, baseUrl: string) {
    this.#webhookSecret = webhookSecret;
    this.#baseUrl = baseUrl.replace(/\/$/, '');
  }

  /**
   * Deterministic, so re-running checkout for a tenant produces the same
   * customer and `set_billing_customer` stays idempotent — which is the
   * behaviour Stripe gives us via the stored id, reproduced here.
   */
  async ensureCustomer(input: CustomerInput): Promise<string> {
    return `cus_stub_${input.tenantId.replaceAll('-', '').slice(0, 16)}`;
  }

  async createCheckoutSession(input: CheckoutInput): Promise<{ url: string }> {
    const url = new URL(`${this.#baseUrl}/billing/stub/checkout`);
    url.searchParams.set('customer', input.customerId);
    url.searchParams.set('price', input.priceLookupKey);
    url.searchParams.set('return_to', input.successUrl);
    return { url: url.toString() };
  }

  async createPortalSession(input: PortalInput): Promise<{ url: string }> {
    const url = new URL(`${this.#baseUrl}/billing/stub/portal`);
    url.searchParams.set('customer', input.customerId);
    url.searchParams.set('return_to', input.returnUrl);
    return { url: url.toString() };
  }

  /**
   * Stand-in amounts. They are not a pricing decision — the real numbers
   * live on the provider, which is the whole point of storing a lookup key
   * and no amount (§3.7 rule 1's reasoning, applied to our own price list).
   */
  async pricesFor(lookupKeys: string[]): Promise<Map<string, ProviderPrice>> {
    const catalogue: Record<string, ProviderPrice> = {
      pro_monthly: { amount_cents: 3900, currency: 'USD', interval: 'month' },
      enterprise_monthly: { amount_cents: 9900, currency: 'USD', interval: 'month' },
    };

    const found = new Map<string, ProviderPrice>();
    for (const key of lookupKeys) {
      const price = catalogue[key];
      if (price) found.set(key, price);
    }
    return found;
  }

  verifyWebhook(rawBody: Buffer, signature: string | undefined): BillingEvent {
    if (!signature) throw new WebhookVerificationError('no signature header');

    const parts = new Map(
      signature.split(',').map((part) => {
        const [key, value] = part.split('=', 2);
        return [key?.trim() ?? '', value?.trim() ?? ''] as const;
      }),
    );

    const timestamp = parts.get('t');
    const provided = parts.get('v1');
    if (!timestamp || !provided) {
      throw new WebhookVerificationError('malformed signature header');
    }

    const expected = sign(this.#webhookSecret, timestamp, rawBody);
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(provided, 'utf8');
    // Length first: timingSafeEqual throws on a mismatch rather than
    // returning false, and a thrown comparison is still a rejection here.
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new WebhookVerificationError('signature does not match');
    }

    const event = JSON.parse(rawBody.toString('utf8')) as BillingEvent;

    // JSON has no date. The real provider sends epoch seconds and the Stripe
    // adapter converts them; this one has to revive its own ISO string, or
    // the route would hand a string to a timestamptz parameter and the
    // period end would arrive as nonsense on the one screen that promises a
    // date (§5.4: the outcome is never a surprise).
    if (event.subscription) {
      const raw = event.subscription.currentPeriodEnd as unknown;
      event.subscription.currentPeriodEnd =
        typeof raw === 'string' ? new Date(raw) : null;
    }
    return event;
  }

  // -------------------------------------------------------------------------
  // The parts of a payment provider that a stub has to invent
  // -------------------------------------------------------------------------

  subscriptionFor(customerId: string): StubSubscription | undefined {
    return this.#subscriptions.get(customerId);
  }

  /** Starting a subscription, as checkout would. */
  start(customerId: string, priceLookupKey: string): StubSubscription {
    const existing = this.#subscriptions.get(customerId);
    const subscription: StubSubscription = {
      id: existing?.id ?? `sub_stub_${customerId.slice(-10)}`,
      status: 'active',
      priceLookupKey,
      currentPeriodEnd: thirtyDaysOut(),
      cancelAtPeriodEnd: false,
    };
    this.#subscriptions.set(customerId, subscription);
    return subscription;
  }

  /** Any later change, as the portal would. */
  update(customerId: string, change: Partial<StubSubscription>): StubSubscription | undefined {
    const existing = this.#subscriptions.get(customerId);
    if (!existing) return undefined;
    const updated = { ...existing, ...change };
    this.#subscriptions.set(customerId, updated);
    return updated;
  }

  /**
   * Build and sign an event exactly as the provider would, so the caller can
   * deliver it to the real endpoint over real HTTP.
   */
  deliverable(
    type: string,
    customerId: string,
    subscription?: StubSubscription,
  ): { body: string; signature: string } {
    const event: BillingEvent = {
      id: `evt_stub_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      type,
      customerId,
      ...(subscription
        ? {
            subscription: {
              id: subscription.id,
              status: subscription.status,
              priceLookupKey: subscription.priceLookupKey,
              currentPeriodEnd: subscription.currentPeriodEnd,
              cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
            },
          }
        : {}),
    };

    const body = JSON.stringify(event);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = `t=${timestamp},v1=${sign(this.#webhookSecret, timestamp, Buffer.from(body, 'utf8'))}`;
    return { body, signature };
  }
}

export interface StubSubscription {
  id: string;
  status: SubscriptionStatus;
  priceLookupKey: string | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
}

/** Stripe's scheme: HMAC-SHA256 over "<timestamp>.<raw body>". */
function sign(secret: string, timestamp: string, body: Buffer): string {
  return createHmac('sha256', secret)
    .update(`${timestamp}.${body.toString('utf8')}`)
    .digest('hex');
}

function thirtyDaysOut(): Date {
  return new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
}
