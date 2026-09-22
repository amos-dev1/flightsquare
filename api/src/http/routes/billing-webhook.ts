import type { FastifyInstance } from 'fastify';

import { applyBillingEvent } from '../../billing/apply.js';
import { billingProvider, WebhookVerificationError } from '../../billing/index.js';
import { config } from '../../config.js';
import { InvalidRequestError } from '../errors.js';

/**
 * Where the billing provider tells us what happened.
 *
 * The only unauthenticated endpoint in the product that can change what a
 * tenant is entitled to, which makes the signature check the whole of its
 * security. Everything else follows from that:
 *
 * - **The raw body is required.** A signature is over the bytes that were
 *   sent, not over a re-serialisation of the parsed object — key order and
 *   whitespace both matter. The content-type parser below is registered
 *   inside this plugin's encapsulation, so every other route in the API
 *   keeps the parsed JSON it has always had.
 * - **A verification failure is a 400 and nothing else.** No tenant is
 *   resolved, no row is written, and the body is not parsed.
 * - **Success is always 200, even when we did nothing.** A provider retries
 *   anything else, and a retry loop over an event we will never own is worse
 *   than silence. The outcome goes in the log instead.
 *
 * Rate limited, because it is open to the internet. §1.6: 429 is requests
 * per unit time and is never a plan quota.
 */
export async function billingWebhookRoutes(app: FastifyInstance): Promise<void> {
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (_request, body, done) => {
      done(null, body);
    },
  );

  app.post(
    '/webhooks/stripe',
    { config: { rateLimit: config.rateLimits.webhook } },
    async (request, reply) => {
      const provider = billingProvider();
      const signature = request.headers['stripe-signature'];

      let event;
      try {
        event = provider.verifyWebhook(
          request.body as Buffer,
          typeof signature === 'string' ? signature : undefined,
        );
      } catch (error) {
        if (error instanceof WebhookVerificationError) {
          request.log.warn({ err: error }, 'rejected an unverifiable billing webhook');
          throw new InvalidRequestError('signature verification failed');
        }
        throw error;
      }

      const result = await applyBillingEvent(event, provider.name);

      request.log.info(
        {
          billing_event: event.id,
          type: event.type,
          outcome: result.outcome,
          tenant_id: result.tenantId,
          plan_code: result.planCode,
        },
        'billing webhook',
      );

      return reply.code(200).send({ status: result.outcome });
    },
  );
}
