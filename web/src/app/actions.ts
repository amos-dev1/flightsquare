'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';

import { ApiError, apiFetch, messageFor } from '@/lib/api';
import {
  clearSession,
  readDeviceToken,
  readSession,
  writeDeviceToken,
  writeSession,
} from '@/lib/session';
import { parseMoney } from '@/lib/money';
import { zonedToInstant } from '@flightsquare/shared/time';
import type {
  AerodromeResponse,
  AircraftResponse,
  BillingRedirectResponse,
  BookingMaintenanceCheckResponse,
  CheckoutRequest,
  FlightResponse,
  LoginResponse,
  PreviewMaintenanceResponse,
  SelectTenantResponse,
} from '@flightsquare/shared';

/**
 * What a button-driven action gives back.
 *
 * The form-driven actions use `FormState` through `useActionState`; the ones
 * invoked from an `onClick` inside a transition have nowhere to put an error
 * unless they return one. Throwing instead means the nearest error boundary
 * replaces the whole screen for what is usually a sentence — "you do not
 * have permission to change the fleet" — so none of them throw.
 */
export interface ActionResult {
  error?: string;
}

export interface FormState {
  error?: string;
  /**
   * §11 asks for a success state near the action. Without it these forms
   * come back with the text still sitting in the boxes and nothing saying
   * whether it went anywhere — which reads exactly like a failure.
   */
  saved?: boolean;
  /**
   * §11: preserve entered information after errors. A pilot who mistyped one
   * field should not have to read all four meters off the panel again.
   */
  values?: Record<string, string>;
}

/**
 * Sign in, and pick a tenant if there is only one to pick.
 *
 * §3.1: one human, one login, many memberships — so the common case for a
 * solo owner is exactly one membership and no reason to ask. Anyone with
 * more than one gets the picker.
 */
export async function login(_state: FormState, form: FormData): Promise<FormState> {
  const email = String(form.get('email') ?? '');
  const password = String(form.get('password') ?? '');

  let result: LoginResponse;
  try {
    result = await apiFetch<LoginResponse>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        email,
        password,
        // A browser that has passed a code before offers to skip the next
        // one. Worth nothing on its own: checked against this user, and only
        // after the password.
        ...((await readDeviceToken()) ? { device_token: await readDeviceToken() } : {}),
      }),
      token: '',
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      // The API answers a wrong password, an unknown address and a locked
      // account identically, and so does this.
      return { error: 'That email and password do not match an account.' };
    }
    if (error instanceof ApiError && error.status === 429) {
      return { error: 'Too many attempts. Wait a few minutes and try again.' };
    }
    return { error: messageFor(error) };
  }

  /*
    The password was right and that is deliberately not enough (0039).

    Nothing is written here — no session cookie, nothing to authenticate with —
    because the server minted no session either. The challenge goes back into
    the form's own state and the page becomes a code page.
  */
  if (result.mfa_required) {
    return {
      values: {
        challenge_id: result.challenge_id,
        sent_to: result.sent_to,
        next: String(form.get('next') ?? ''),
      },
    };
  }

  await grantSession(result);

  const next = String(form.get('next') ?? '');
  const only = result.memberships.length === 1 ? result.memberships[0] : undefined;
  if (only) {
    try {
      await selectTenant(only.tenant_id);
    } catch (error) {
      // The cookie is already written at this point, so a failure here
      // leaves the user signed in with no tenant selected. Sending them to
      // the picker is recoverable; letting this throw is a crash on a screen
      // that has a perfectly good error line.
      if (error instanceof ApiError) redirect('/choose-tenant');
      throw error;
    }
  }

  // Only a path on this site, never something the form supplied whole: a
  // `next` that could name another origin is an open redirect with a session
  // freshly in hand.
  const destination = /^\/[^/\\]/.test(next) ? next : '/aircraft';
  redirect(only ? destination : '/choose-tenant');
}

/**
 * Spend the code, and only then hold a session.
 *
 * Reached from the same form the password was typed into: the challenge id
 * travels in the form's state rather than in a URL, because a challenge in a
 * query string is one in browser history, in a referrer, and in whatever
 * copies the address bar.
 */
