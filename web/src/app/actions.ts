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
