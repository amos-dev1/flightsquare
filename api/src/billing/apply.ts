import { sql } from 'kysely';

import { tenantForBillingCustomer } from '../db/auth.js';
import { withSession, type Tx } from '../db/context.js';
import { loadEntitlements } from '../db/entitlements.js';
import { overQuotaEmail } from '../email.js';
import { queueAll, recipientsWith } from '../mail/notify.js';
import type { QuotaKey } from '../entitlements/registry.js';
import { isUnlimited, limitForDatabase, type QuotaValue } from '../entitlements/values.js';
import type { Entitlements } from '../entitlements/resolver.js';
import { isUniqueViolation } from '../http/errors.js';
import { entitlesToPlan, tenantStatusFor, type BillingEvent } from './provider.js';

export type ApplyOutcome =
  | 'applied'
  | 'replayed'
  | 'unchanged'
  | 'unknown_customer'
  | 'unknown_price';

/**
 * Act on a verified provider event.
 *
 * Three things have to be true here and none of them are obvious:
 *
 * **The tenant never comes off the wire.** §1.1 is absolute about that, and a
 * webhook has no session to inherit from — so the tenant is resolved from the
 * customer id through §2.1's `auth.tenant_for_billing_customer`, a lookup
 * against our own column. The mapping into that column was written earlier,
 * by an authenticated admin pressing Upgrade, which is why the checkout route
 * creates the customer rather than letting the webhook discover one. The
 * event's `client_reference_id` is logged and never trusted.
 *
 * **A replay must change nothing.** A provider retries anything it did not
 * hear a 200 for, and it is right to. The unique key on `billing_events` is
 * what makes the second delivery a no-op, and it is inside the same
 * transaction as the plan change, so there is no window where one happened
 * and the other did not.
 *
 * **§5.9 wants the resolved entitlements, not the plan code.** "Why did they
 * lose maintenance in March?" is not answerable from `pro → free`; it is
 * answerable from the flags and quotas either side of the change. So the
 * audit row carries both snapshots, taken before and after, in the
 * transaction that made the change.
 */
export async function applyBillingEvent(
  event: BillingEvent,
  provider: string,
): Promise<{ outcome: ApplyOutcome; tenantId?: string; planCode?: string }> {
  if (!event.customerId) return { outcome: 'unknown_customer' };

  const tenantId = await tenantForBillingCustomer(event.customerId);
  // Not ours: a customer created in the provider's dashboard, a test event, a
  // tenant that was purged. Answer 200 and stop being retried for something
  // we will never own.
  if (!tenantId) return { outcome: 'unknown_customer' };

  return withSession({ tenantId }, async (trx) => {
    const fresh = await recordEvent(trx, tenantId, provider, event);
    if (!fresh) return { outcome: 'replayed' as const, tenantId };

    // Events that carry no subscription state — an invoice notice, a
    // completed checkout — are recorded and act on nothing. The provider
    // sends the authoritative `customer.subscription.*` immediately after,
    // and one shape of event changing a plan is easier to reason about than
    // four that mostly agree.
    if (!event.subscription) return { outcome: 'unchanged' as const, tenantId };

    const subscription = event.subscription;

    const subscribedPlan = subscription.priceLookupKey
      ? await planForLookupKey(trx, subscription.priceLookupKey)
      : null;

    // A price we have never heard of. Recording the event and refusing to
    // guess is the only safe move: guessing 'free' would downgrade a paying
    // club, and guessing the highest plan would give one away.
    if (subscription.priceLookupKey && !subscribedPlan) {
      return { outcome: 'unknown_price' as const, tenantId };
    }

    const existing = await trx
      .selectFrom('subscriptions')
      .select(['plan_code'])
      .executeTakeFirst();

    // What the subscription is for, which survives its cancellation.
    const subscriptionPlan = subscribedPlan ?? existing?.plan_code ?? 'free';
    // What the tenant is entitled to now. `past_due` still says yes — that is
    // what a grace period is, and the provider will cancel it if nobody pays.
    const effectivePlan = entitlesToPlan(subscription.status) ? subscriptionPlan : 'free';

    const before = snapshot(await loadEntitlements(trx));

    await sql`
      SELECT public.apply_subscription(
        ${provider},
        ${subscription.id},
        ${subscriptionPlan},
        ${effectivePlan},
        ${subscription.status},
        ${tenantStatusFor(subscription.status)},
        ${subscription.currentPeriodEnd},
        ${subscription.cancelAtPeriodEnd}
      )
    `.execute(trx);

    const after = snapshot(await loadEntitlements(trx));

    // §5.9: every plan change writes an audit record. Only when something
    // actually resolved differently — a renewal that changes nothing is not
    // a plan change, and a log full of them is a log nobody reads.
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      await trx
        .insertInto('audit_log')
        .values({
          tenant_id: tenantId,
          // Nobody in this tenant did this. The provider did, on the strength
          // of a card, and there is no user to name.
          actor_user_id: null,
          acting_admin_user_id: null,
          resource: 'subscription',
          resource_id: null,
          action: 'plan_changed',
          before,
          after,
        })
        .execute();

      // §5.3: the club is told what is over and offered a way out, rather
      // than finding out the next time somebody tries to add an aeroplane.
      // Inside the changed branch on purpose — a renewal that resolves to
      // the same thing is not news, and this is the one moment a tenant can
      // newly become over-quota without anybody in it doing anything.
      await notifyIfOverQuota(trx, effectivePlan);
    }

    return { outcome: 'applied' as const, tenantId, planCode: effectivePlan };
  });
}