export async function verifyMfa(_state: FormState, form: FormData): Promise<FormState> {
  const challengeId = String(form.get('challenge_id') ?? '');
  const code = String(form.get('code') ?? '').trim();
  const remember = form.get('remember_device') === 'on';
  const next = String(form.get('next') ?? '');
  // Kept so a wrong code leaves the page on the code step rather than
  // throwing the person back to the password.
  const values = { challenge_id: challengeId, sent_to: String(form.get('sent_to') ?? ''), next };

  if (!/^\d{6}$/.test(code)) {
    return { error: 'The code is six digits.', values };
  }

  let result: LoginResponse;
  try {
    result = await apiFetch<LoginResponse>('/auth/mfa', {
      method: 'POST',
      body: JSON.stringify({
        challenge_id: challengeId,
        code,
        remember_device: remember,
      }),
      token: '',
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      // One sentence for wrong, spent and expired. The API makes no
      // distinction either, because the difference is what somebody working
      // through six digits wants to learn.
      return { error: 'That code is not right, or it has expired.', values };
    }
    if (error instanceof ApiError && error.status === 429) {
      return {
        error: 'Too many attempts on this code. Start again to get a new one.',
        values,
      };
    }
    return { error: messageFor(error), values };
  }

  // The server only ever grants here; the guard is for the type.
  if (result.mfa_required) return { error: 'Start again, please.', values };

  await grantSession(result);

  const only = result.memberships.length === 1 ? result.memberships[0] : undefined;
  if (only) {
    try {
      await selectTenant(only.tenant_id);
    } catch (error) {
      if (error instanceof ApiError) redirect('/choose-tenant');
      throw error;
    }
  }

  const destination = /^\/[^/\\]/.test(next) ? next : '/aircraft';
  redirect(only ? destination : '/choose-tenant');
}

/** Write what was granted: the session, and the device token if there is one. */
async function grantSession(result: Extract<LoginResponse, { mfa_required: false }>): Promise<void> {
  await writeSession({
    accessToken: result.access_token,
    refreshToken: result.refresh_token,
    expiresAt: result.expires_at,
  });
  if (result.device_token) await writeDeviceToken(result.device_token);
}

export async function selectTenant(tenantId: string): Promise<void> {
  const selected = await apiFetch<SelectTenantResponse>('/auth/tenant', {
    method: 'POST',
    body: JSON.stringify({ tenant_id: tenantId }),
  });

  const session = await readSession();
  if (session) await writeSession({ ...session, tenantId: selected.tenant_id });
}

export async function logout(): Promise<void> {
  try {
    await apiFetch('/auth/logout', { method: 'POST' });
  } catch {
    // Already gone as far as the API is concerned; drop the cookie regardless.
  }
  await clearSession();
  redirect('/login');
}

/**
 * Aerodromes matching what somebody has typed.
 *
 * The page used to send the whole table into a datalist, on the stated
 * grounds that it was "small enough at present". The import job made it
 * seventy thousand rows, and `/reference/aerodromes` caps at a hundred — so
 * the form would have silently offered the first hundred identifiers
 * alphabetically and looked, to anybody typing a K, broken.
 *
 * A server action rather than a fetch from the browser: the token lives in an
 * httpOnly cookie only this server can read.
 */
export async function searchAerodromes(q: string): Promise<AerodromeResponse[]> {
  const query = q.trim();
  if (query.length < 2) return [];
  try {
    return await apiFetch<AerodromeResponse[]>(
      `/reference/aerodromes?q=${encodeURIComponent(query)}`,
    );
  } catch {
    // A suggestion list that cannot be fetched is an empty suggestion list.
    // The field is free text either way (0011).
    return [];
  }
}

export async function createAircraft(_state: FormState, form: FormData): Promise<FormState> {
  const text = (key: string) => String(form.get(key) ?? '').trim();
  // Everything the form offered, kept so an error does not empty it (§11).
  // The registration and airport are upper-cased here rather than in the
  // input, so what comes back is what will actually be sent next time.
  const values = {
    registration: text('registration').toUpperCase(),
    type_code: text('type_code').toUpperCase(),
    home_base: text('home_base').toUpperCase(),
    year_manufactured: text('year_manufactured'),
    seats: text('seats'),
    maintenance_meter: text('maintenance_meter'),
    billing_meter: text('billing_meter'),
    rate_basis: text('rate_basis'),
    default_rate: text('default_rate'),
    fuel_capacity: text('fuel_capacity'),
    fuel_units: text('fuel_units'),
    hobbs: text('hobbs'),
    tach: text('tach'),
    airframe_hours: text('airframe_hours'),
  };

  const body: Record<string, unknown> = { registration: values.registration };
  if (values.type_code) body.type_code = values.type_code;
  if (values.home_base) body.home_base = values.home_base;
  if (values.year_manufactured) body.year_manufactured = Number(values.year_manufactured);
  if (values.seats) body.seats = Number(values.seats);
  if (values.maintenance_meter) body.maintenance_meter = values.maintenance_meter;
  if (values.billing_meter) body.billing_meter = values.billing_meter;
  if (values.rate_basis) body.rate_basis = values.rate_basis;
  if (values.fuel_capacity) body.fuel_capacity = values.fuel_capacity;
  if (values.fuel_units) body.fuel_units = values.fuel_units;

  // Meters travel as decimal strings the whole way: they are `numeric` in
  // Postgres, and a float round-trip is how a maintenance countdown drifts.
  for (const key of ['hobbs', 'tach', 'airframe_hours'] as const) {
    if (values[key]) body[key] = values[key];
  }

  if (values.default_rate) {
    // §3.7 rule 3: money is integer minor units. The form takes the rate the
    // club quotes, because that is what they know; the conversion happens
    // once, here, and never as floating-point arithmetic downstream.
    const perHour = Number(values.default_rate);
    if (!Number.isFinite(perHour) || perHour < 0) {
      return { error: 'Enter the hourly rate as an amount, for example 165.00.', values };
    }
    body.default_rate_cents = Math.round(perHour * 100);
  }

  let created: AircraftResponse;
  try {
    created = await apiFetch<AircraftResponse>('/aircraft', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  } catch (error) {
    return { error: messageFor(error), values };
  }

  revalidatePath('/aircraft');
  redirect(`/aircraft/${created.id}`);
}

/**
 * Record what the meters read.
 *
 * Values travel as strings the whole way — §3.4's meters are `numeric`, and a
 * float round-trip is how a maintenance countdown quietly drifts.
 */
export async function logReading(
  aircraftId: string,
  _state: FormState,
  form: FormData,
): Promise<FormState> {
  const text = (key: string) => String(form.get(key) ?? '').trim();
  const values = {
    hobbs: text('hobbs'),
    tach: text('tach'),
    airframe_hours: text('airframe_hours'),
    note: text('note'),
  };

  const body: Record<string, unknown> = {};
  for (const key of ['hobbs', 'tach', 'airframe_hours'] as const) {
    if (values[key]) body[key] = values[key];
  }
  if (values.note) body.note = values.note;

  if (!body.hobbs && !body.tach && !body.airframe_hours) {
    return { error: 'Enter at least one meter reading.', values };
  }

  try {
    await apiFetch(`/aircraft/${aircraftId}/meter-readings`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  } catch (error) {
    // A misread meter is worth retyping once; it is not worth retyping
    // because the screen threw it away.
    return { error: messageFor(error), values };
  }

  revalidatePath(`/aircraft/${aircraftId}`);
  revalidatePath('/maintenance');
  return { saved: true };
}

/** The per-aircraft settings of V1_SCOPE M2, changed after the fact. */
export async function updateAircraftConfig(
  aircraftId: string,
  _state: FormState,
  form: FormData,
): Promise<FormState> {
  const text = (key: string) => String(form.get(key) ?? '').trim();
  const values = {
    home_base: text('home_base').toUpperCase(),
    maintenance_meter: text('maintenance_meter'),
    billing_meter: text('billing_meter'),
    rate_basis: text('rate_basis'),
    default_rate: text('default_rate'),
    fuel_capacity: text('fuel_capacity'),
    fuel_units: text('fuel_units'),
    seats: text('seats'),
  };

  const body: Record<string, unknown> = {
    home_base: values.home_base || null,
    maintenance_meter: values.maintenance_meter,
    billing_meter: values.billing_meter,
    rate_basis: values.rate_basis,
    fuel_units: values.fuel_units,
    fuel_capacity: values.fuel_capacity || null,
    seats: values.seats ? Number(values.seats) : null,
  };

  if (values.default_rate) {
    const perHour = Number(values.default_rate);
    if (!Number.isFinite(perHour) || perHour < 0) {
      return { error: 'Enter the hourly rate as an amount, for example 165.00.', values };
    }
    body.default_rate_cents = Math.round(perHour * 100);
  }

  try {
    await apiFetch(`/aircraft/${aircraftId}`, { method: 'PATCH', body: JSON.stringify(body) });
  } catch (error) {
    return { error: messageFor(error), values };
  }

  revalidatePath(`/aircraft/${aircraftId}`);
  revalidatePath('/aircraft');
  return { saved: true };
}

export async function setAircraftStatus(
  aircraftId: string,
  status: string,
): Promise<ActionResult> {
  // §5.5: archiving is reversible and non-destructive. The history stays, and
  // the quota slot comes back — which also means restoring one has to pass
  // the quota check again, and can legitimately come back 402.
  try {
    await apiFetch(`/aircraft/${aircraftId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    });
  } catch (error) {
    return { error: messageFor(error) };
  }

  revalidatePath('/aircraft');
  revalidatePath(`/aircraft/${aircraftId}`);
  revalidatePath('/maintenance');
  return {};
}

/**
 * The post-flight entry (§3.4) — the most important screen in the product.
 *
 * Everything downstream is derived from it: the maintenance countdown, the
 * next pilot's dispatch decision, and eventually the charge. If it takes more
 * than a minute people skip it, the meters go stale, and every number in the
 * app quietly becomes wrong.
 */
export async function logFlight(
  aircraftId: string,
  _state: FormState,
  form: FormData,
): Promise<FormState> {
  const text = (key: string) => String(form.get(key) ?? '').trim();
  const values = Object.fromEntries(
    ['flight_date', 'hobbs_start', 'hobbs_end', 'tach_start', 'tach_end',
     'fuel_remaining_before', 'fuel_remaining_after', 'fuel_added_qty', 'fuel_added_cost',
     'departed_from', 'arrived_at', 'remarks',
     // §3.4: a correction is this flight replacing another, so it arrives on
     // the same form and down the same path. There is no PATCH.
     'supersedes_id', 'correction_reason'].map((k) => [k, text(k)]),
  );

  /**
   * Defects found on the walk-around, filed from the same form.
   *
   * §1.5 keeps `squawks` apart from `maintenance.items` exactly so a pilot can
   * report one without signing off work, and §3.6 keeps each its own record —
   * so these are separate writes to `/squawks`, not a field on the flight.
   * A row with no summary is not a squawk: the form shows one blank row by
   * default and a clean walk-around leaves it alone.
   */
  const squawkCount = Math.min(Number(text('squawk_count')) || 0, 20);
  values.squawk_count = String(squawkCount);
  const squawks: { summary: string; severity: string; details: string }[] = [];
  for (let i = 0; i < squawkCount; i += 1) {
    const draft = {
      summary: text(`squawk_summary_${i}`),
      severity: text(`squawk_severity_${i}`) || 'minor',
      details: text(`squawk_details_${i}`),
    };
    values[`squawk_summary_${i}`] = draft.summary;
    values[`squawk_severity_${i}`] = draft.severity;
    values[`squawk_details_${i}`] = draft.details;
    if (draft.summary) squawks.push(draft);
  }

  const body: Record<string, unknown> = {
    aircraft_id: aircraftId,
    flight_date: text('flight_date'),
  };

  // Meters travel as decimal strings the whole way: they are `numeric` in
  // Postgres, and a float round-trip is how a maintenance countdown drifts.
  for (const key of ['hobbs_start', 'hobbs_end', 'tach_start', 'tach_end'] as const) {
    if (values[key]) body[key] = values[key];
  }
  if (!body.hobbs_end && !body.tach_end) {
    return { error: 'Enter the Hobbs or tach reading at shutdown.', values };
  }

  // §3.4: fuel is state, and before and after are two readings of it — not a
  // level and a delta. Neither is derived from the other and nothing sums them.
  if (values.fuel_remaining_before) body.fuel_remaining_before = values.fuel_remaining_before;
  if (values.fuel_remaining_after) body.fuel_remaining_after = values.fuel_remaining_after;
  if (values.fuel_added_qty) body.fuel_added_qty = values.fuel_added_qty;
  if (values.fuel_added_cost) {
    // §3.7 rule 3: money is integer minor units. The form takes dollars
    // because that is what the receipt says; the conversion happens once,
    // here, and never as floating-point arithmetic downstream.
    const dollars = Number(values.fuel_added_cost);
    if (!Number.isFinite(dollars) || dollars < 0) {
      return { error: 'Enter the fuel cost as an amount, for example 204.10.', values };
    }
    body.fuel_added_cost_cents = Math.round(dollars * 100);
  }

  for (const key of ['departed_from', 'arrived_at'] as const) {
    if (values[key]) body[key] = values[key].toUpperCase();
  }
  if (values.remarks) body.remarks = values.remarks;

  if (values.supersedes_id) {
    // Five characters, matching the CHECK behind it. "oops" is not a record
    // of why a meter moved, and the constraint name is not an explanation.
    if ((values.correction_reason ?? '').length < 5) {
      return { error: 'Say what was wrong with the entry. It stays on the record.', values };
    }
    body.supersedes_id = values.supersedes_id;
    body.correction_reason = values.correction_reason;
  }

  const key = text('idempotency_key');
  let flight: FlightResponse;
  try {
    flight = await apiFetch<FlightResponse>('/flights', {
      method: 'POST',
      // §8.2: this write is made offline, retried, and advances the meters.
      // The same form instance reuses its key, so a retry after a dropped
      // connection cannot log the flight twice.
      headers: { 'idempotency-key': key },
      body: JSON.stringify(body),
    });
  } catch (error) {
    return { error: messageFor(error), values };
  }

  /*
    Each one named against the flight it was found on, which is what the id in
    the response is for — the web has a server in front of it and does not need
    to mint the flight's id the way the phone does (§8.2).

    Derived keys rather than one: the flight's key replays the flight, and a
    second squawk must not be mistaken for a retry of the first. Pressing Save
    again after a failure here therefore replays the flight (no second record,
    no second meter advance) and retries only what did not land.
  */
  for (const [index, squawk] of squawks.entries()) {
    try {
      await apiFetch('/squawks', {
        method: 'POST',
        headers: { 'idempotency-key': `${key}-squawk-${index}` },
        body: JSON.stringify({
          aircraft_id: aircraftId,
          summary: squawk.summary,
          severity: squawk.severity,
          // Severity 'grounding' is what reaches `aircraft_availability` and
          // stops the aeroplane being booked (§3.3).
          grounding: squawk.severity === 'grounding',
          ...(squawk.details ? { details: squawk.details } : {}),
          found_on_flight_id: flight.id,
        }),
      });
    } catch (error) {
      /*
        The flight is written and its meters have moved. Saying it failed
        would be false, and §3.6 makes the squawk log one of the records read
        back after an accident — so this names what did not land rather than
        swallowing it.
      */
      revalidatePath(`/aircraft/${aircraftId}`);
      revalidatePath('/aircraft');
      return {
        error:
          `The flight is saved and the meters have moved, but “${squawk.summary}” was not ` +
          `filed: ${messageFor(error)} Press Save flight again to retry just the defect — ` +
          'the flight will not be logged twice.',
        values,
      };
    }
  }

  revalidatePath(`/aircraft/${aircraftId}`);
  revalidatePath('/aircraft');
  revalidatePath('/flights');
  if (squawks.length > 0) {
    revalidatePath('/squawks');
    revalidatePath('/maintenance');
  }

  // A correction lands on the flight it produced, where the superseded entry
  // is visible beside it. A new flight lands on the aeroplane, where the
  // meters it just moved are.
  if (values.supersedes_id) {
    revalidatePath(`/flights/${values.supersedes_id}`);
    redirect(`/flights/${flight.id}?corrected=1`);
  }
  redirect(`/aircraft/${aircraftId}?logged=1`);
}

/**
 * A flight that never happened.
 *
 * The one thing a correction cannot say by replacing numbers, so it says so
 * instead: no meters, no charge, and the aeroplane falls back to the reading
 * before it. Still a correction and still append-only — the entry stays on
 * the log, labelled, beside the row that takes it back.
 */
export async function markLoggedInError(
  flight: FlightResponse,
  reason: string,
): Promise<ActionResult> {
  if (reason.trim().length < 5) return { error: 'Say why this is being taken back.' };

  try {
    await apiFetch('/flights', {
      method: 'POST',
      headers: { 'idempotency-key': `in-error-${flight.id}` },
      body: JSON.stringify({
        aircraft_id: flight.aircraft_id,
        flight_date: flight.flight_date,
        flown_by: flight.flown_by,
        supersedes_id: flight.id,
        correction_reason: reason.trim(),
        logged_in_error: true,
      }),
    });
  } catch (error) {
    return { error: messageFor(error) };
  }

  revalidatePath('/flights');
  revalidatePath(`/flights/${flight.id}`);
  revalidatePath(`/aircraft/${flight.aircraft_id}`);
  revalidatePath('/aircraft');
  revalidatePath('/billing');
  return {};
}

/**
 * Maintenance (§3.6).
 *
 * Every one of these is a thin pass-through: the API computes what is due,
 * decides what grounds an aircraft, and enforces who may close a squawk.
 * §8.2 is explicit that the client never computes anything that matters, and
 * "is this aeroplane legal to fly" is as close to mattering as it gets.
 */

/** Seed an existing aircraft from the preset library. Idempotent (§3.6). */
export async function seedMaintenanceItems(aircraftId: string): Promise<ActionResult> {
  try {
    await apiFetch(`/aircraft/${aircraftId}/maintenance-items/from-library`, { method: 'POST' });
  } catch (error) {
    return { error: messageFor(error) };
  }

  revalidatePath('/maintenance');
  revalidatePath(`/aircraft/${aircraftId}`);
  return {};
}

/**
 * Recording compliance — which is also how a seeded item gets its real date.
 *
 * The item rolls forward server-side, by calendar months where that is the
 * basis, because 14 CFR 91.409 counts calendar months and an annual signed
 * on the 14th is good through the end of the month.
 */
export async function recordCompliance(
  aircraftId: string,
  itemId: string,
  _state: FormState,
  form: FormData,
): Promise<FormState> {
  const text = (key: string) => String(form.get(key) ?? '').trim();
  const values = Object.fromEntries(
    ['complied_on', 'complied_at_hours', 'signed_by', 'signed_certificate', 'note'].map((k) => [
      k,
      text(k),
    ]),
  );

  if (!values.complied_on) {
    return { error: 'Enter the date the work was signed off.', values };
  }

  const body: Record<string, unknown> = {
    aircraft_id: aircraftId,
    maintenance_item_id: itemId,
    kind: 'inspection',
    title: text('title') || 'Maintenance',
    complied_on: values.complied_on,
  };
  // A decimal string the whole way: the meters are `numeric`, and a float
  // round-trip is how a countdown drifts.
  if (values.complied_at_hours) body.complied_at_hours = values.complied_at_hours;
  if (values.signed_by) body.signed_by = values.signed_by;
  if (values.signed_certificate) body.signed_certificate = values.signed_certificate;
  if (values.note) body.note = values.note;

  try {
    await apiFetch('/compliance-records', { method: 'POST', body: JSON.stringify(body) });
  } catch (error) {
    return { error: messageFor(error), values };
  }

  revalidatePath('/maintenance');
  revalidatePath('/aircraft');
  revalidatePath(`/aircraft/${aircraftId}`);
  return { saved: true };
}

/**
 * Adding something to track (SPEC §4.2, mockup 03), or editing it.
 *
 * `rules` and not the older `interval_*` fields: an item can be due on up to
 * three bases at once and the earliest wins, which the single interval could
 * not say. The due points are the server's — the form sends what was typed and
 * what it was last done at, and §8.2 keeps the arithmetic on the far side.
 */
export async function saveMaintenanceItem(
  aircraftId: string,
  itemId: string | null,
  _state: FormState,
  form: FormData,
): Promise<FormState> {
  const text = (key: string) => String(form.get(key) ?? '').trim();
  const values: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value === 'string') values[key] = value;
  }

  if (!text('name')) return { error: 'Give the item a name.', values };

  const rules = readRules(form);
  if (rules.length === 0) {
    return { error: 'Set at least one interval, or this item never comes due.', values };
  }

  const body: Record<string, unknown> = {
    name: text('name'),
    category: text('category') || 'airframe',
    grounds_aircraft: form.get('grounds_aircraft') === 'on',
    rules,
  };
  if (text('regulatory_reference')) body.regulatory_reference = text('regulatory_reference');
  if (text('description')) body.description = text('description');
  // A restriction and a grounding are different consequences (§4.5): an
  // overdue transponder check is "VFR only", not an aeroplane that cannot fly.
  if (!body.grounds_aircraft && text('restriction_label')) {
    body.restriction_label = text('restriction_label');
  }
  if (text('tolerance_hours')) body.tolerance_hours = text('tolerance_hours');

  try {
    if (itemId) {
      await apiFetch(`/maintenance-items/${itemId}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
    } else {
      await apiFetch(`/aircraft/${aircraftId}/maintenance-items`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    }
  } catch (error) {
    return { error: messageFor(error), values };
  }

  revalidatePath('/maintenance');
  revalidatePath(`/aircraft/${aircraftId}`);
  if (itemId) revalidatePath(`/maintenance/${itemId}`);
  redirect(itemId ? `/maintenance/${itemId}` : '/maintenance');
}

/**
 * What the form's footer says, before anything is saved.
 *
 * §13 requires the preview to match what saving produces, and it does by
 * construction: this endpoint and the completion trigger call the same two
 * database functions. The alternative — working the date out in the browser —
 * is a second implementation that would drift within a month.
 */
export async function previewMaintenanceRules(
  aircraftId: string,
  rules: unknown[],
  tolerance?: string,
): Promise<{ preview?: PreviewMaintenanceResponse; error?: string }> {
  if (rules.length === 0) return {};
  try {
    const preview = await apiFetch<PreviewMaintenanceResponse>('/maintenance-items/preview', {
      method: 'POST',
      body: JSON.stringify({
        aircraft_id: aircraftId,
        rules,
        ...(tolerance ? { tolerance_hours: tolerance } : {}),
      }),
    });
    return { preview };
  } catch (error) {
    return { error: messageFor(error) };
  }
}

/**
 * The rules out of a form, up to three, each prefixed by its index.
 *
 * Strings all the way: the meters are `numeric` and a float round-trip is how
 * a countdown drifts by a tenth and then by an hour.
 */
function readRules(form: FormData): Record<string, unknown>[] {
  const rules: Record<string, unknown>[] = [];
  for (let index = 0; index < 3; index += 1) {
    const kind = String(form.get(`rules.${index}.kind`) ?? '').trim();
    if (!kind) continue;

    const every = String(form.get(`rules.${index}.every`) ?? '').trim();
    const fixedDate = String(form.get(`rules.${index}.fixed_date`) ?? '').trim();
    if (kind !== 'fixed_date' && !every) continue;
    if (kind === 'fixed_date' && !fixedDate) continue;

    const anchorOn = String(form.get(`rules.${index}.anchor_on`) ?? '').trim();
    const anchorHours = String(form.get(`rules.${index}.anchor_hours`) ?? '').trim();

    rules.push({
      kind,
      ...(kind === 'fixed_date' ? { fixed_date: fixedDate } : { every }),
      end_of_month: form.get(`rules.${index}.end_of_month`) === 'on',
      ...(anchorOn ? { anchor_on: anchorOn } : {}),
      ...(anchorHours ? { anchor_hours: anchorHours } : {}),
    });
  }
  return rules;
}

/**
 * Logging a completion (§4.7, mockup 05).
 *
 * This is the path that rolls the item forward, and it is a different act from
 * `recordCompliance` above: that one records an AD or a work order against the
 * aircraft, this one says "the thing we were counting down to has been done".
 */
export async function logMaintenanceCompletion(
  itemId: string,
  _state: FormState,
  form: FormData,
): Promise<FormState> {
  const text = (key: string) => String(form.get(key) ?? '').trim();
  const values = Object.fromEntries(
    ['done_on', 'tach', 'hobbs', 'performed_by', 'cert_no', 'notes'].map((k) => [k, text(k)]),
  );

  if (!values.done_on) return { error: 'Enter the date the work was done.', values };

  const body: Record<string, unknown> = { done_on: values.done_on };
  for (const key of ['tach', 'hobbs', 'performed_by', 'cert_no', 'notes'] as const) {
    if (values[key]) body[key] = values[key];
  }
  if (text('next_from')) body.next_from = text('next_from');

  /*
    The id comes from the form so the invoice can name the completion, and the
    key makes a retry safe.

    Both are the same field: the form mints one uuid, sends it as the record's
    id and as the idempotency key, and reuses it on a retry. A second post
    after a dropped connection is then the same request rather than a second
    completion — and a mark-complete applied twice rolls an annual forward
    twice, in a table §3.6 will not let anybody correct by editing.
  */
  const id = text('completion_id');
  if (id) body.id = id;

  let completionId: string;
  try {
    const created = await apiFetch<{ id: string }>(
      `/maintenance-items/${itemId}/completions`,
      {
        method: 'POST',
        headers: { 'idempotency-key': id || crypto.randomUUID() },
        body: JSON.stringify(body),
      },
    );
    completionId = created.id;
  } catch (error) {
    return { error: messageFor(error), values };
  }

  revalidatePath('/maintenance');
  revalidatePath(`/maintenance/${itemId}`);
  return { saved: true, values: { completion_id: completionId } };
}

/**
 * Web's first upload, in the three steps the API has always wanted.
 *
 * This signs a PUT and hands it back to the browser, which sends the bytes
 * straight to object storage and then calls `finishUpload`. The bytes do not
 * pass through the Next.js server either, for the same reason they do not pass
 * through the API: a server that handles uploads needs a body limit, a parser
 * and a retry story, and object storage already has all three.
 */
export async function startUpload(
  owner:
    | { kind: 'completion'; id: string }
    | { kind: 'document'; id: string }
    | { kind: 'squawk'; id: string },
  input: { content_type: string; byte_size: number; kind?: string },
): Promise<{ id?: string; upload_url?: string; error?: string }> {
  const path =
    owner.kind === 'completion'
      ? `/maintenance-completions/${owner.id}/attachments`
      : owner.kind === 'document'
        ? `/aircraft-documents/${owner.id}/attachments`
        : '/attachments';

  try {
    const created = await apiFetch<{ id: string; upload_url?: string }>(path, {
      method: 'POST',
      body: JSON.stringify(
        owner.kind === 'squawk' ? { ...input, squawk_id: owner.id } : input,
      ),
    });
    return { id: created.id, ...(created.upload_url ? { upload_url: created.upload_url } : {}) };
  } catch (error) {
    return { error: messageFor(error) };
  }
}

/** The bytes arrived. The server reads back what storage actually holds. */
export async function finishUpload(
  owner:
    | { kind: 'completion'; id: string }
    | { kind: 'document'; id: string }
    | { kind: 'squawk'; id: string },
  attachmentId: string,
  revalidate?: string,
): Promise<ActionResult> {
  const path =
    owner.kind === 'completion'
      ? `/maintenance-completions/${owner.id}/attachments/${attachmentId}/complete`
      : owner.kind === 'document'
        ? `/aircraft-documents/${owner.id}/attachments/${attachmentId}/complete`
        : `/attachments/${attachmentId}/complete`;

  try {
    await apiFetch(path, { method: 'POST' });
  } catch (error) {
    return { error: messageFor(error) };
  }
  if (revalidate) revalidatePath(revalidate);
  return {};
}

/**
 * A wrong invoice, taken off a signed record.
 *
 * Not a delete. The row stays, keeps saying what it was filed against, and
 * records who removed it and why — and the bytes stay counted against
 * `storage.bytes`, because they are still in the bucket. The screens say so;
 * "freed 2.4 MB" would be an unsupported claim (§11).
 */
export async function removeCompletionAttachment(
  recordId: string,
  attachmentId: string,
  reason: string,
  revalidate: string,
): Promise<ActionResult> {
  if (reason.trim().length < 5) {
    return { error: 'Say why in a few words. This stays on the record.' };
  }
  try {
    await apiFetch(
      `/maintenance-completions/${recordId}/attachments/${attachmentId}/remove`,
      { method: 'POST', body: JSON.stringify({ reason: reason.trim() }) },
    );
  } catch (error) {
    return { error: messageFor(error) };
  }
  revalidatePath(revalidate);
  return {};
}

// ---- aircraft documents (§3.2) --------------------------------------------

/**
 * The document, written before its file.
 *
 * That order is what the foreign key enforces — the owner exists and the upload
 * names it — and it means a club can record that the insurance expires on 31
 * March before anybody has scanned the certificate.
 */
export async function createAircraftDocument(
  aircraftId: string,
  _state: FormState,
  form: FormData,
): Promise<FormState> {
  const text = (key: string) => String(form.get(key) ?? '').trim();
  const values: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value === 'string') values[key] = value;
  }

  if (!text('kind')) return { error: 'Say which document it is.', values };
  if (!text('title')) return { error: 'Give it a title.', values };

  const body: Record<string, unknown> = { kind: text('kind'), title: text('title') };
  for (const key of ['reference', 'issued_on', 'expires_on', 'notes', 'supersedes_id'] as const) {
    if (text(key)) body[key] = text(key);
  }

  let documentId: string;
  try {
    const created = await apiFetch<{ id: string }>(`/aircraft/${aircraftId}/documents`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    documentId = created.id;
  } catch (error) {
    return { error: messageFor(error), values };
  }

  revalidatePath(`/aircraft/${aircraftId}/documents`);
  // Handed back so the form can upload the file against it without a reload.
  return { saved: true, values: { document_id: documentId } };
}

export async function updateAircraftDocument(
  documentId: string,
  aircraftId: string,
  input: Record<string, unknown>,
): Promise<ActionResult> {
  try {
    await apiFetch(`/aircraft-documents/${documentId}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
  } catch (error) {
    return { error: messageFor(error) };
  }
  revalidatePath(`/aircraft/${aircraftId}/documents`);
  return {};
}

/**
 * Taking a completion back (§4.7).
 *
 * Not a delete and not an edit. `compliance_records` is the table read back
 * after an accident (§7.2), so the record stays and the void is its own fact,
 * with a reason and an actor — which is why the reason is required here rather
 * than optional.
 */
export async function voidMaintenanceCompletion(
  itemId: string,
  recordId: string,
  reason: string,
): Promise<ActionResult> {
  if (reason.trim().length < 5) {
    return { error: 'Say why in a few words. This stays on the record.' };
  }
  try {
    await apiFetch(`/maintenance-completions/${recordId}/void`, {
      method: 'POST',
      body: JSON.stringify({ reason: reason.trim() }),
    });
  } catch (error) {
    return { error: messageFor(error) };
  }

  revalidatePath('/maintenance');
  revalidatePath(`/maintenance/${itemId}`);
  return {};
}

/** Archiving an item, or bringing it back. §5.5: never a delete. */
export async function setMaintenanceItemStatus(
  itemId: string,
  status: 'active' | 'archived',
): Promise<ActionResult> {
  try {
    await apiFetch(`/maintenance-items/${itemId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    });
  } catch (error) {
    return { error: messageFor(error) };
  }

  revalidatePath('/maintenance');
  revalidatePath(`/maintenance/${itemId}`);
  return {};
}

/**
 * §4.5's override: fly it anyway, for a reason and until a time.
 *
 * Never a switch. An override with no expiry is a grounding turned off, so the
 * expiry is required and the server bounds it — the aeroplane comes back to the
 * honest answer by itself rather than when somebody remembers.
 */
export async function overrideGrounding(
  aircraftId: string,
  _state: FormState,
  form: FormData,
): Promise<FormState> {
  const reason = String(form.get('reason') ?? '').trim();
  const until = String(form.get('until') ?? '').trim();
  const values = { reason, until };

  if (reason.length < 5) return { error: 'Say why, in a sentence.', values };
  if (!until) return { error: 'Say when the override ends.', values };

  try {
    await apiFetch(`/aircraft/${aircraftId}/grounding/override`, {
      method: 'POST',
      body: JSON.stringify({
        reason,
        // A local datetime from the browser, as an instant.
        until: new Date(until).toISOString(),
        ...(form.get('maintenance_item_id')
          ? { maintenance_item_id: String(form.get('maintenance_item_id')) }
          : {}),
      }),
    });
  } catch (error) {
    return { error: messageFor(error), values };
  }

  revalidatePath('/maintenance');
  revalidatePath('/schedule');
  revalidatePath(`/aircraft/${aircraftId}`);
  return { saved: true };
}

/**
 * §4.6: would this block take the aeroplane past something?
 *
 * Warn only, and a failure is no warning rather than a blocked form — the
 * booking is refused by the exclusion constraint and by availability, never by
 * this.
 */
export async function checkBookingAgainstMaintenance(
  aircraftId: string,
  hours: string,
): Promise<{ crosses?: BookingMaintenanceCheckResponse['crosses'] }> {
  try {
    const result = await apiFetch<BookingMaintenanceCheckResponse>(
      `/aircraft/${aircraftId}/bookings/check?hours=${encodeURIComponent(hours)}`,
    );
    return { crosses: result.crosses };
  } catch {
    return {};
  }
}

/** The feed (§3.8). Opening a notice is seeing it, so this is not a gesture. */
export async function markNotificationRead(id: string): Promise<ActionResult> {
  try {
    await apiFetch(`/notifications/${id}/read`, { method: 'POST' });
  } catch (error) {
    return { error: messageFor(error) };
  }
  revalidatePath('/notifications');
  return {};
}

export async function markAllNotificationsRead(): Promise<ActionResult> {
  try {
    await apiFetch('/notifications/read-all', { method: 'POST' });
  } catch (error) {
    return { error: messageFor(error) };
  }
  revalidatePath('/notifications');
  return {};
}

/**
 * Filing a squawk. `squawks: write`, which every pilot holds — §1.5 keeps
 * this separate from `maintenance` precisely so that reporting a defect and
 * signing off the work are different permissions.
 */
export async function fileSquawk(_state: FormState, form: FormData): Promise<FormState> {
  const text = (key: string) => String(form.get(key) ?? '').trim();
  const values = {
    aircraft_id: text('aircraft_id'),
    summary: text('summary'),
    details: text('details'),
    severity: text('severity'),
  };

  if (!values.summary) return { error: 'Describe the defect in a few words.', values };

  const body: Record<string, unknown> = {
    aircraft_id: values.aircraft_id,
    summary: values.summary,
    severity: values.severity || 'minor',
    // Severity 'grounding' always grounds; the checkbox is for the case where
    // it is worse than the reporter first thought.
    grounding: values.severity === 'grounding' || form.get('grounding') === 'on',
  };
  if (values.details) body.details = values.details;

  try {
    await apiFetch('/squawks', {
      method: 'POST',
      // §8.2: filed at the tiedown, on one bar of signal, and retried. The
      // form instance carries its own key so a retry cannot file it twice.
      headers: { 'idempotency-key': text('idempotency_key') },
      body: JSON.stringify(body),
    });
  } catch (error) {
    return { error: messageFor(error), values };
  }

  revalidatePath('/squawks');
  revalidatePath('/maintenance');
  revalidatePath('/aircraft');
  revalidatePath(`/aircraft/${String(body.aircraft_id)}`);
  return { saved: true };
}

/**
 * Closing one, or deciding it may be flown with.
 *
 * Both need `maintenance: write`, which a Pilot does not hold. The buttons
 * are hidden for them, and the API refuses it anyway — hiding a button is
 * cosmetics (§8.1).
 */
export async function resolveSquawk(id: string, note: string): Promise<ActionResult> {
  return patchSquawk(id, {
    status: 'resolved',
    ...(note ? { resolution_note: note } : {}),
  });
}

export async function reopenSquawk(id: string): Promise<ActionResult> {
  return patchSquawk(id, { status: 'open' });
}

async function patchSquawk(id: string, body: Record<string, unknown>): Promise<ActionResult> {
  try {
    await apiFetch(`/squawks/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
  } catch (error) {
    // A Pilot reaches these only through the API — the buttons are hidden —
    // but §8.1 says hiding a button is cosmetics, so the refusal has to read
    // as a sentence either way.
    return { error: messageFor(error) };
  }

  revalidatePath('/squawks');
  revalidatePath('/maintenance');
  revalidatePath('/aircraft');
  return {};
}

/**
 * Deferring: the decision that the aircraft may fly with a known defect,
 * which is what an MEL and 14 CFR 91.213 are for. Append-only — lifting it
 * later leaves this record exactly where it is.
 */
export async function deferSquawk(
  id: string,
  _state: FormState,
  form: FormData,
): Promise<FormState> {
  const text = (key: string) => String(form.get(key) ?? '').trim();
  const body: Record<string, unknown> = { basis: text('basis') || 'far_91_213' };
  if (text('reference')) body.reference = text('reference');
  if (text('expires_on')) body.expires_on = text('expires_on');
  if (text('note')) body.note = text('note');

  try {
    await apiFetch(`/squawks/${id}/deferrals`, { method: 'POST', body: JSON.stringify(body) });
  } catch (error) {
    return { error: messageFor(error) };
  }

  revalidatePath('/squawks');
  revalidatePath('/maintenance');
  return {};
}

/**
 * Identity (M1).
 *
 * The three public flows — sign up, reset, accept an invitation — all end by
 * writing a session, because the alternative is telling somebody who just
 * proved who they are to go and prove it again.
 */

/** Sign up: a tenant and its first Admin, in one flow. Free tier (§4.3). */
export async function signup(_state: FormState, form: FormData): Promise<FormState> {
  const text = (key: string) => String(form.get(key) ?? '').trim();
  const values = {
    name: text('name'),
    slug: text('slug'),
    email: text('email'),
    archetype: text('archetype'),
  };

  const password = String(form.get('password') ?? '');
  if (password.length < 12) {
    return { error: 'Use a password of at least 12 characters.', values };
  }

  // The slug is in URLs and in invite links, and it is not editable
  // afterwards — so it is derived from the club's name rather than being a
  // field somebody has to think about.
  const slug =
    values.slug ||
    values.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 63);

  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug)) {
    return { error: 'Use a club name with a few letters or numbers in it.', values };
  }

  try {
    await apiFetch('/auth/signup', {
      method: 'POST',
      token: '',
      body: JSON.stringify({
        slug,
        name: values.name,
        email: values.email,
        password,
        archetype: values.archetype || 'solo',
      }),
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) {
      // The API answers a taken slug and a registered address identically on
      // purpose, so this cannot say which either.
      return {
        error: 'That club name or email is already taken. Try another, or sign in.',
        values,
      };
    }
    return { error: messageFor(error), values };
  }

  // Straight in. They just chose the password; asking for it again would be
  // theatre.
  return login({}, formDataFor({ email: values.email, password }));
}

/** Build the form `login` expects, so signing in after signup reuses it. */
function formDataFor(fields: Record<string, string>): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return form;
}

export async function requestPasswordReset(
  _state: FormState,
  form: FormData,
): Promise<FormState> {
  const email = String(form.get('email') ?? '').trim();
  try {
    await apiFetch('/auth/password-reset/request', {
      method: 'POST',
      token: '',
      body: JSON.stringify({ email }),
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 429) {
      return { error: 'Too many attempts. Wait a few minutes and try again.' };
    }
    return { error: messageFor(error) };
  }
  // Said the same way whatever the address: the API does not tell us whether
  // an account exists, and this screen must not appear to know either.
  return { saved: true };
}

export async function resetPassword(
  token: string,
  _state: FormState,
  form: FormData,
): Promise<FormState> {
  const password = String(form.get('password') ?? '');
  if (password.length < 12) {
    return { error: 'Use a password of at least 12 characters.' };
  }

  try {
    await apiFetch('/auth/password-reset', {
      method: 'POST',
      token: '',
      body: JSON.stringify({ token, password }),
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return {
        error: 'That link has already been used, or it has expired. Ask for a new one.',
      };
    }
    return { error: messageFor(error) };
  }

  redirect('/login?reset=1');
}

export async function verifyEmail(token: string): Promise<FormState> {
  try {
    await apiFetch('/auth/verify-email', {
      method: 'POST',
      token: '',
      body: JSON.stringify({ token }),
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return { error: 'That link has already been used, or it has expired.' };
    }
    return { error: messageFor(error) };
  }
  return { saved: true };
}

export async function resendVerification(): Promise<ActionResult> {
  const session = await readSession();
  if (!session) return { error: 'Sign in first.' };
  try {
    const me = await apiFetch<{ email: string }>('/me');
    await apiFetch('/auth/verify-email/request', {
      method: 'POST',
      token: '',
      body: JSON.stringify({ email: me.email }),
    });
  } catch (error) {
    return { error: messageFor(error) };
  }
  return {};
}

/**
 * Accepting an invitation.
 *
 * Two shapes, and the API decides which: somebody with an account has to be
 * signed in as themselves, and somebody new sends a password. When they send
 * one they are signed in afterwards with it.
 */
export async function acceptInvite(
  token: string,
  _state: FormState,
  form: FormData,
): Promise<FormState> {
  const text = (key: string) => String(form.get(key) ?? '').trim();
  const password = String(form.get('password') ?? '');
  const values = { name: text('name') };

  if (password && password.length < 12) {
    return { error: 'Use a password of at least 12 characters.', values };
  }

  let accepted: { email: string; tenant_id: string };
  try {
    accepted = await apiFetch(`/invites/token/${encodeURIComponent(token)}/accept`, {
      method: 'POST',
      body: JSON.stringify({
        ...(password ? { password } : {}),
        ...(values.name ? { name: values.name } : {}),
      }),
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return { error: 'That invitation has been used already, or it has expired.', values };
    }
    return { error: messageFor(error), values };
  }

  if (password) {
    return login({}, formDataFor({ email: accepted.email, password }));
  }

  // Already signed in: switch the session to the club they just joined, so
  // the next page is the one they were invited to rather than whichever they
  // happened to be in.
  await selectTenant(accepted.tenant_id);
  redirect('/aircraft');
}

// ---------------------------------------------------------------------------
// The roster
// ---------------------------------------------------------------------------

export async function inviteMember(_state: FormState, form: FormData): Promise<FormState> {
  const values = {
    email: String(form.get('email') ?? '').trim(),
    name: String(form.get('name') ?? '').trim(),
    role: String(form.get('role') ?? 'pilot'),
  };

  try {
    await apiFetch('/invites', {
      method: 'POST',
      body: JSON.stringify({
        email: values.email,
        ...(values.name ? { name: values.name } : {}),
        role: values.role,
      }),
    });
  } catch (error) {
    return { error: messageFor(error), values };
  }

  revalidatePath('/members');
  return { saved: true };
}

export async function revokeInvite(id: string): Promise<ActionResult> {
  try {
    await apiFetch(`/invites/${id}/revoke`, { method: 'POST' });
  } catch (error) {
    return { error: messageFor(error) };
  }
  revalidatePath('/members');
  return {};
}

export async function updateMember(
  id: string,
  changes: { role?: string; status?: string },
): Promise<ActionResult> {
  try {
    await apiFetch(`/members/${id}`, { method: 'PATCH', body: JSON.stringify(changes) });
  } catch (error) {
    // §4.4's refusal arrives as a conflict with a sentence in it.
    return { error: messageFor(error) };
  }
  revalidatePath('/members');
  return {};
}

// ---------------------------------------------------------------------------
// Settings and profile
// ---------------------------------------------------------------------------

export async function updateTenant(_state: FormState, form: FormData): Promise<FormState> {
  const values = {
    name: String(form.get('name') ?? '').trim(),
    timezone: String(form.get('timezone') ?? '').trim(),
  };

  try {
    await apiFetch('/tenant', {
      method: 'PATCH',
      body: JSON.stringify({ name: values.name, timezone: values.timezone }),
    });
  } catch (error) {
    return { error: messageFor(error), values };
  }

  revalidatePath('/settings');
  revalidatePath('/', 'layout');
  return { saved: true };
}

export async function updateProfile(_state: FormState, form: FormData): Promise<FormState> {
  const values = {
    name: String(form.get('name') ?? '').trim(),
    phone: String(form.get('phone') ?? '').trim(),
  };

  try {
    await apiFetch('/auth/me', {
      method: 'PATCH',
      body: JSON.stringify({ name: values.name || null, phone: values.phone || null }),
    });
  } catch (error) {
    return { error: messageFor(error), values };
  }

  revalidatePath('/settings');
  return { saved: true };
}

// ---------------------------------------------------------------------------
// Scheduling (§3.3)
//
// Every time here is a wall clock at the club's field, converted once on the
// way in and formatted on the way out. The API takes and returns instants;
// nobody books "1600 Zulu".
// ---------------------------------------------------------------------------

/** The club's zone, for converting what somebody typed. */
async function tenantZone(): Promise<string> {
  const tenant = await apiFetch<{ timezone: string }>('/tenant');
  return tenant.timezone || 'UTC';
}

export async function bookAircraft(_state: FormState, form: FormData): Promise<FormState> {
  const text = (key: string) => String(form.get(key) ?? '').trim();
  const values = {
    aircraft_id: text('aircraft_id'),
    date: text('date'),
    starts: text('starts'),
    ends: text('ends'),
    purpose: text('purpose'),
    notes: text('notes'),
  };

  if (!values.date || !values.starts || !values.ends) {
    return { error: 'Pick a date and the hours you want.', values };
  }
  if (values.ends <= values.starts) {
    return { error: 'The end has to be after the start.', values };
  }

  const zone = await tenantZone();
  try {
    await apiFetch('/reservations', {
      method: 'POST',
      body: JSON.stringify({
        aircraft_id: values.aircraft_id,
        starts_at: zonedToInstant(values.date, values.starts, zone).toISOString(),
        ends_at: zonedToInstant(values.date, values.ends, zone).toISOString(),
        ...(values.purpose ? { purpose: values.purpose } : {}),
        ...(values.notes ? { notes: values.notes } : {}),
      }),
    });
  } catch (error) {
    // The three refusals worth reading are all conflicts, and the API
    // already wrote the sentence: the slot is taken, the aeroplane is
    // grounded, or this member is not signed off in it.
    return { error: messageFor(error), values };
  }

  revalidatePath('/schedule');
  return { saved: true };
}

export async function cancelReservation(id: string): Promise<ActionResult> {
  try {
    await apiFetch(`/reservations/${id}/cancel`, { method: 'POST' });
  } catch (error) {
    return { error: messageFor(error) };
  }
  revalidatePath('/schedule');
  return {};
}

/** Clearing the flag is the admin saying they have spoken to the member. */
export async function clearReservationFlag(id: string): Promise<ActionResult> {
  try {
    await apiFetch(`/reservations/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ needs_review: false }),
    });
  } catch (error) {
    return { error: messageFor(error) };
  }
  revalidatePath('/schedule');
  return {};
}

