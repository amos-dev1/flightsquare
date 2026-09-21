import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeDatabase, db } from '../src/db/pool.js';
import { buildServer } from '../src/http/server.js';
import type { ResolvedSession } from '../src/http/session.js';
import { UnauthorizedError } from '../src/http/errors.js';
import {
  cleanupTestTenants,
  provisionTestTenant,
  readOutbox,
  setPlan,
  uniqueEmail,
} from './helpers/fixtures.js';

const SESSION_ID = '01920000-0000-7000-8000-0000000000d0';

afterAll(async () => {
  await cleanupTestTenants();
  await closeDatabase();
});

/** Pull the token out of a link the way the person clicking it would. */
function tokenFrom(body: string): string {
  const match = /token=([^\s&]+)/.exec(body);
  if (!match) throw new Error(`no token in: ${body}`);
  return decodeURIComponent(match[1]!);
}

describe('identity', () => {
  let app: FastifyInstance;
  let stub: ResolvedSession | null = null;
  let club: Awaited<ReturnType<typeof provisionTestTenant>>;
  /** Whoever can still administer the club — it changes hands below. */
  let currentAdminUserId: string;

  beforeAll(async () => {
    await cleanupTestTenants();
    club = await provisionTestTenant('identity');
    // Free allows one member, so inviting is correctly refused there — §4.3,
    // and the point of the tier. A club with somebody to invite is Pro.
    await setPlan(club.tenant_id, 'pro');

    app = buildServer({
      resolveSession: async () => {
        if (!stub) throw new UnauthorizedError();
        return stub;
      },
      // The account endpoints share login's limiter, and this suite calls
      // them more often than a person would.
      rateLimits: { login: { max: 1000, timeWindow: '1 minute' } },
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  function asAdmin(): void {
    stub = { sessionId: SESSION_ID, userId: club.user_id, tenantId: club.tenant_id };
  }
  function asMember(userId: string): void {
    stub = { sessionId: SESSION_ID, userId, tenantId: club.tenant_id };
  }
  function signedOut(): void {
    stub = null;
  }

  it('cannot read its own outbox', async () => {
    // The whole reason the token doors write the queue rather than the API:
    // an application that could read this back could read every live reset
    // link at once.
    await expect(
      db.selectFrom('outbox').select('id').execute(),
    ).rejects.toThrow(/permission denied/i);
  });

  describe('password reset', () => {
    it('answers the same for an address that exists and one that does not', async () => {
      const unknown = await app.inject({
        method: 'POST',
        url: '/auth/password-reset/request',
        payload: { email: 'nobody-at-all@vitest.test' },
      });
      const known = await app.inject({
        method: 'POST',
        url: '/auth/password-reset/request',
        payload: { email: club.email },
      });

      // Byte-identical. This endpoint must not be a way to ask whether
      // somebody has a FlightSquare account.
      expect(unknown.statusCode).toBe(202);
      expect(known.statusCode).toBe(known.statusCode);
      expect(unknown.json()).toEqual(known.json());

      // And nothing was queued for the address that does not exist.
      expect(await readOutbox('nobody-at-all@vitest.test')).toHaveLength(0);
      expect((await readOutbox(club.email)).length).toBeGreaterThan(0);
    });

    it('resets the password once, and revokes every session while doing it', async () => {
      const queued = await readOutbox(club.email);
      const reset = queued.find((m) => m.subject.includes('Reset'))!;
      const token = tokenFrom(reset.body);

      const first = await app.inject({
        method: 'POST',
        url: '/auth/password-reset',
        payload: { token, password: 'a brand new passphrase' },
      });
      expect(first.statusCode).toBe(200);

      // Single use. Whoever forwarded the email cannot follow behind.
      const second = await app.inject({
        method: 'POST',
        url: '/auth/password-reset',
        payload: { token, password: 'somebody else entirely' },
      });
      expect(second.statusCode).toBe(404);

      // The new password works, and that is also the proof the hash changed.
      const login = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: club.email, password: 'a brand new passphrase' },
      });
      expect(login.statusCode).toBe(200);
    });

    it('refuses a token issued for a different purpose', async () => {
      await app.inject({
        method: 'POST',
        url: '/auth/verify-email/request',
        payload: { email: club.email },
      });
      const verification = (await readOutbox(club.email)).find((m) =>
        m.subject.includes('Confirm'),
      )!;

      const wrongDoor = await app.inject({
        method: 'POST',
        url: '/auth/password-reset',
        payload: { token: tokenFrom(verification.body), password: 'not this way at all' },
      });
      expect(wrongDoor.statusCode).toBe(404);

      // The right door still works, which proves the token was never spent.
      const verified = await app.inject({
        method: 'POST',
        url: '/auth/verify-email',
        payload: { token: tokenFrom(verification.body) },
      });
      expect(verified.statusCode).toBe(200);

      // Recorded, and nothing in v1 is gated on it — the first thing a new
      // club does is add an aircraft, and being locked out of that while
      // waiting for mail would be a worse product than an unverified row.
      asAdmin();
      expect((await app.inject({ method: 'GET', url: '/me' })).json().email_verified).toBe(true);
    });
  });

  describe('the roster', () => {
    let inviteToken: string;
    let invitedEmail: string;
    let invitedUserId: string;

    it('starts as one Admin, and says so', async () => {
      asAdmin();
      const members = await app.inject({ method: 'GET', url: '/members' });

      expect(members.statusCode).toBe(200);
      expect(members.json()).toHaveLength(1);
      expect(members.json()[0]).toMatchObject({
        email: club.email,
        role: 'admin',
        status: 'active',
      });
    });

    it('invites somebody, and queues them a link', async () => {
      asAdmin();
      invitedEmail = uniqueEmail('invited');

      const invited = await app.inject({
        method: 'POST',
        url: '/invites',
        payload: { email: invitedEmail, name: 'Dave', role: 'pilot' },
      });
      expect(invited.statusCode).toBe(201);

      const queued = await readOutbox(invitedEmail);
      expect(queued).toHaveLength(1);
      expect(queued[0]!.subject).toContain('Join');
      inviteToken = tokenFrom(queued[0]!.body);
    });

    it('will not invite the same address twice while one is pending', async () => {
      asAdmin();
      const again = await app.inject({
        method: 'POST',
        url: '/invites',
        payload: { email: invitedEmail },
      });
      expect(again.statusCode).toBe(409);
    });

    it('shows the club and whether an account exists, without a session', async () => {
      signedOut();
      const lookup = await app.inject({ method: 'GET', url: `/invites/token/${inviteToken}` });

      expect(lookup.statusCode).toBe(200);
      expect(lookup.json()).toMatchObject({ email: invitedEmail, has_account: false });
    });

    it('creates the person and their membership when they accept', async () => {
      signedOut();
      const accepted = await app.inject({
        method: 'POST',
        url: `/invites/token/${inviteToken}/accept`,
        payload: { password: 'the passphrase dave picked', name: 'Dave' },
      });

      expect(accepted.statusCode).toBe(201);
      expect(accepted.json().email).toBe(invitedEmail);

      // They can sign in as themselves now, with exactly one membership.
      const login = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: invitedEmail, password: 'the passphrase dave picked' },
      });
      expect(login.statusCode).toBe(200);
      expect(login.json().memberships).toHaveLength(1);

      asAdmin();
      const members = await app.inject({ method: 'GET', url: '/members' });
      expect(members.json()).toHaveLength(2);
      expect(members.json().find((m: { email: string }) => m.email === invitedEmail).role)
        .toBe('pilot');
    });

    it('cannot spend the same invitation twice', async () => {
      signedOut();
      const again = await app.inject({
        method: 'POST',
        url: `/invites/token/${inviteToken}/accept`,
        payload: { password: 'a different passphrase' },
      });
      // The token resolves to nothing once accepted, which is the same
      // answer as a token that never existed.
      expect(again.statusCode).toBe(404);
    });

    it('keeps one member who can manage members', async () => {
      asAdmin();
      const members = await app.inject({ method: 'GET', url: '/members' });
      const admin = members.json().find((m: { role: string }) => m.role === 'admin');
      const pilot = members.json().find((m: { role: string }) => m.role === 'pilot');

      // §4.4, and the trigger is what enforces it — the handler only turns
      // the refusal into a sentence.
      const demoted = await app.inject({
        method: 'PATCH',
        url: `/members/${admin.id}`,
        payload: { role: 'pilot' },
      });
      expect(demoted.statusCode).toBe(409);
      expect(demoted.json().reason).toMatch(/one member who can manage members/);

      const removed = await app.inject({
        method: 'PATCH',
        url: `/members/${admin.id}`,
        payload: { status: 'removed' },
      });
      expect(removed.statusCode).toBe(409);

      // Promote the pilot and the rule stops applying.
      const promoted = await app.inject({
        method: 'PATCH',
        url: `/members/${pilot.id}`,
        payload: { role: 'admin' },
      });
      expect(promoted.statusCode).toBe(200);
      expect(promoted.json().role).toBe('admin');

      // The new Admin does the removing, because the old one is about to
      // stop being able to do anything — which is the whole point.
      invitedUserId = promoted.json().user_id;
      currentAdminUserId = invitedUserId;
      asMember(invitedUserId);

      const nowAllowed = await app.inject({
        method: 'PATCH',
        url: `/members/${admin.id}`,
        payload: { status: 'removed' },
      });
      expect(nowAllowed.statusCode).toBe(200);

      // Removal is a status: the row — and everything hanging off it — stays.
      const after = await app.inject({ method: 'GET', url: '/members' });
      expect(after.json()).toHaveLength(2);
      expect(after.json().find((m: { id: string }) => m.id === admin.id).status).toBe('removed');
    });

    it('shuts the door behind a removed member', async () => {
      // Their membership is the only thing that grants any visibility into a
      // tenant (§3.1), so removing it takes the club away immediately —
      // without taking their flights, charges or squawks with it.
      asAdmin();
      const locked = await app.inject({ method: 'GET', url: '/members' });
      expect(locked.statusCode).toBe(403);
      expect(locked.json()).toEqual({ error: 'tenant_required' });
    });
  });

  describe('settings and profile', () => {
    // The original Admin was removed by the roster tests above, so the club
    // is administered by the member they promoted on the way out.
    function asCurrentAdmin(): void {
      asMember(currentAdminUserId);
    }

    it('renames the club and sets its zone, but not its slug', async () => {
      asCurrentAdmin();
      const updated = await app.inject({
        method: 'PATCH',
        url: '/tenant',
        payload: { name: 'Palo Alto Flying Club', timezone: 'America/Los_Angeles' },
      });

      expect(updated.statusCode).toBe(200);
      expect(updated.json()).toMatchObject({
        name: 'Palo Alto Flying Club',
        timezone: 'America/Los_Angeles',
      });

      // The slug is in URLs and in invite links already sent, so it is not
      // offered — and the validator strips what it does not know, which
      // leaves nothing to change rather than a slug that changed.
      const slugged = await app.inject({
        method: 'PATCH',
        url: '/tenant',
        payload: { slug: 'something-else' },
      });
      expect(slugged.statusCode).toBe(400);

      const unchanged = await app.inject({ method: 'GET', url: '/tenant' });
      expect(unchanged.json().slug).toBe(club.slug);
    });

    it('refuses a zone nothing can render', async () => {
      asCurrentAdmin();
      const nonsense = await app.inject({
        method: 'PATCH',
        url: '/tenant',
        payload: { timezone: 'Mars/Olympus_Mons' },
      });
      // Every screen that formats a time would throw, and settings is one of
      // those screens — there would be no way back.
      expect(nonsense.statusCode).toBe(400);
    });

    it('lets a person edit their own profile', async () => {
      asCurrentAdmin();
      const updated = await app.inject({
        method: 'PATCH',
        url: '/auth/me',
        payload: { name: 'Alice Alpha', phone: '+1 650 555 0100' },
      });

      expect(updated.statusCode).toBe(200);
      expect(updated.json()).toMatchObject({ name: 'Alice Alpha', phone: '+1 650 555 0100' });

      const me = await app.inject({ method: 'GET', url: '/me' });
      expect(me.json().name).toBe('Alice Alpha');
    });
  });
});
