import { config } from '../config.js';
import type { BillingProvider } from './provider.js';
import { StripeProvider } from './stripe.js';
import { StubProvider } from './stub.js';

let provider: BillingProvider | null = null;

/**
 * The one provider this process uses, chosen once.
 *
 * A key means Stripe; no key means the stub. There is no third state and no
 * flag — "is billing configured" is one question with one answer, and a
 * deployment that half-configures it would otherwise discover which half at
 * the moment somebody tried to pay.
 */
export function billingProvider(): BillingProvider {
  if (provider) return provider;

  provider = config.billing.secretKey
    ? new StripeProvider(config.billing.secretKey, config.billing.webhookSecret)
    : new StubProvider(config.billing.webhookSecret, config.billing.apiBaseUrl);

  return provider;
}

/** Test seam. Nothing in the running application calls this. */
export function setBillingProvider(replacement: BillingProvider | null): void {
  provider = replacement;
}

export * from './provider.js';
export { StubProvider } from './stub.js';
