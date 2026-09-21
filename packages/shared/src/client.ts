import type {
  AerodromeResponse,
  AircraftResponse,
  AircraftTypeResponse,
  CreateAircraftRequest,
  CreateFlightRequest,
  CreateMeterReadingRequest,
  EntitlementsResponse,
  FlightResponse,
  LoginResponse,
  MeResponse,
  MembershipSummaryResponse,
  MeterReadingResponse,
  RefreshResponse,
  SelectTenantResponse,
  TenantResponse,
} from './index.js';

/**
 * The API client both clients use (§9).
 *
 * Transport-agnostic on purpose: the web app holds its tokens in an httpOnly
 * cookie only its server can read, and the phone holds them in the device
 * keychain. Neither arrangement belongs in here, so the caller supplies a
 * token getter and, if it needs to, its own fetch.
 *
 * §8.1: the API is additive-only once a build ships, so this file is the
 * place that notices if a field is ever removed or a rule tightened — an old
 * binary is an anonymous HTTP client that happens to have our logo, and it
 * cannot be made to update.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`API responded ${status}`);
    this.name = 'ApiError';
  }
}

export interface ClientOptions {
  baseUrl: string;
  /** Returns the current access token, or null when signed out. */
  getToken?: () => string | null | Promise<string | null>;
  fetch?: typeof globalThis.fetch;
  /** §8.1's handshake: which client this is, and which build. */
  client?: string;
  clientVersion?: string;
}

export interface RequestOptions {
  /** §8.2: every write carries one. */
  idempotencyKey?: string;
  /** Skips the token, for the calls made before there is one. */
  anonymous?: boolean;
}

export function createClient(options: ClientOptions) {
  const doFetch = options.fetch ?? globalThis.fetch;
  const base = options.baseUrl.replace(/\/$/, '');

  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
    extra: RequestOptions = {},
  ): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (options.client) headers['x-flightsquare-client'] = options.client;
    if (options.clientVersion) headers['x-flightsquare-client-version'] = options.clientVersion;
    if (extra.idempotencyKey) headers['idempotency-key'] = extra.idempotencyKey;

    if (!extra.anonymous && options.getToken) {
      const token = await options.getToken();
      if (token) headers.authorization = `Bearer ${token}`;
    }

    const response = await doFetch(`${base}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    if (!response.ok) {
      const failure: unknown = await response.json().catch(() => null);
      throw new ApiError(response.status, failure);
    }
    if (response.status === 204) return undefined as T;

    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  return {
    request,

    // ---- pre-session ----------------------------------------------------
    login: (email: string, password: string) =>
      request<LoginResponse>('POST', '/auth/login', { email, password }, { anonymous: true }),
    refresh: (refreshToken: string) =>
      request<RefreshResponse>(
        'POST',
        '/auth/refresh',
        { refresh_token: refreshToken },
        { anonymous: true },
      ),
    logout: () => request<void>('POST', '/auth/logout'),
    selectTenant: (tenantId: string) =>
      request<SelectTenantResponse>('POST', '/auth/tenant', { tenant_id: tenantId }),

    // ---- session --------------------------------------------------------
    me: () => request<MeResponse>('GET', '/me'),
    memberships: () => request<MembershipSummaryResponse[]>('GET', '/me/memberships'),
    tenant: () => request<TenantResponse>('GET', '/tenant'),
    entitlements: () => request<EntitlementsResponse>('GET', '/entitlements'),

    // ---- fleet ----------------------------------------------------------
    listAircraft: () => request<AircraftResponse[]>('GET', '/aircraft'),
    getAircraft: (id: string) => request<AircraftResponse>('GET', `/aircraft/${id}`),
    createAircraft: (input: CreateAircraftRequest) =>
      request<AircraftResponse>('POST', '/aircraft', input),
    listMeterReadings: (aircraftId: string) =>
      request<MeterReadingResponse[]>('GET', `/aircraft/${aircraftId}/meter-readings`),
    createMeterReading: (aircraftId: string, input: CreateMeterReadingRequest) =>
      request<{ id: string }>('POST', `/aircraft/${aircraftId}/meter-readings`, input),

    // ---- flights --------------------------------------------------------
    listFlights: (query: { aircraftId?: string } = {}) =>
      request<FlightResponse[]>(
        'GET',
        query.aircraftId ? `/flights?aircraft_id=${query.aircraftId}` : '/flights',
      ),
    /** §8.2: the idempotency key is required, not optional, on this one. */
    createFlight: (input: CreateFlightRequest, idempotencyKey: string) =>
      request<FlightResponse>('POST', '/flights', input, { idempotencyKey }),

    // ---- reference ------------------------------------------------------
    aircraftTypes: (q?: string) =>
      request<AircraftTypeResponse[]>(
        'GET',
        q ? `/reference/aircraft-types?q=${encodeURIComponent(q)}` : '/reference/aircraft-types',
      ),
    aerodromes: (q?: string) =>
      request<AerodromeResponse[]>(
        'GET',
        q ? `/reference/aerodromes?q=${encodeURIComponent(q)}` : '/reference/aerodromes',
      ),
  };
}

export type FlightSquareClient = ReturnType<typeof createClient>;