export async function createBlackout(_state: FormState, form: FormData): Promise<FormState> {
  const text = (key: string) => String(form.get(key) ?? '').trim();
  const values = {
    aircraft_id: text('aircraft_id'),
    reason: text('reason'),
    from_date: text('from_date'),
    from_time: text('from_time') || '00:00',
    to_date: text('to_date'),
    to_time: text('to_time') || '00:00',
  };

  if (!values.reason || !values.from_date || !values.to_date) {
    return { error: 'Say what it is for, and when it starts and ends.', values };
  }

  const zone = await tenantZone();
  const startsAt = zonedToInstant(values.from_date, values.from_time, zone);
  const endsAt = zonedToInstant(values.to_date, values.to_time, zone);
  if (endsAt <= startsAt) {
    return { error: 'The end has to be after the start.', values };
  }

  try {
    await apiFetch('/blackouts', {
      method: 'POST',
      body: JSON.stringify({
        aircraft_id: values.aircraft_id,
        reason: values.reason,
        starts_at: startsAt.toISOString(),
        ends_at: endsAt.toISOString(),
      }),
    });
  } catch (error) {
    // The interesting failure is somebody already having those hours, and
    // the API's answer says to call them rather than cancelling for you.
    return { error: messageFor(error), values };
  }

  revalidatePath('/schedule');
  return { saved: true };
}

