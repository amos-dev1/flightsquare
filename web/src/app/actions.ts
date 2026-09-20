'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';

import { ApiError, apiFetch, messageFor } from '@/lib/api';
import { clearSession, readSession, writeSession } from '@/lib/session';
import type {
  AircraftResponse,
  LoginResponse,
  SelectTenantResponse,
} from '@flightsquare/shared';

export interface FormState {
  error?: string;
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

  const only = result.memberships.length === 1 ? result.memberships[0] : undefined;
  if (only) {
    await selectTenant(only.tenant_id);
  }

  redirect(only ? '/aircraft' : '/choose-tenant');
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
  const body: Record<string, unknown> = {
    registration: String(form.get('registration') ?? '').toUpperCase().trim(),
  };
  for (const key of ['type_code', 'home_base', 'serial_number'] as const) {
    const value = String(form.get(key) ?? '').trim();
    if (value) body[key] = key === 'home_base' ? value.toUpperCase() : value;
  }
  const year = String(form.get('year_manufactured') ?? '').trim();
  if (year) body.year_manufactured = Number(year);
  const seats = String(form.get('seats') ?? '').trim();
  if (seats) body.seats = Number(seats);
  const meter = String(form.get('maintenance_meter') ?? '').trim();
  if (meter) body.maintenance_meter = meter;

  let created: AircraftResponse;
  try {
    created = await apiFetch<AircraftResponse>('/aircraft', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  } catch (error) {
    return { error: messageFor(error) };
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
  const body: Record<string, unknown> = {};
  for (const key of ['hobbs', 'tach', 'airframe_hours'] as const) {
    const value = String(form.get(key) ?? '').trim();
    if (value) body[key] = value;
  }
  const note = String(form.get('note') ?? '').trim();
  if (note) body.note = note;

  if (Object.keys(body).length === 0 || (!body.hobbs && !body.tach && !body.airframe_hours)) {
    return { error: 'Enter at least one meter reading.' };
  }

  try {
    await apiFetch(`/aircraft/${aircraftId}/meter-readings`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  } catch (error) {
    return { error: messageFor(error) };
  }

  revalidatePath(`/aircraft/${aircraftId}`);
  return {};
}

export async function setAircraftStatus(aircraftId: string, status: string): Promise<void> {
  // §5.5: archiving is reversible and non-destructive. The history stays, and
  // the quota slot comes back.
  await apiFetch(`/aircraft/${aircraftId}`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });
  revalidatePath('/aircraft');
  revalidatePath(`/aircraft/${aircraftId}`);
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
