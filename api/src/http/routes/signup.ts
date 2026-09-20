import type { FastifyInstance } from 'fastify';

import { provisionTenantForNewUser } from '../../db/auth.js';
import { hashPassword } from '../../password.js';
import { ConflictError, isUniqueViolation } from '../errors.js';
import type { TenantArchetype } from '../../db/schema.js';

interface SignupBody {
  slug: string;
  name: string;
  email: string;
  password: string;
  archetype?: TenantArchetype;
}

const signupSchema = {
  body: {
    type: 'object',
    required: ['slug', 'name', 'email', 'password'],
    additionalProperties: false,
    properties: {
      slug: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{1,62}$' },
      name: { type: 'string', minLength: 1, maxLength: 200 },
      email: { type: 'string', minLength: 3, maxLength: 320, pattern: '^[^@\\s]+@[^@\\s]+$' },
      password: { type: 'string', minLength: 12, maxLength: 1024 },
      archetype: { type: 'string', enum: ['solo', 'partnership', 'club'] },
    },
  },
} as const;

export interface SignupRouteOptions {
  limit?: { max: number; timeWindow: string } | undefined;
}

export async function signupRoutes(
  app: FastifyInstance,
  options: SignupRouteOptions = {},
): Promise<void> {
  /**
   * Creating a tenant and its first user. Runs with no tenant context — the
   * tenant does not exist yet — through the one write on the §2.1 list.
   *
   * Rate limited: it creates a tenant and a user without any credential,
   * which makes it the most abusable endpoint in the API.
   */
  app.post<{ Body: SignupBody }>(
    '/signup',
    {
      schema: signupSchema,
      config: { rateLimit: options.limit ?? { max: 5, timeWindow: '1 hour' } },
    },
    async (request, reply) => {
    const { slug, name, email, password, archetype } = request.body;

    const passwordHash = await hashPassword(password);

    try {
      const provisioned = await provisionTenantForNewUser({
        slug,
        name,
        email,
        passwordHash,
        archetype: archetype ?? 'solo',
      });

      return await reply.status(201).send({
        tenant_id: provisioned.tenant_id,
        user_id: provisioned.user_id,
        membership_id: provisioned.membership_id,
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        // Deliberately identical for a taken slug and a registered email.
        // Distinguishing them would make this an account-existence oracle.
        throw new ConflictError('that workspace could not be created');
      }
      throw error;
    }
    },
  );
}