export async function removeBlackout(id: string): Promise<ActionResult> {
  try {
    await apiFetch(`/blackouts/${id}`, { method: 'DELETE' });
  } catch (error) {
    return { error: messageFor(error) };
  }
  revalidatePath('/schedule');
  return {};
}

/** §3.5: the club checkout — "is Dave signed off in the 182?" */
export async function authorizeMember(
  aircraftId: string,
  membershipId: string,
  note: string,
): Promise<ActionResult> {
  try {
    await apiFetch(`/aircraft/${aircraftId}/authorizations`, {
      method: 'POST',
      body: JSON.stringify({ membership_id: membershipId, ...(note ? { note } : {}) }),
    });
  } catch (error) {
    return { error: messageFor(error) };
  }
  revalidatePath(`/aircraft/${aircraftId}`);
  return {};
}

export async function withdrawAuthorization(
  aircraftId: string,
  membershipId: string,
): Promise<ActionResult> {
  try {
    await apiFetch(`/aircraft/${aircraftId}/authorizations/${membershipId}`, {
      method: 'DELETE',
    });
  } catch (error) {
    return { error: messageFor(error) };
  }
  revalidatePath(`/aircraft/${aircraftId}`);
  return {};
}

// ---------------------------------------------------------------------------
// Member billing (§3.7)
//
// Two writes and a rate, which is the whole of what an admin can add to a
// ledger. Charges are generated when a flight is logged; nothing here makes
// one, and nothing anywhere edits one.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Platform billing (§3.7's left-hand column) — what the club pays us.
//
// Both of these end in `redirect()` to somewhere that is not this site, which
// Next's redirect handles: it throws, so nothing after it runs, and the
// browser is sent on with a 303. Neither action ever sees a card number.
// ---------------------------------------------------------------------------

