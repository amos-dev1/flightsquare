import { PermissionError } from './http/errors.js';

/**
 * §1.5: a permission is a pair — a resource and a level — and levels are
 * ordered, so `write` implies `read` and `read` implies `none`.
 *
 * Two distinctions that §1.5 says are easy to lose and expensive to recover,
 * kept here and in the seeded bundles:
 *
 *   squawks is separate from maintenance. A pilot reports a defect but does
 *   not sign off work, close an item, or record compliance — squawks: write
 *   with maintenance: read. Collapsing them makes the central permission line
 *   in the product inexpressible.
 *
 *   subscription (what the tenant pays FlightSquare) is separate from rates
 *   and charges (what pilots pay their club). Confusing the two is how a
 *   member ends up able to change the company's billing.
 */
export const RESOURCES = [
  'aircraft',
  'reservations',
  'flights',
  'squawks',
  'maintenance',
  'rates',
  'charges',
  'qualifications',
  'documents',
  'members',
  'subscription',
  'settings',
] as const;

export type Resource = (typeof RESOURCES)[number];
export type Level = 'none' | 'read' | 'write';
/** What an endpoint can require; requiring `none` is meaningless. */
export type RequiredLevel = Exclude<Level, 'none'>;

const RANK: Record<Level, number> = { none: 0, read: 1, write: 2 };

export function satisfies(held: Level, required: RequiredLevel): boolean {
  return RANK[held] >= RANK[required];
}

export function isResource(value: string): value is Resource {
  return (RESOURCES as readonly string[]).includes(value);
}

/**
 * What one membership holds. Absent means `none`: a bundle that does not
 * mention a resource grants nothing on it, which is the fail-closed reading.
 */
export class Permissions {
  readonly #held: ReadonlyMap<string, Level>;

  /**
   * Whether this user is a member of this tenant at all.
   *
   * Separate from holding any particular level, because it answers a
   * different question: a bundle granting nothing but `none` is still a
   * membership, and a session naming a tenant its user never joined is not.
   * Routes that require no specific level still require this — "any member"
   * has to mean a member, or it means nobody is checked.
   */
  readonly isMember: boolean;

  constructor(held: ReadonlyMap<string, Level>, isMember: boolean) {
    this.#held = held;
    this.isMember = isMember;
  }

  levelFor(resource: Resource): Level {
    return this.#held.get(resource) ?? 'none';
  }

  has(resource: Resource, required: RequiredLevel): boolean {
    return satisfies(this.levelFor(resource), required);
  }

  require(resource: Resource, required: RequiredLevel): void {
    if (!this.has(resource, required)) {
      throw new PermissionError(resource, required);
    }
  }

  toJSON(): Record<string, Level> {
    return Object.fromEntries(this.#held);
  }
}
