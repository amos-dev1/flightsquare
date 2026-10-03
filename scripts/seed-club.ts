/**
 * Fill a club with enough data to judge the screens by.
 *
 *   npm run seed:club                        # demo@flightsquare.local / demo
 *   npm run seed:club -- me@you.test my-club
 *
 * `scripts/seed-demo.sh` creates an account and stops there, on the stated
 * grounds that clicking through the UI is the only way to find out whether it
 * works. That holds for one aircraft and one pilot. It stops holding for a
 * club: a four-aircraft fleet with six members, a hundred flights of meter
 * history, a grounding squawk and a week of bookings is not something anybody
 * types in, and most screens in this product only show their real shape once
 * there is a fleet in them.
 *
 * **Everything that can go through the API does.** Not fastidiousness — it is
 * the only way the data comes out consistent. Logging a flight is what advances
 * the meters, ticks the maintenance items down and writes the charge against
 * the pilot (§3.4's core loop, §3.7's charges). Inserting rows directly would
 * produce a database that looks full and is wrong in every derived number,
 * which is a worse place to judge a screen from than an empty one.
 *
 * Two things cannot, and both are the control plane rather than a shortcut:
 *
 *   1. **The plan.** §2.3 is explicit that `app_role` must not write
 *      `plan_code` — "a role that can write it resolves itself onto every flag
 *      and every quota in the registry". A club needs more than one aircraft,
 *      so something has to set it, and that something is the owner role.
 *   2. **Invite tokens.** The token is mailed and never returned by the API,
 *      because an API that hands back what it just mailed has made the mail
 *      pointless. `app_role` cannot read the outbox at all — the bodies carry
 *      live single-use links. So the owner reads it, exactly as
 *      `scripts/outbox.sh` does for a human.
 *
 * Re-running is not an error: it finds an already-seeded club and stops rather
 * than doubling everything.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';

// ---------------------------------------------------------------------------
// Configuration — the same defaults scripts/lib.sh uses, so .env is optional
// ---------------------------------------------------------------------------

loadDotEnv();

const ARGS = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const FLAGS = new Set(process.argv.slice(2).filter((arg) => arg.startsWith('--')));

const API = process.env.FS_API_URL ?? 'http://127.0.0.1:3000';
const ADMIN_EMAIL = ARGS[0] ?? 'demo@flightsquare.local';
const SLUG = ARGS[1] ?? 'demo';
const CLUB = process.env.FS_DEMO_NAME ?? 'Demo Flying Club';
const PASSWORD = process.env.FS_DEMO_PASSWORD ?? 'correct horse battery staple';

/** The club's zone. Every local time below is written in it. */
const ZONE = 'America/Chicago';
/** Its home field, and the one most flights come back to. */
const HOME = 'KLOT';

function loadDotEnv(): void {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const line of readFileSync(join(here, '..', '.env'), 'utf8').split('\n')) {
      const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
      if (match && !(match[1]! in process.env)) {
        process.env[match[1]!] = match[2]!.replace(/^["']|["']$/g, '');
      }
    }
  } catch {
    // No .env is the normal case; the defaults below are lib.sh's.
  }
}

/**
 * The owner role, for one control-plane write and one control-plane read.
 * A separate connection from anything the application uses, on purpose.
 */
const owner = new Pool({
  host: process.env.FS_DB_HOST ?? '127.0.0.1',
  port: Number(process.env.FS_DB_PORT ?? 5432),
  database: process.env.FS_DB_NAME ?? 'flightsquare',
  user: 'flightsquare_owner',
  password: process.env.FS_OWNER_PASSWORD ?? 'owner_dev_password',
  max: 2,
});

// ---------------------------------------------------------------------------
// A deterministic shuffle
//
// Seeded, so two runs produce the same club and a screenshot taken today can
// be compared with one taken next week. Nothing here needs cryptographic
// randomness and everything here benefits from being reproducible.
// ---------------------------------------------------------------------------

let state = 0x9e3779b9;
function random(): number {
  state = (state * 1664525 + 1013904223) >>> 0;
  return state / 0x100000000;
}
function pick<T>(items: readonly T[]): T {
  return items[Math.floor(random() * items.length)]!;
}
function between(low: number, high: number, places = 1): number {
  return Number((low + random() * (high - low)).toFixed(places));
}

// ---------------------------------------------------------------------------
// The API, used the way a client uses it
// ---------------------------------------------------------------------------

class Session {
  constructor(
    readonly label: string,
    private token: string,
  ) {}

  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        // Harmless where it is not required, and §8.2 requires it on flights
        // and squawks. This is a client like any other.
        'idempotency-key': `seed-${crypto.randomUUID()}`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      throw new Error(
        `${method} ${path} as ${this.label} → ${response.status}: ${await response.text()}`,
      );
    }
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
}

async function anon<T>(method: string, path: string, body?: unknown): Promise<T> {
  // Login allows ten in five minutes, by address (§1.6: 429 is requests per
  // unit time, and never a plan quota). This script signs in as a handful of
  // people, so a second run inside the window would otherwise fail halfway
  // through with the fleet in and the squawks not. 429 says exactly how long
  // to wait, so it waits.
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(`${API}${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    if (response.status === 429 && attempt < 2) {
      const retry = (await response.clone().json().catch(() => ({}))) as { retry_after?: number };
      const seconds = Math.min(retry.retry_after ?? 60, 310);
      console.log(`  · rate limited on ${path}; waiting ${seconds}s`);
      await new Promise((resolve) => setTimeout(resolve, (seconds + 2) * 1000));
      continue;
    }

    if (!response.ok) {
      throw new Error(`${method} ${path} → ${response.status}: ${await response.text()}`);
    }
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
}

/**
 * Sign in, then choose the tenant.
 *
 * Two calls, because §1.1 keeps which tenant a request acts in on the session
 * row rather than in the token: the client says which of *its own*
 * memberships, and the server resolves it.
 */
async function signIn(email: string, password: string, label: string): Promise<Session> {
  const login = await anon<{
    access_token: string;
    memberships: { tenant_id: string }[];
  }>('POST', '/auth/login', { email, password });

  const tenantId = login.memberships[0]?.tenant_id;
  if (!tenantId) throw new Error(`${email} has no membership to select`);

  const session = new Session(label, login.access_token);
  await session.call('POST', '/auth/tenant', { tenant_id: tenantId });
  return session;
}

/**
 * Which membership belongs to an address.
 *
 * Asked of the admin, because a Pilot cannot answer it: §4.4 gives the Pilot
 * bundle `members: none`, so a pilot's own session is refused 403 on
 * `/members`. That is the permission model working — nothing in the product
 * needs a client to know its own membership id, because every endpoint that
 * cares resolves it server-side from the session.
 */
async function membershipFor(admin: Session, email: string): Promise<string> {
  const members = await admin.call<{ id: string; email: string }[]>('GET', '/members');
  const own = members.find((m) => m.email.toLowerCase() === email.toLowerCase());
  if (!own) throw new Error(`${email} is not in the club's member list`);
  return own.id;
}

// ---------------------------------------------------------------------------
// Times, written in the club's zone
// ---------------------------------------------------------------------------

/** Midnight-anchored day offsets, so "nine days ago" is a date not an instant. */
function dayOffset(days: number): Date {
  const now = new Date();
  now.setUTCHours(12, 0, 0, 0);
  return new Date(now.getTime() + days * 86_400_000);
}

function isoDate(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: ZONE }).format(date);
}

