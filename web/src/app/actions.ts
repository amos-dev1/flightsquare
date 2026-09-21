'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';

import { ApiError, apiFetch, messageFor } from '@/lib/api';
import { clearSession, readSession, writeSession } from '@/lib/session';
import { parseMoney } from '@/lib/money';
import { zonedToInstant } from '@/lib/time';
import type {
  AircraftResponse,
  LoginResponse,
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
      body: JSON.stringify({ email, password }),
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

  await writeSession({
    accessToken: result.access_token,
    refreshToken: result.refresh_token,
    expiresAt: result.expires_at,
  });

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
     'fuel_remaining_after', 'fuel_added_qty', 'fuel_added_cost',
     'departed_from', 'arrived_at', 'remarks'].map((k) => [k, text(k)]),
  );

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

  const key = text('idempotency_key');
  try {
    await apiFetch('/flights', {
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

  revalidatePath(`/aircraft/${aircraftId}`);
  revalidatePath('/aircraft');
  redirect(`/aircraft/${aircraftId}?logged=1`);
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