/**
 * Insert the event, or discover it has already been handled.
 *
 * Returns false on a replay. The unique violation is caught rather than
 * pre-checked, because a pre-check is a race: two deliveries of the same
 * event can both find nothing and both proceed.
 */
async function recordEvent(
  trx: Tx,
  tenantId: string,
  provider: string,
  event: BillingEvent,
): Promise<boolean> {
  try {
    await trx
      .insertInto('billing_events')
      .values({
        tenant_id: tenantId,
        provider,
        provider_event_id: event.id,
        type: event.type,
      })
      .execute();
    return true;
  } catch (error) {
    if (isUniqueViolation(error)) return false;
    throw error;
  }
}

async function planForLookupKey(trx: Tx, lookupKey: string): Promise<string | null> {
  const plan = await trx
    .selectFrom('plans')
    .select('code')
    .where('price_lookup_key', '=', lookupKey)
    .executeTakeFirst();
  return plan?.code ?? null;
}

/** Labels for the two quotas anything counts today (§4.5). */
const COUNTED: Record<string, string> = {
  'aircraft.active': 'Aircraft',
  'members.active': 'Members',
};

/**
 * Tell the people who can do something about it.
 *
 * `subscription: write`, not "the admins" — §1.5 makes a role a bundle of
 * pairs and nothing branches on its name, so whoever a club has given the
 * subscription to is who hears about it.
 *
 * Nothing is enforced here. `assert_quota` already refuses the next create,
 * and §5.2 is explicit that everything else keeps working; this is only the
 * telling.
 */
async function notifyIfOverQuota(trx: Tx, planCode: string): Promise<void> {
  const entitlements = await loadEntitlements(trx);

  const usage = await trx
    .selectFrom('tenant_usage')
    .select(['quota_key', 'current_value'])
    .execute();

  const over: { noun: string; used: number; limit: number }[] = [];
  for (const row of usage) {
    const noun = COUNTED[row.quota_key];
    if (!noun) continue;
    const quota = entitlements.quota(row.quota_key as QuotaKey);
    const limit = limitForDatabase(quota);
    const used = Number(row.current_value);
    if (limit !== null && used > limit) over.push({ noun, used, limit });
  }

  if (over.length === 0) return;

  const tenant = await trx.selectFrom('tenants').select(['name']).executeTakeFirst();
  const recipients = await recipientsWith(trx, 'subscription', 'write');

  await queueAll(trx, 'over_quota', recipients, () =>
    overQuotaEmail({
      tenantName: tenant?.name ?? 'Your club',
      planCode,
      over,
    }),
  );
}

/** What §5.9 asks to be reconstructable: the resolved values, not the label. */
function snapshot(entitlements: Entitlements): Record<string, unknown> {
  const flags: Record<string, boolean> = {};
  const quotas: Record<string, number | 'unlimited'> = {};
  const config: Record<string, string> = {};

  for (const resolved of entitlements.all()) {
    const kind = entitlements.kindOf(resolved.key);
    if (kind === 'flag') {
      flags[resolved.key] = resolved.value as boolean;
    } else if (kind === 'quota') {
      const quota = resolved.value as QuotaValue;
      quotas[resolved.key] = isUnlimited(quota)
        ? 'unlimited'
        : (quota as { value: number }).value;
    } else {
      config[resolved.key] = resolved.value as string;
    }
  }

  return { plan_code: entitlements.planCode, flags, quotas, config };
}