/**
 * A wall-clock time in the club's zone, as an instant.
 *
 * Built by asking what the offset is on that date rather than assuming one:
 * Chicago is -5 in July and -6 in December, and a seed that straddles the
 * change would otherwise put bookings an hour out either side of it.
 */
function atLocal(date: Date, hour: number, minute = 0): Date {
  const day = isoDate(date);
  const guess = new Date(`${day}T${pad(hour)}:${pad(minute)}:00Z`);
  const offset = guess.getTime() - new Date(guess.toLocaleString('sv-SE', { timeZone: ZONE }) + 'Z').getTime();
  return new Date(guess.getTime() + offset);
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

const money = (dollars: number): number => Math.round(dollars * 100);

// ---------------------------------------------------------------------------
// The club
// ---------------------------------------------------------------------------

interface MemberSpec {
  email: string;
  name: string;
  role: 'admin' | 'pilot';
  /** Left as an unaccepted invitation, to show that state on the members page. */
  pending?: boolean;
}

const MEMBERS: MemberSpec[] = [
  { email: 'dana.whitfield@demo.flightsquare.test', name: 'Dana Whitfield', role: 'admin' },
  { email: 'marcus.oyelaran@demo.flightsquare.test', name: 'Marcus Oyelaran', role: 'pilot' },
  { email: 'priya.raghunathan@demo.flightsquare.test', name: 'Priya Raghunathan', role: 'pilot' },
  { email: 'tom.brennan@demo.flightsquare.test', name: 'Tom Brennan', role: 'pilot' },
  { email: 'sylvia.koenig@demo.flightsquare.test', name: 'Sylvia Koenig', role: 'pilot' },
  { email: 'nate.okafor@demo.flightsquare.test', name: 'Nate Okafor', role: 'pilot', pending: true },
];

interface AircraftSpec {
  registration: string;
  type_code: string;
  year_manufactured: number;
  serial_number: string;
  ownership: 'owned' | 'leased' | 'leaseback' | 'club_owned';
  home_base: string;
  seats: number;
  /** §3.4: which meter drives maintenance, and §3.7: which one bills. They differ. */
  maintenance_meter: 'hobbs' | 'tach' | 'airframe';
  billing_meter: 'hobbs' | 'tach';
  rate_basis: 'wet' | 'dry';
  rate: number;
  fuel_capacity: number;
  hobbs: number;
  tach: number;
  /** Hobbs per flight hour the tach records. Real aeroplanes, real difference. */
  tachRatio: number;
  /** Gallons an hour, for the fuel state the next pilot reads. */
  burn: number;
}

/**
 * Four aeroplanes, deliberately not four of the same thing.
 *
 * The 91BK is a **leaseback** (§3.2): an owner leases it to the club, the club
 * schedules it, and it is on a dry rate so fuel is the pilot's own cost with
 * no ledger effect. The others are club-owned and wet, which is the common
 * arrangement and the one where buying fuel earns a credit (§3.7).
 *
 * Every one bills on Hobbs and runs engine intervals on tach, which §3.4 calls
 * the common pairing — and which is only visible as a distinction once there
 * is enough history for the two numbers to have drifted apart.
 */
const FLEET: AircraftSpec[] = [
  {
    registration: 'N4521G',
    type_code: 'C172',
    year_manufactured: 1978,
    serial_number: '17271234',
    ownership: 'club_owned',
    home_base: HOME,
    seats: 4,
    maintenance_meter: 'tach',
    billing_meter: 'hobbs',
    rate_basis: 'wet',
    rate: 155,
    fuel_capacity: 40,
    hobbs: 4821.6,
    tach: 3902.4,
    tachRatio: 0.92,
    burn: 8.4,
  },
  {
    registration: 'N738TR',
    type_code: 'C182',
    year_manufactured: 1981,
    serial_number: '18267890',
    ownership: 'club_owned',
    home_base: HOME,
    seats: 4,
    maintenance_meter: 'tach',
    billing_meter: 'hobbs',
    rate_basis: 'wet',
    rate: 210,
    fuel_capacity: 88,
    hobbs: 6214.3,
    tach: 5190.8,
    tachRatio: 0.9,
    burn: 13.2,
  },
  {
    registration: 'N91BK',
    type_code: 'P28A',
    year_manufactured: 1975,
    serial_number: '28-7515044',
    ownership: 'leaseback',
    home_base: HOME,
    seats: 4,
    maintenance_meter: 'tach',
    billing_meter: 'hobbs',
    rate_basis: 'dry',
    rate: 125,
    fuel_capacity: 50,
    hobbs: 3190.8,
    tach: 2744.1,
    tachRatio: 0.94,
    burn: 9.1,
  },
  {
    registration: 'N220SR',
    type_code: 'SR20',
    year_manufactured: 2019,
    serial_number: '2401',
    ownership: 'leased',
    home_base: 'KUGN',
    seats: 4,
    maintenance_meter: 'tach',
    billing_meter: 'hobbs',
    rate_basis: 'wet',
    rate: 245,
    fuel_capacity: 56,
    hobbs: 812.4,
    tach: 764.9,
    tachRatio: 0.95,
    burn: 11.6,
  },
];

/** Where club aeroplanes actually go from Lewis University. */
const DESTINATIONS = [
  'KJOT', 'KDPA', 'KARR', 'KPNT', 'KIKK', 'KVPZ', 'KGYY',
  'KRFD', 'KBMI', 'KMTO', 'KDEC', 'KLAF', 'KSBN', 'KMSN',
];

const PURPOSES = [
  'Local practice', 'Cross-country', 'Pattern work', 'Breakfast run',
  'Instrument practice', 'Lunch at Joliet', 'Currency', 'Sightseeing',
  'Airport tour', 'Night currency',
];

const REMARKS = [
  'Smooth air the whole way.',
  'Light chop below 3,000.',
  'Held for traffic on the ILS.',
  'Full stop and taxi back, four landings.',
  'Headwind both ways, as usual.',
  'Beautiful evening, no wind.',
  '',
  '',
];

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

interface Member extends MemberSpec {
  membershipId: string;
  /**
   * Whether this script knows their password, and so whether it can *be* them.
   *
   * Signing in is deliberately lazy and rare: login is rate limited to ten in
   * five minutes (by address, which is this machine), and almost nothing here
   * needs a second session. A flight names `flown_by`, a booking names
   * `booked_by`, a rate names a membership — all of them a membership id the
   * admin already holds. Only a squawk needs the session itself, because
   * `reported_by` is derived from it and is not settable.
   */
  seeded: boolean;
  session?: Session;
}

/** Sign in as a seeded member, once, and only when something needs it. */
async function sessionFor(member: Member): Promise<Session | undefined> {
  if (!member.seeded) return undefined;
  member.session ??= await signIn(member.email, PASSWORD, member.name);
  return member.session;
}

async function main(): Promise<void> {
  await assertApiUp();

  const admin = await ensureClub();
  const tenant = await admin.call<{ id: string; name: string }>('GET', '/tenant');

  if (FLAGS.has('--fresh')) {
    step('clearing the club out');
    await clearOperationalData(tenant.id);
  } else if (await alreadySeeded(admin)) {
    console.log(`\n· ${tenant.name} already has the seeded fleet in it.`);
    console.log('  To do it again from scratch:  npm run seed:club -- --fresh');
    console.log('  That clears this club\'s aircraft, flights, squawks, bookings and');
    console.log('  ledger — the tenant, the members and their logins stay.\n');
    return;
  }

  step('plan and settings');
  await makeItAClub(tenant.id);
  // The club's zone, so every time in the app reads the way the club says it.
  await admin.call('PATCH', '/tenant', { name: CLUB, timezone: ZONE });

  step('members');
  const members = await inviteEveryone(admin);

  step('fleet');
  const fleet = await addFleet(admin);

  step('checkouts');
  await signPeopleOff(admin, fleet, members);

  step('rates');
  await setRates(admin, fleet, members);

  step('flights');
  await flyFor120Days(admin, fleet, members);

  step('maintenance');
  await recordCompliance(admin, fleet);

  step('documents');
  await fileDocuments(admin, fleet);

  step('squawks');
  await fileSquawks(admin, fleet, members);

  step('bookings');
  await bookTheWeek(admin, fleet, members);

  step('ledger');
  await recordPayments(admin);

  await report(admin);
}

function step(label: string): void {
  process.stdout.write(`→ ${label}\n`);
}

async function assertApiUp(): Promise<void> {
  try {
    await anon('GET', '/health');
  } catch {
    console.error(`no API at ${API} — start it first:\n  npm run dev\n`);
    process.exit(1);
  }
}

/**
 * The account. Created if it is not there, signed into either way.
 *
 * Signup is §2.1's one write door — the only operation in the product that
 * provably cannot have tenant context, because the tenant does not exist yet.
 * The ordinary case for this script is that the account is already there and
 * the answer is 409, which is not a failure: topping up a club somebody is
 * already testing with is the whole point.
 */
async function ensureClub(): Promise<Session> {
  // Try the door before knocking a hole in the wall. Signup is rate limited to
  // five per hour per address (§2.1: abuse is the API's problem, not the
  // policy's), and a script that calls it on every run spends that budget on
  // an account that was already there — then cannot get in for an hour.
  try {
    const session = await signIn(ADMIN_EMAIL, PASSWORD, 'admin');
    console.log(`· signed in as ${ADMIN_EMAIL}`);
    return session;
  } catch {
    // Not there, or not with that password. Signup answers which.
  }

  const response = await fetch(`${API}/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      slug: SLUG,
      name: CLUB,
      email: ADMIN_EMAIL,
      password: PASSWORD,
      // A club, not a solo owner. §3.1: descriptive, for onboarding copy and
      // quota defaults — never read at runtime to decide behaviour.
      archetype: 'club',
    }),
  });

  if (response.status === 201) console.log(`✓ created ${CLUB}`);
  else if (response.status === 409) {
    // The account exists and the password above did not open it. Nothing here
    // can fix that, and guessing is not a thing this should do.
    console.error(`${ADMIN_EMAIL} exists but ${PASSWORD.length} characters did not sign in.`);
    console.error('Set FS_DEMO_PASSWORD to the real one and run it again.');
    process.exit(1);
  } else if (response.status === 429) {
    console.error('rate limited — signup allows 5 per hour per address.');
    console.error('Wait, or restart the API to clear the limiter.');
    process.exit(1);
  } else {
    console.error(`signup failed with ${response.status}: ${await response.text()}`);
    process.exit(1);
  }

  return signIn(ADMIN_EMAIL, PASSWORD, 'admin');
}

/**
 * Whether this has been run before.
 *
 * By registration rather than by counting, because the club this is pointed at
 * may already have aeroplanes in it — the whole reason it tops up rather than
 * creates. If the Skyhawk this script adds is there, so is everything else.
 */
async function alreadySeeded(admin: Session): Promise<boolean> {
  // Archived aircraft are in this list too, which is what makes it a reliable
  // "has this run" check rather than a count that an archive would change.
  const fleet = await admin.call<{ registration: string }[]>('GET', '/aircraft');
  return fleet.some((row) => row.registration === FLEET[0]!.registration);
}

/**
 * **Control plane.** §4.3's Pro tier is one aircraft; Enterprise is unlimited,
 * and open decision 1 already notes that a club with three aeroplanes has
 * nowhere to land in between. Until there is a middle tier, a demo club is an
 * Enterprise club.
 *
 * Written as the owner because §2.3 forbids `app_role` from touching
 * `plan_code`: it is the left-hand layer of §1.4's chain, so a role that can
 * write it resolves itself onto every flag and quota in the registry while
 * `assert_quota` goes on enforcing a limit the caller has just rewritten.
 */
async function makeItAClub(tenantId: string): Promise<void> {
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    // §1.1: `SET LOCAL`, inside the transaction, never a plain SET — and the
    // owner needs it as much as the application does, because `tenants` is
    // FORCE ROW LEVEL SECURITY and the owner is not exempt. Without context
    // this UPDATE matches no rows, which is the designed failure mode.
    // `set_config(..., true)` rather than `SET LOCAL '…'` because SET takes no
    // parameters and §6 forbids building SQL by interpolation — including in
    // scripts, and including where the value has just come from the API.
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    await client.query(
      // `archetype` is descriptive only (§3.1) — onboarding copy and quota
      // defaults, never read at runtime to decide behaviour. A club that says
      // 'solo' is just a label that was right when the account was made.
      `UPDATE public.tenants SET plan_code = 'enterprise', archetype = 'club' WHERE id = $1`,
      [tenantId],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  console.log('  · enterprise, archetype club, zone ' + ZONE);
}

/**
 * **Control plane.** Empty one club of its operational data.
 *
 * Only reachable with `--fresh`, and only ever scoped to one tenant id. This is
 * the admin plane doing something the application deliberately cannot: §3.6 and
 * §3.7 make compliance records, squawk history and charges append-only, which
 * means `app_role` holds SELECT and INSERT on them and nothing else. That is
 * the right grant and it is also why a seed cannot tidy up after itself through
 * the API.
 *
 * It runs as the superuser rather than the owner because the owner is subject
 * to FORCE ROW LEVEL SECURITY like everybody else, and the point here is to
 * delete across a dozen tables rather than to prove a policy. The tenant, its
 * members and their logins are left alone — it is the flying that goes, not the
 * club.
 */
async function clearOperationalData(tenantId: string): Promise<void> {
  const superuser = new Pool({
    host: process.env.FS_DB_HOST ?? '127.0.0.1',
    port: Number(process.env.FS_DB_PORT ?? 5432),
    database: process.env.FS_DB_NAME ?? 'flightsquare',
    user: 'postgres',
    password: process.env.POSTGRES_PASSWORD ?? 'postgres',
    max: 1,
  });

  // Foreign keys, leaves first — the same order api/test/helpers/fixtures.ts
  // uses, and for the same reason: the ledger points at flights, maintenance
  // points at flights and work orders, and scheduling points at both aircraft
  // and memberships.
  const order = [
    'attachments',
    'flight_charges',
    'fuel_credits',
    'ledger_adjustments',
    'member_aircraft_rates',
    'aircraft_rates',
    'reservation_resources',
    'reservations',
    'blackouts',
    'member_aircraft_authorizations',
    'compliance_records',
    'squawk_deferrals',
    'squawks',
    'work_orders',
    'maintenance_items',
    'meter_readings',
    'flights',
    'idempotency_keys',
    'aircraft_config',
    'aircraft',
  ];

  try {
    for (const table of order) {
      // Parameterised, like everything else (§6). The table name is from the
      // list above and never from input.
      await superuser.query(`DELETE FROM public.${table} WHERE tenant_id = $1`, [tenantId]);
    }
    // The usage counters are maintained by triggers that have just fired on a
    // few hundred deletes, so they are already correct. Said out loud because
    // resetting them by hand here would be the bug: §2.3 keeps that column out
    // of the application's reach precisely so nothing writes it directly.
    console.log(`  · ${order.length} tables emptied for this tenant`);
  } finally {
    await superuser.end();
  }
}

/**
 * Invite, read the token out of the mail, accept.
 *
 * The whole real flow, because the alternative — inserting memberships — skips
 * the trigger that keeps a club from losing its last member who can manage
 * members (§4.4) and the quota counting in §4.5. One of these is left
 * unaccepted on purpose: a members page with nothing pending on it has never
 * shown anybody what pending looks like.
 */
async function inviteEveryone(admin: Session): Promise<Member[]> {
  const members: Member[] = [];

  // Whoever is in the club already — the admin whose account this is, and
  // anybody they have invited themselves. They keep their own password, so
  // they are listed rather than signed in as.
  const existing = await admin.call<{ id: string; email: string; status: string }[]>(
    'GET',
    '/members',
  );
  for (const row of existing) {
    if (row.status !== 'active') {
      console.log(`  · ${row.email} was already here (${row.status})`);
      continue;
    }
    // One this script seeded on an earlier run, perhaps one that did not
    // finish. It knows their password, so it can be them — which matters,
    // because a squawk's `reported_by` comes from the session and is not
    // settable, and a club where every defect was found by the same person is
    // not a club.
    const seeded = MEMBERS.find((m) => m.email.toLowerCase() === row.email.toLowerCase());
    if (seeded) {
      members.push({ ...seeded, membershipId: row.id, seeded: true });
      console.log(`  · ${seeded.name} was already here`);
      continue;
    }

    // Somebody's real account, whose password this script does not know. They
    // still fly, get charged and get booked for — all of which name a
    // membership rather than a session.
    members.push({
      email: row.email,
      name: row.email.split('@')[0]!,
      role: 'pilot',
      membershipId: row.id,
      seeded: false,
    });
    console.log(`  · ${row.email} was already here (not seeded — no squawks filed as them)`);
  }
  const known = new Set(existing.map((row) => row.email.toLowerCase()));

  for (const spec of MEMBERS) {
    if (known.has(spec.email.toLowerCase())) continue;

    try {
      await admin.call('POST', '/invites', {
        email: spec.email,
        name: spec.name,
        role: spec.role,
      });
    } catch (error) {
      // An invitation already in flight. For the one left deliberately
      // unaccepted that is the state wanted; for the rest the token below
      // resolves whichever is current.
      if (!String(error).includes('409')) throw error;
      console.log(`  · ${spec.name} already had an invitation pending`);
    }

    if (spec.pending) {
      console.log(`  · ${spec.name} invited, not yet accepted`);
      continue;
    }

    const token = await inviteTokenFor(spec.email);
    await anon('POST', `/invites/token/${token}/accept`, {
      password: PASSWORD,
      name: spec.name,
    });

    members.push({
      ...spec,
      membershipId: await membershipFor(admin, spec.email),
      seeded: true,
    });
    console.log(`  · ${spec.name} (${spec.role})`);
  }

  return members;
}

/**
 * **Control plane.** The token is mailed, never returned by the API, and
 * `app_role` cannot read the outbox at all — the bodies carry live single-use
 * links, so an application that could read them back could read every password
 * reset in flight. The owner holds a read for exactly this, which is also what
 * `scripts/outbox.sh` uses.
 */
async function inviteTokenFor(email: string): Promise<string> {
  const { rows } = await owner.query<{ body: string }>(
    `SELECT body FROM public.outbox
      WHERE lower(to_email) = lower($1) AND kind = 'invite'
      ORDER BY created_at DESC LIMIT 1`,
    [email],
  );
  const token = /accept-invite\?token=([A-Za-z0-9_%.~-]+)/.exec(rows[0]?.body ?? '')?.[1];
  if (!token) throw new Error(`no invitation mail found for ${email}`);
  return decodeURIComponent(token);
}

/**
 * Add the fleet, and adopt whatever is already in the hangar.
 *
 * An aeroplane the club already had goes on flying: it keeps its registration,
 * its home base is moved to the club's field so the fleet reads coherently, and
 * its meters pick up from wherever its own history left them. Leaving it out
 * would produce the odd result of a club whose oldest aeroplane stopped flying
 * the day the demo data started.
 *
 * Archived ones are left exactly as they are. §5.5 keeps their history and they
 * cannot be assigned to new flights or reservations, which is the state working
 * rather than a gap — and an archived row in the list is worth seeing.
 */
async function addFleet(admin: Session): Promise<Map<string, { id: string; spec: AircraftSpec }>> {
  const fleet = new Map<string, { id: string; spec: AircraftSpec }>();

  for (const existing of await admin.call<AircraftRow[]>('GET', '/aircraft')) {
    if (existing.status !== 'active') {
      console.log(`  · ${existing.registration} is archived — left alone (§5.5)`);
      continue;
    }
    await admin.call('PATCH', `/aircraft/${existing.id}`, { home_base: HOME });
    fleet.set(existing.registration, { id: existing.id, spec: adopt(existing) });
    console.log(`  · ${existing.registration} ${existing.type_code ?? ''} was already here`);
  }

  for (const spec of FLEET) {
    const created = await admin.call<{ id: string }>('POST', '/aircraft', {
      registration: spec.registration,
      type_code: spec.type_code,
      serial_number: spec.serial_number,
      year_manufactured: spec.year_manufactured,
      home_base: spec.home_base,
      ownership: spec.ownership,
      seats: spec.seats,
      maintenance_meter: spec.maintenance_meter,
      billing_meter: spec.billing_meter,
      rate_basis: spec.rate_basis,
      fuel_capacity: String(spec.fuel_capacity),
      fuel_units: 'gallons',
    });

    /**
     * Where the meters stood before any of this history, dated before it.
     *
     * `POST /aircraft` takes opening meters, and using them here would be
     * wrong in a way worth spelling out: that reading is recorded *now*, and
     * `refresh_aircraft_meter_totals` takes the latest reading **by
     * recorded-at** — which is §8.2's rule, because readings arrive out of
     * order and the server orders by when they happened rather than when they
     * landed. An opening reading stamped today therefore outranks four months
     * of backdated flying, and the aircraft would sit at its opening number
     * with every flight correctly logged behind it.
     *
     * So the opening reading is posted explicitly, dated the day before the
     * first flight. The totals then derive from the log the way §3.4 says they
     * should, and the meter history reads as what it is: a starting point,
     * then the flying.
     */
    await admin.call('POST', `/aircraft/${created.id}/meter-readings`, {
      hobbs: spec.hobbs.toFixed(1),
      tach: spec.tach.toFixed(1),
      airframe_hours: spec.hobbs.toFixed(1),
      recorded_at: atLocal(dayOffset(-121), 9).toISOString(),
      note: 'Opening reading, from the club\'s own book.',
    });

    fleet.set(spec.registration, { id: created.id, spec });
    console.log(`  · ${spec.registration} ${spec.type_code} (${spec.ownership})`);
  }

  return fleet;
}

interface AircraftRow {
  id: string;
  registration: string;
  type_code: string | null;
  status: string;
  hobbs: string | null;
  tach: string | null;
  fuel_capacity: string | null;
  maintenance_meter: 'hobbs' | 'tach' | 'airframe';
  billing_meter: 'hobbs' | 'tach';
  rate_basis: 'wet' | 'dry';
  default_rate_cents: number | null;
  seats: number | null;
}

/**
 * Describe an aeroplane the club already owns well enough to keep flying it.
 *
 * Only the three numbers the generator needs and the database does not hold:
 * how far the tach lags the Hobbs and what it burns an hour. Everything else is
 * read back from the aircraft rather than assumed, including where its meters
 * actually stand — which is the point of the totals being derived (§3.4).
 */
function adopt(row: AircraftRow): AircraftSpec {
  const known = FLEET.find((spec) => spec.type_code === row.type_code);
  return {
    registration: row.registration,
    type_code: row.type_code ?? 'C172',
    year_manufactured: 1980,
    serial_number: '',
    ownership: 'club_owned',
    home_base: HOME,
    seats: row.seats ?? 4,
    maintenance_meter: row.maintenance_meter,
    billing_meter: row.billing_meter,
    rate_basis: row.rate_basis,
    rate: (row.default_rate_cents ?? money(known?.rate ?? 155)) / 100,
    fuel_capacity: Number(row.fuel_capacity ?? known?.fuel_capacity ?? 40),
    hobbs: Number(row.hobbs ?? 0),
    tach: Number(row.tach ?? 0),
    tachRatio: known?.tachRatio ?? 0.92,
    burn: known?.burn ?? 8.6,
  };
}

/**
 * §3.5's checkout rule, and the reason it is a gate rather than a résumé:
 * "is Dave signed off in the 182?"
 *
 * Deliberately not everybody in everything. The 182 is the step-up aeroplane
 * and the SR20 is the one with the glass panel, so two members are not in them
 * — which is what makes the authorisation list on the aircraft page mean
 * something, and what makes a refused booking reachable from the UI.
 */
async function signPeopleOff(
  admin: Session,
  fleet: Map<string, { id: string; spec: AircraftSpec }>,
  members: Member[],
): Promise<void> {
  const notYet: Record<string, string[]> = {
    N738TR: ['Tom Brennan', 'Sylvia Koenig'],
    N220SR: ['Tom Brennan', 'Marcus Oyelaran'],
  };

  for (const [registration, aircraft] of fleet) {
    for (const member of members) {
      if (notYet[registration]?.includes(member.name)) continue;
      try {
        await admin.call('POST', `/aircraft/${aircraft.id}/authorizations`, {
          membership_id: member.membershipId,
          note: `Checked out by a club instructor in the ${aircraft.spec.type_code}.`,
        });
      } catch (error) {
        // Already signed off. Being authorised twice is not a thing.
        if (!/40[09]/.test(String(error))) throw error;
      }
    }
  }
  console.log('  · everyone in the 172 and the Cherokee; the 182 and the SR20 are narrower');
}

/**
 * §3.7's two-layer resolution: a member rate for this aircraft, then the
 * aircraft default. Both effective-dated, so a rate change is a new row and
 * historical re-pricing is structurally impossible rather than discouraged.
 *
 * The aircraft rates are backdated past the oldest flight, because a charge
 * snapshots whatever rule applied on the day — and a rate that starts after
 * the flight it should have priced produces a charge with no source.
 */
async function setRates(
  admin: Session,
  fleet: Map<string, { id: string; spec: AircraftSpec }>,
  members: Member[],
): Promise<void> {
  const from = isoDate(dayOffset(-200));

  const priced = await admin.call<{ aircraft_id: string }[]>('GET', '/rates');

  for (const [registration, aircraft] of fleet) {
    // An aeroplane that already has a rate keeps it. §3.7 rule 4 makes a rate
    // change a new row, and inventing one dated before the club's own would
    // re-price history that is already on somebody's statement.
    if (priced.some((row) => row.aircraft_id === aircraft.id)) {
      console.log(`  · ${registration} already priced — left alone`);
      continue;
    }
    await admin.call('POST', '/rates', {
      aircraft_id: aircraft.id,
      amount_cents: money(aircraft.spec.rate),
      effective_from: from,
    });
    console.log(`  · ${registration} $${aircraft.spec.rate}/hr ${aircraft.spec.rate_basis}`);
  }

  // One member on an associate rate in the 172 — the layer above the aircraft
  // default, and the thing that makes `rate_source` on a charge worth having.
  const associate = members.find((m) => m.name === 'Sylvia Koenig');
  const trainer = fleet.get('N4521G');
  if (associate && trainer) {
    // The same endpoint, with a membership: one more layer in the chain
    // rather than a second way of doing it (§1.4).
    await admin.call('POST', '/rates', {
      aircraft_id: trainer.id,
      membership_id: associate.membershipId,
      amount_cents: money(138),
      effective_from: from,
    });
    console.log('  · Sylvia Koenig $138/hr in the 172 (associate rate)');
  }

  // And a raise, three weeks ago, so February really does keep February's
  // price on the statements (§3.7 rule 1).
  const skylane = fleet.get('N738TR');
  if (skylane) {
    await admin.call('POST', '/rates', {
      aircraft_id: skylane.id,
      amount_cents: money(218),
      effective_from: isoDate(dayOffset(-21)),
    });
    console.log('  · N738TR raised to $218/hr three weeks ago');
  }
}

/**
 * Four months of flying, logged the way a pilot logs it.
 *
 * This is the part that makes everything else true. §3.4's core loop runs on
 * every one of these: the meters advance, the maintenance items tick down
 * against whichever meter each one specifies, and a charge is computed against
 * the pilot at whatever rate applied that day. Nothing below computes any of
 * that — the server does, which is the same reason §8.2 says the client never
 * computes anything that matters.
 *
 * Meters are continuous per aeroplane, because they are in life: a Hobbs start
 * is the last Hobbs end. One flight deliberately is not, further down.
 */
async function flyFor120Days(
  admin: Session,
  fleet: Map<string, { id: string; spec: AircraftSpec }>,
  members: Member[],
): Promise<void> {
  const cursors = new Map<string, { hobbs: number; tach: number; fuel: number; place: string }>();
  for (const [registration, { spec }] of fleet) {
    cursors.set(registration, {
      hobbs: spec.hobbs,
      tach: spec.tach,
      fuel: spec.fuel_capacity * 0.75,
      place: spec.home_base,
    });
  }

  const registrations = [...fleet.keys()];
  let logged = 0;

  // Oldest first, so the meters only ever go forwards and the charges land in
  // the order a statement reads them.
  for (let daysAgo = 120; daysAgo >= 1; daysAgo -= 1) {
    const date = dayOffset(-daysAgo);
    const day = new Date(date).getUTCDay();
    // Clubs fly at weekends. Three or four aeroplanes out on a Saturday is the
    // case §3.3 describes as "the normal case for a club with one popular
    // aircraft", and a calendar that never looks busy never shows that.
    const sorties = day === 0 || day === 6 ? 3 : random() < 0.45 ? 1 : 0;

    for (let i = 0; i < sorties; i += 1) {
      const registration = registrations[(daysAgo + i) % registrations.length]!;
      const aircraft = fleet.get(registration)!;
      const cursor = cursors.get(registration)!;

      // Whoever is signed off in it. §3.5: the checkout is about the aircraft,
      // not the pilot's résumé — and it is the same list the scheduler reads.
      const eligible = members.filter((m) => !isNotSignedOff(registration, m.name));
      const pilot = pick(eligible);

      const duration = between(0.8, 3.2);
      const tachHours = Number((duration * aircraft.spec.tachRatio).toFixed(1));
      const hobbsStart = cursor.hobbs;
      const hobbsEnd = Number((hobbsStart + duration).toFixed(1));
      const tachStart = cursor.tach;
      const tachEnd = Number((tachStart + tachHours).toFixed(1));

      // Fuel is state, not arithmetic across flights (§3.4) — but what the
      // aeroplane actually burned is what the next reading reflects, and a
      // pilot tops it off when it gets low.
      const burned = Number((duration * aircraft.spec.burn).toFixed(1));
      let remainingBefore = cursor.fuel;
      let addedQty = 0;
      if (remainingBefore - burned < aircraft.spec.fuel_capacity * 0.3) {
        addedQty = Number((aircraft.spec.fuel_capacity - remainingBefore).toFixed(1));
        remainingBefore = aircraft.spec.fuel_capacity;
      }
      const remainingAfter = Math.max(2, Number((remainingBefore - burned).toFixed(1)));

      const roundTrip = random() < 0.55;
      const destination = roundTrip ? cursor.place : pick(DESTINATIONS);
      const arrived = roundTrip ? cursor.place : destination;

      await admin.call('POST', '/flights', {
        aircraft_id: aircraft.id,
        flight_date: isoDate(date),
        // Who had the aeroplane — the billing subject and the accountability
        // record (§3.4), not the person filling in the form.
        flown_by: pilot.membershipId,
        departed_from: cursor.place,
        arrived_at: arrived,
        category: random() < 0.12 ? 'business' : 'personal',
        hobbs_start: hobbsStart.toFixed(1),
        hobbs_end: hobbsEnd.toFixed(1),
        tach_start: tachStart.toFixed(1),
        tach_end: tachEnd.toFixed(1),
        fuel_remaining_before: remainingBefore.toFixed(1),
        fuel_remaining_after: remainingAfter.toFixed(1),
        ...(addedQty > 0
          ? {
              fuel_added_qty: addedQty.toFixed(1),
              // §3.7 rule 3: integer minor units, and a price is money as much
              // as a total is. The server multiplies.
              fuel_price_cents: money(between(5.65, 6.4, 2)),
            }
          : {}),
        ...(pick(REMARKS) ? { remarks: pick(REMARKS) } : {}),
        recorded_at: atLocal(date, 14 + i * 2, 30).toISOString(),
      });

      cursor.hobbs = hobbsEnd;
      cursor.tach = tachEnd;
      cursor.fuel = remainingAfter;
      cursor.place = arrived;
      logged += 1;
    }
  }

  /**
   * And one that does not line up.
   *
   * §8.2: "a Hobbs start that doesn't match the previous flight's end is a
   * flag for the admin, never a rejection — the gap is real information,
   * usually a maintenance run or an unlogged flight." That flag has nothing to
   * point at in a database where every number is tidy, so here is the gap.
   */
  const cherokee = fleet.get('N91BK')!;
  const cursor = cursors.get('N91BK')!;
  const gapStart = Number((cursor.hobbs + 1.4).toFixed(1));
  await admin.call('POST', '/flights', {
    aircraft_id: cherokee.id,
    flight_date: isoDate(dayOffset(-1)),
    flown_by: pick(members).membershipId,
    departed_from: HOME,
    arrived_at: HOME,
    hobbs_start: gapStart.toFixed(1),
    hobbs_end: (gapStart + 1.1).toFixed(1),
    tach_start: (cursor.tach + 1.3).toFixed(1),
    tach_end: (cursor.tach + 2.3).toFixed(1),
    fuel_remaining_before: '34.0',
    fuel_remaining_after: '24.0',
    remarks: 'Hobbs did not match the book — asked the owner about it.',
    recorded_at: atLocal(dayOffset(-1), 17, 15).toISOString(),
  });
  cursor.hobbs = Number((gapStart + 1.1).toFixed(1));
  logged += 1;

  console.log(`  · ${logged} flights over four months`);
  for (const [registration, cursor] of cursors) {
    console.log(`  · ${registration} now ${cursor.hobbs.toFixed(1)} hobbs / ${cursor.tach.toFixed(1)} tach`);
  }
}

function isNotSignedOff(registration: string, name: string): boolean {
  const notYet: Record<string, string[]> = {
    N738TR: ['Tom Brennan', 'Sylvia Koenig'],
    N220SR: ['Tom Brennan', 'Marcus Oyelaran'],
  };
  return notYet[registration]?.includes(name) ?? false;
}

/**
 * Make the maintenance screen tell the truth.
 *
 * Adding an aircraft instantiates the preset intervals (§3.6) and every one of
 * them starts out saying "not recorded", which is correct and also means the
 * screen cannot show an item coming due. Recording compliance rolls each one
 * forward from a real date, and the four aeroplanes are deliberately staggered:
 * one has an annual due in a fortnight, one is comfortable, one has an ELT
 * battery that has gone past, and the SR20 is fresh out of its annual.
 */
async function recordCompliance(
  admin: Session,
  fleet: Map<string, { id: string; spec: AircraftSpec }>,
): Promise<void> {
  /*
    `hoursAgo` is the point of this whole function for the oil change.

    An oil change is due on tach hours, not on a date, so a compliance record
    with no meter reading on it anchors the interval at nothing — and
    `next_due_for` then rolls it forward from zero, which puts the item several
    thousand hours overdue the moment it is seeded. The dates alone are enough
    for an annual; an hours-based item needs the reading as well.

    The numbers are staggered on purpose, so the screens have one of each state
    to draw: 12 hours left, 28, 6, and 42 on a 50-hour interval.
  */
  const schedule: Record<string, { template: string; daysAgo: number; hoursAgo?: number }[]> = {
    // The 172 flies the most and its annual is the one coming up.
    N4521G: [
      { template: 'annual', daysAgo: 351 },
      { template: 'oil_change', daysAgo: 38, hoursAgo: 38 },
      { template: 'elt_battery', daysAgo: 420 },
      { template: 'elt_inspection', daysAgo: 351 },
      { template: 'transponder', daysAgo: 560 },
      { template: 'pitot_static', daysAgo: 560 },
    ],
    N738TR: [
      { template: 'annual', daysAgo: 142 },
      { template: 'oil_change', daysAgo: 22, hoursAgo: 22 },
      { template: 'elt_battery', daysAgo: 142 },
      { template: 'elt_inspection', daysAgo: 142 },
      { template: 'transponder', daysAgo: 300 },
      { template: 'pitot_static', daysAgo: 300 },
    ],
    // The leaseback, whose ELT battery has quietly gone past its date and whose
    // oil change is nearly on it. Both are very ordinary things to find on a
    // shared aeroplane, and between them they give the screens a `due_soon` and
    // an `overdue` to draw — 760 days was comfortably inside the placeholder
    // 60-month interval, so the case the comment described never appeared.
    N91BK: [
      { template: 'annual', daysAgo: 95 },
      { template: 'oil_change', daysAgo: 61, hoursAgo: 48 },
      { template: 'elt_battery', daysAgo: 1900 },
      { template: 'elt_inspection', daysAgo: 95 },
      { template: 'transponder', daysAgo: 420 },
      { template: 'pitot_static', daysAgo: 420 },
    ],
    N220SR: [
      { template: 'annual', daysAgo: 24 },
      { template: 'oil_change', daysAgo: 24, hoursAgo: 8 },
      { template: 'elt_battery', daysAgo: 24 },
      { template: 'elt_inspection', daysAgo: 24 },
      { template: 'transponder', daysAgo: 24 },
      { template: 'pitot_static', daysAgo: 24 },
    ],
  };

  const titles: Record<string, string> = {
    annual: 'Annual inspection',
    oil_change: 'Oil and filter change',
    elt_battery: 'ELT battery replacement',
    elt_inspection: 'ELT inspection',
    transponder: 'Transponder certification',
    pitot_static: 'Pitot-static certification',
  };

  for (const [registration, aircraft] of fleet) {
    const items = await admin.call<{ id: string; template_code: string | null }[]>(
      'GET',
      `/aircraft/${aircraft.id}/maintenance-items`,
    );

    // An aeroplane the club already had gets the comfortable schedule: it has
    // its own history and this is not the place to invent a crisis in it.
    const plan = schedule[registration] ?? [
      { template: 'annual', daysAgo: 118 },
      { template: 'oil_change', daysAgo: 30, hoursAgo: 30 },
      { template: 'elt_battery', daysAgo: 118 },
      { template: 'elt_inspection', daysAgo: 118 },
      { template: 'transponder', daysAgo: 260 },
      { template: 'pitot_static', daysAgo: 260 },
    ];

    // The meters as they now stand, after every seeded flight. Read rather than
    // assumed: the flights advanced them and the spec's figures are where they
    // started.
    const current = await admin.call<{ tach: string | null; hobbs: string | null }>(
      'GET',
      `/aircraft/${aircraft.id}`,
    );
    const tachNow = Number(current.tach ?? 0);

    for (const entry of plan) {
      const item = items.find((row) => row.template_code === entry.template);
      if (!item) continue;

      // Append-only, with the actor and the date (§3.6). A correction would be
      // a new row referencing this one, never an edit of it.
      await admin.call('POST', '/compliance-records', {
        aircraft_id: aircraft.id,
        maintenance_item_id: item.id,
        kind: entry.template === 'oil_change' ? 'repair' : 'inspection',
        method: entry.template.endsWith('battery') ? 'replacement' : 'inspection',
        title: titles[entry.template] ?? entry.template,
        complied_on: isoDate(dayOffset(-entry.daysAgo)),
        // Only where the interval is counted in hours, and never guessed where
        // it is not: a calendar item with a meter reading on it is noise.
        ...(entry.hoursAgo !== undefined && tachNow > entry.hoursAgo
          ? { complied_at_hours: (tachNow - entry.hoursAgo).toFixed(1), hours_meter: 'tach' }
          : {}),
        signed_by: pick(['R. Castellano', 'J. Moreau', 'D. Abernathy']),
        signed_certificate: `A&P ${Math.floor(between(2800000, 3900000, 0))}`,
      });
    }
    console.log(`  · ${registration} compliance recorded`);
  }
}

/**
 * The paperwork (§3.2), without the files.
 *
 * Document rows and no attachments, which is a real state and the honest one
 * for a seeder: a club knows the insurance expires on 31 March long before
 * anybody has scanned the certificate, and the API's upload is three steps with
 * actual bytes in the middle — inventing a PDF here would be inventing a
 * document, not seeding one.
 *
 * The dates are staggered so the screens have something to draw: one insurance
 * certificate coming up for renewal inside the reminder window, one registration
 * comfortably out, and the two that do not expire carrying no date at all.
 *
 * **None of it affects dispatch.** An expired certificate is a notice (§11), and
 * `aircraft_availability` never looks at this table.
 */
async function fileDocuments(
  admin: Session,
  fleet: Map<string, { id: string; spec: AircraftSpec }>,
): Promise<void> {
  const plan: Record<string, { kind: string; title: string; issued: number; expires?: number }[]> = {
    // The leaseback's insurance is the one coming due — the owner pays it and
    // the club is the one that notices.
    N91BK: [
      { kind: 'airworthiness', title: 'Standard airworthiness certificate', issued: -4800 },
      { kind: 'registration', title: 'Certificate of registration', issued: -1100, expires: 1450 },
      { kind: 'insurance', title: 'Hull and liability', issued: -320, expires: 44 },
      { kind: 'weight_balance', title: 'Weight and balance, as weighed', issued: -620 },
    ],
    N4521G: [
      { kind: 'airworthiness', title: 'Standard airworthiness certificate', issued: -7200 },
      { kind: 'registration', title: 'Certificate of registration', issued: -900, expires: 1650 },
      { kind: 'insurance', title: 'Hull and liability', issued: -200, expires: 165 },
      { kind: 'weight_balance', title: 'Weight and balance, as weighed', issued: -900 },
      { kind: 'operating_limitations', title: 'Operating limitations (POH supplement)', issued: -7200 },
    ],
    N738TR: [
      { kind: 'airworthiness', title: 'Standard airworthiness certificate', issued: -9000 },
      { kind: 'registration', title: 'Certificate of registration', issued: -1400, expires: 1150 },
      { kind: 'insurance', title: 'Hull and liability', issued: -240, expires: 125 },
    ],
    N220SR: [
      { kind: 'airworthiness', title: 'Standard airworthiness certificate', issued: -1500 },
      { kind: 'registration', title: 'Certificate of registration', issued: -1500, expires: 1050 },
      { kind: 'insurance', title: 'Hull and liability', issued: -60, expires: 305 },
      { kind: 'weight_balance', title: 'Weight and balance, as delivered', issued: -1500 },
    ],
  };

  for (const [registration, aircraft] of fleet) {
    for (const entry of plan[registration] ?? []) {
      await admin.call('POST', `/aircraft/${aircraft.id}/documents`, {
        kind: entry.kind,
        title: entry.title,
        issued_on: isoDate(dayOffset(entry.issued)),
        ...(entry.expires === undefined
          ? {}
          : { expires_on: isoDate(dayOffset(entry.expires)) }),
      });
    }
    console.log(`  · ${registration} documents on file`);
  }
}

/**
 * Defects, including the one that stops the aeroplane.
 *
 * Filed by the pilots rather than by the admin, because `reported_by` is
 * derived from the session and not settable — which is the right design and
 * means the only way to get a realistic squawk log is to sign in as the people
 * who found things. §1.5's line is the point: a pilot files these and cannot
 * close them.
 */
async function fileSquawks(
  admin: Session,
  fleet: Map<string, { id: string; spec: AircraftSpec }>,
  members: Member[],
): Promise<void> {
  // Only the seeded members have sessions — see inviteEveryone. A squawk's
  // `reported_by` comes from the session and is not settable, which is right
  // and means these have to be filed by the people who found them.
  const by = (name: string): Member | undefined =>
    members.find((m) => m.name === name && m.seeded);

  const filed: { registration: string; member: Member | undefined; body: Record<string, unknown> }[] = [
    {
      registration: 'N91BK',
      member: by('Priya Raghunathan'),
      body: {
        summary: 'Left brake pedal goes nearly to the floor',
        details:
          'Travels most of the way before it bites. Right side feels normal. Noticed on the taxi back.',
        severity: 'grounding',
        grounding: true,
      },
    },
    {
      registration: 'N4521G',
      member: by('Marcus Oyelaran'),
      body: {
        summary: 'Number two radio transmits with a loud hum',
        details: 'Receives fine. Tower asked me to switch to the other box.',
        severity: 'minor',
      },
    },
    {
      registration: 'N738TR',
      member: by('Dana Whitfield'),
      body: {
        summary: 'Cowl fastener missing on the lower right',
        details: 'One of the quarter-turn fasteners is gone. The rest are tight.',
        severity: 'minor',
      },
    },
    {
      registration: 'N4521G',
      member: by('Sylvia Koenig'),
      body: {
        summary: 'Landing light intermittent',
        details: 'Flickers on taxi and goes out above about 1,500 RPM.',
        severity: 'advisory',
      },
    },
    {
      registration: 'N220SR',
      member: by('Priya Raghunathan'),
      body: {
        summary: 'Right main tyre worn to the cord on the inboard shoulder',
        details: 'Visible on the preflight. Did not fly it.',
        severity: 'major',
        grounding: true,
      },
    },
  ];

  const ids: Record<string, string> = {};
  for (const entry of filed) {
    const aircraft = fleet.get(entry.registration);
    const session = entry.member ? await sessionFor(entry.member) : undefined;
    if (!aircraft || !session || !entry.member) continue;
    const created = await session.call<{ id: string; summary: string }>(
      'POST',
      '/squawks',
      { aircraft_id: aircraft.id, ...entry.body },
    );
    ids[created.summary] = created.id;
    console.log(`  · ${entry.registration}: ${created.summary} (${entry.member.name})`);
  }

  // The account owner, who holds `maintenance: write` and is always to hand.
  const closer = admin;

  // Resolved: §1.5's line. Filing took `squawks: write`, which every pilot
  // holds; moving it through its lifecycle takes `maintenance: write`, which
  // only an admin does.
  const fastener = ids['Cowl fastener missing on the lower right'];
  if (fastener) {
    await closer.call('PATCH', `/squawks/${fastener}`, {
      status: 'resolved',
      resolution_note: 'Fastener replaced from stock. Torqued and checked.',
    });
  }

  // Deferred: §3.6's MEL case. The defect stays open and the grounding lifts,
  // which is the distinction a deferral exists to make — and the availability
  // view reads `status = 'open'` precisely so that it does.
  const tyre = ids['Right main tyre worn to the cord on the inboard shoulder'];
  if (tyre) {
    await closer.call('POST', `/squawks/${tyre}/deferrals`, {
      basis: 'far_91_213',
      reference: '91.213(d)',
      expires_on: isoDate(dayOffset(21)),
      note: 'Tyre on order. Ferry to the shop at KUGN only, no passengers.',
    });
  }

  console.log('  · one resolved, one deferred, one still grounding the Cherokee');
}

/**
 * The next two weeks of the calendar.
 *
 * §6.2's checklist says booking paths consult `aircraft_availability` rather
 * than querying squawks directly, and this one does — not for form's sake: the
 * Cherokee has an open grounding squawk by now and the exclusion constraint and
 * the availability trigger would both refuse it. An aeroplane that is out is
 * out, and a seed that pretended otherwise would just crash.
 *
 * Bookings are made by the member who will be in the aeroplane, because §3.5's
 * checkout question is always about `booked_by` and never about who filled in
 * the form.
 */
async function bookTheWeek(
  admin: Session,
  fleet: Map<string, { id: string; spec: AircraftSpec }>,
  members: Member[],
): Promise<void> {
  const availability = await admin.call<
    { aircraft_id: string; registration: string; available: boolean }[]
  >('GET', '/availability');
  // Only what is in the fleet: an archived aeroplane is reported unavailable
  // too, and saying so would be noise — it was never a candidate.
  const relevant = availability.filter((row) => fleet.has(row.registration));
  const flyable = relevant.filter((row) => row.available).map((row) => row.registration);
  const grounded = relevant.filter((row) => !row.available).map((row) => row.registration);
  if (grounded.length > 0) {
    console.log(`  · ${grounded.join(', ')} is out — grounded, and the API would refuse (§6.2)`);
  }

  const slots: [number, number][] = [
    [8, 11],
    [12, 15],
    [16, 19],
  ];

  let booked = 0;
  for (let daysAhead = 0; daysAhead <= 13; daysAhead += 1) {
    const date = dayOffset(daysAhead);
    const weekend = [0, 6].includes(new Date(date).getUTCDay());

    for (const registration of flyable) {
      // A popular aeroplane on a Saturday is busy; a Tuesday is not.
      if (random() > (weekend ? 0.75 : 0.3)) continue;

      const aircraft = fleet.get(registration)!;
      const eligible = members.filter((m) => !isNotSignedOff(registration, m.name));
      const member = pick(eligible);
      const [from, to] = pick(slots);

      try {
        // Booked by the admin on the member's behalf, which is what a club
        // dispatcher does anyway. §3.5's checkout question is always about
        // `booked_by` — who will be in the aeroplane — and never about who
        // filled in the form, so this is still checked against *their*
        // authorisation and not against the admin's.
        await admin.call('POST', '/reservations', {
          aircraft_id: aircraft.id,
          booked_by: member.membershipId,
          starts_at: atLocal(date, from).toISOString(),
          ends_at: atLocal(date, to).toISOString(),
          purpose: pick(PURPOSES),
        });
        booked += 1;
      } catch (error) {
        // A slot somebody else already holds. The exclusion constraint decides
        // that, not this script, and §3.3 is explicit that the race is the
        // normal case rather than an exotic one.
        if (!String(error).includes('409')) throw error;
      }
    }
  }

  /**
   * And the aeroplane that will not be there.
   *
   * §3.3's blackouts: the annual is booked in, so the calendar shows a fortnight
   * where the 172 is unavailable for a reason that is nobody's booking.
   */
  const trainer = fleet.get('N4521G')!;
  await admin.call('POST', '/blackouts', {
    aircraft_id: trainer.id,
    reason: 'Annual inspection at Castellano Aviation',
    starts_at: atLocal(dayOffset(17), 7).toISOString(),
    ends_at: atLocal(dayOffset(27), 18).toISOString(),
  });

  console.log(`  · ${booked} bookings over two weeks, plus the 172's annual`);
}

/**
 * Money that has been paid.
 *
 * §10 settled that FlightSquare produces statements and does not move members'
 * money: the treasurer records a cheque, a transfer or cash at the hangar as an
 * adjustment. Without a few of those every balance on the page is the whole
 * four months of flying, which is not what a club ledger looks like in March.
 */
async function recordPayments(admin: Session): Promise<void> {
  const balances = await admin.call<
    { membership_id: string; member_email: string; balance_cents: number }[]
  >('GET', '/balances');

  let recorded = 0;
  for (const row of balances) {
    // Most of what they owe, not all of it — a ledger where everybody is
    // square is a ledger nobody has to look at.
    const owed = Math.abs(row.balance_cents);
    if (owed < 5000) continue;
    const paid = Math.round(owed * between(0.55, 0.95, 2));
    recorded += 1;

    await admin.call('POST', '/adjustments', {
      membership_id: row.membership_id,
      // Negative: a payment reduces what they owe. Integer minor units (§3.7).
      amount_cents: -paid,
      reason: pick([
        'Cheque, February statement',
        'Bank transfer',
        'Cash at the hangar',
        'Transfer, part payment',
      ]),
    });
  }
  console.log(`  · payments recorded against ${recorded} of ${balances.length} members`);
}

async function report(admin: Session): Promise<void> {
  const [fleet, flights, squawks, reservations, entitlements] = await Promise.all([
    admin.call<unknown[]>('GET', '/aircraft'),
    admin.call<unknown[]>('GET', '/flights'),
    admin.call<unknown[]>('GET', '/squawks'),
    admin.call<unknown[]>('GET', '/reservations'),
    admin.call<{ plan_code: string }>('GET', '/entitlements'),
  ]);

  console.log(`
  ${CLUB} is loaded.

    plan          ${entitlements.plan_code}
    aircraft      ${fleet.length}
    flights       ${flights.length}
    squawks       ${squawks.length}
    reservations  ${reservations.length}

  Sign in at   http://127.0.0.1:3001     (npm run dev:web)
  or in the iOS Simulator                (npm run dev:mobile)

    email       ${ADMIN_EMAIL}
    password    ${PASSWORD}

  Every seeded member signs in with the same password, so you can see the
  product as a Pilot rather than an Admin — which is the half §1.5 is about:

    marcus.oyelaran@demo.flightsquare.test     pilot
    priya.raghunathan@demo.flightsquare.test   pilot, filed the grounding squawk
    sylvia.koenig@demo.flightsquare.test       pilot, on an associate rate
    dana.whitfield@demo.flightsquare.test      a second admin
`);
}

main()
  .catch((error: unknown) => {
    console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => owner.end());