export async function startCheckout(planCode: string): Promise<ActionResult> {
  let url: string;
  try {
    const response = await apiFetch<BillingRedirectResponse>('/subscription/checkout', {
      method: 'POST',
      body: JSON.stringify({ plan_code: planCode } satisfies CheckoutRequest),
    });
    url = response.url;
  } catch (error) {
    return { error: messageFor(error) };
  }

  redirect(url);
}

/**
 * Card, invoices, switching plan and cancelling, all at the provider.
 *
 * §5.1 wants a downgrade to take effect at the end of the paid period, and
 * the provider's own "cancel at period end" is exactly that — so there is no
 * second plan-change UI here to disagree with it.
 */
export async function openBillingPortal(): Promise<ActionResult> {
  let url: string;
  try {
    const response = await apiFetch<BillingRedirectResponse>('/subscription/portal', {
      method: 'POST',
    });
    url = response.url;
  } catch (error) {
    return { error: messageFor(error) };
  }

  redirect(url);
}

export async function setRate(_state: FormState, form: FormData): Promise<FormState> {
  const text = (key: string) => String(form.get(key) ?? '').trim();
  const values = {
    aircraft_id: text('aircraft_id'),
    membership_id: text('membership_id'),
    amount: text('amount'),
    effective_from: text('effective_from'),
  };

  const amountCents = parseMoney(values.amount);
  if (amountCents === null || amountCents < 0) {
    return { error: 'Enter the rate as an amount, for example 165.00.', values };
  }

  try {
    await apiFetch('/rates', {
      method: 'POST',
      body: JSON.stringify({
        aircraft_id: values.aircraft_id,
        amount_cents: amountCents,
        ...(values.membership_id ? { membership_id: values.membership_id } : {}),
        ...(values.effective_from ? { effective_from: values.effective_from } : {}),
      }),
    });
  } catch (error) {
    return { error: messageFor(error), values };
  }

  revalidatePath('/billing');
  revalidatePath('/aircraft');
  return { saved: true };
}

