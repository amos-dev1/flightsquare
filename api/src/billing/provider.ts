import type { SubscriptionStatus } from '@flightsquare/shared';

/**
 * The billing provider, behind one interface.
 *
 * Two implementations: Stripe, and a stub that runs when no key is
 * configured. The stub is not a mock in the testing sense — it drives the
 * same webhook path with the same signature scheme, so checkout, the plan
 * change, the audit row and the cancellation are all exercised in dev and in
 * the suite with no account and no network. Real keys are configuration, not
 * code.
 *
 * Everything here is normalised into our own vocabulary at the edge. Nothing
 * outside this directory imports Stripe or knows what an "invoice.paid"
 * looks like, which is what keeps the two implementations interchangeable —
 * and what would make a third one (a different processor, a different
 * country) a file rather than a rewrite.
 */
export interface BillingProvider {
  readonly name: string;
  /** False when no key is set: the UI offers no checkout it cannot honour. */
  readonly configured: boolean;

  /** Idempotent: called on every checkout, creates at most one customer. */
  ensureCustomer(input: CustomerInput): Promise<string>;

  createCheckoutSession(input: CheckoutInput): Promise<{ url: string }>;

  /**
   * Card, invoices, plan switches and cancellation, all at the provider.
   *
   * §5.1 wants a downgrade to take effect at the end of the paid period, and
   * for paid → free that is exactly the provider's own "cancel at period
   * end". Sending people here rather than building a second plan-change UI
   * keeps one system of record and avoids subscription schedules entirely.
   */
  createPortalSession(input: PortalInput): Promise<{ url: string }>;

  /** What the provider will actually charge, by lookup key. */
  pricesFor(lookupKeys: string[]): Promise<Map<string, ProviderPrice>>;

  /**
   * Verify and normalise. Throws on a bad signature — never returns a
   * partially trusted event, because the signature is the only thing
   * standing between this endpoint and anyone on the internet setting a
   * tenant to Enterprise.
   */
  verifyWebhook(rawBody: Buffer, signature: string | undefined): BillingEvent;
}

export interface CustomerInput {
  tenantId: string;
  tenantName: string;
  email: string;
}

export interface CheckoutInput {
  customerId: string;
  priceLookupKey: string;
  /** Echoed back by the provider. Used as a cross-check in the log, never
   *  as the source of a tenant id — see the webhook route. */
  tenantId: string;
  successUrl: string;
  cancelUrl: string;
}

export interface PortalInput {
  customerId: string;
  returnUrl: string;
}

export interface ProviderPrice {
  amount_cents: number;
  currency: string;
  /** 'month' or 'year'. */
  interval: string;
}

/**
 * A provider event, in our words.
 *
 * `customerId` is what a tenant is resolved from, through §2.1's
 * `auth.tenant_for_billing_customer`. The subscription block is absent for
 * events that carry no subscription state (a bare invoice notice), in which
 * case the route records the event and changes nothing.
 */
export interface BillingEvent {
  id: string;
  type: string;
  customerId: string | null;
  subscription?: ProviderSubscription;
}

export interface ProviderSubscription {
  id: string;
  status: SubscriptionStatus;
  priceLookupKey: string | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
}

/** Thrown when a webhook cannot be trusted. The route answers 400. */
export class WebhookVerificationError extends Error {}

/**
 * The provider's status, mapped onto ours (§7.3).
 *
 * This is a decision rather than a translation, which is why it lives here
 * in readable code and not inside the SQL helper that holds the privilege.
 *
 * `past_due` is a real state in `tenants`, and `api/src/http/session.ts`
 * already treats it as usable: a failed card is a conversation, not a
 * lockout, and locking a club out of its maintenance records over a expired
 * Visa would be both hostile and dangerous. Everything else maps to
 * `active` — including a cancellation, because a tenant that has stopped
 * paying is a Free tenant, and Free is a product (§8.3).
 *
 * `suspended` and `closed` are never produced here. §7.3 makes them admin
 * acts, and the SQL helper refuses them independently.
 */
export function tenantStatusFor(status: SubscriptionStatus): 'active' | 'past_due' {
  return status === 'past_due' || status === 'unpaid' ? 'past_due' : 'active';
}

/**
 * Whether a subscription in this state entitles the tenant to its plan.
 *
 * `past_due` says yes on purpose — that is what a grace period is. The
 * provider will cancel it if nobody pays, and that event is what drops them
 * to Free.
 */
export function entitlesToPlan(status: SubscriptionStatus): boolean {
  return status === 'active' || status === 'trialing' || status === 'past_due';
}