/**
 * V1_SCOPE M6: "Recording an offline payment ('Dave paid $400 by check') is a
 * manual adjustment in v1. That works, and it is the smallest thing that
 * makes the ledger balance."
 */
export async function recordAdjustment(_state: FormState, form: FormData): Promise<FormState> {
  const text = (key: string) => String(form.get(key) ?? '').trim();
  const values = {
    membership_id: text('membership_id'),
    kind: text('kind'),
    amount: text('amount'),
    reason: text('reason'),
  };

  const magnitude = parseMoney(values.amount);
  if (magnitude === null || magnitude <= 0) {
    return { error: 'Enter an amount, for example 400.00.', values };
  }
  if (!values.reason) {
    return { error: 'Say what this is for — a ledger line nobody can explain is an argument later.', values };
  }

  // The sign is a choice the form makes in words, never a minus somebody has
  // to remember to type: a payment reduces what they owe, a charge adds to
  // it, and getting that backwards is a mistake with money in it.
  const amountCents = values.kind === 'charge' ? magnitude : -magnitude;

  try {
    await apiFetch('/adjustments', {
      method: 'POST',
      body: JSON.stringify({
        membership_id: values.membership_id,
        amount_cents: amountCents,
        reason: values.reason,
      }),
    });
  } catch (error) {
    return { error: messageFor(error), values };
  }

  revalidatePath('/billing');
  return { saved: true };
}

/** §3.7 rule 2: a correction is a reversing entry, never an edit. */
export async function reverseCharge(id: string, reason: string): Promise<ActionResult> {
  if (!reason.trim()) return { error: 'Say why it is being reversed.' };
  try {
    await apiFetch(`/charges/${id}/reverse`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
  } catch (error) {
    return { error: messageFor(error) };
  }
  revalidatePath('/billing');
  return {};
}
