import type {
  AerodromeResponse,
  AircraftAvailabilityResponse,
  AircraftResponse,
  AircraftTypeResponse,
  BlackoutResponse,
  CreateAircraftRequest,
  CreateComplianceRecordRequest,
  CreateFlightRequest,
  CreateMeterReadingRequest,
  CreateReservationRequest,
  CreateSquawkRequest,
  EntitlementsResponse,
  FlightResponse,
  LoginResponse,
  MaintenanceItemResponse,
  MeResponse,
  MembershipSummaryResponse,
  MeterReadingResponse,
  RefreshResponse,
  ReservationResponse,
  SelectTenantResponse,
  SquawkResponse,
  StatementResponse,
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
    /**
     * `mine` is a filter, not a permission. A club's flights are shared by
     * design (§4.4 gives `flights` scope `all` to everyone), because who
     * flew what is how a club reconciles its meters and its money — but what
     * a pilot usually wants to look at is their own.
     */
    listFlights: (query: { aircraftId?: string; needsReview?: boolean; mine?: boolean } = {}) => {
      const params = new URLSearchParams();
      if (query.aircraftId) params.set('aircraft_id', query.aircraftId);
      if (query.needsReview) params.set('needs_review', 'true');
      if (query.mine) params.set('mine', 'true');
      const search = params.toString();
      return request<FlightResponse[]>('GET', search ? `/flights?${search}` : '/flights');
    },
    /** §8.2: the idempotency key is required, not optional, on this one. */
    createFlight: (input: CreateFlightRequest, idempotencyKey: string) =>
      request<FlightResponse>('POST', '/flights', input, { idempotencyKey }),

    // ---- maintenance (§3.6) ---------------------------------------------
    /**
     * §3.3: the one place that decides whether an aircraft may be booked.
     * Both clients ask this rather than working it out from squawks, so the
     * rule exists once and cannot drift between them.
     */
    availability: () => request<AircraftAvailabilityResponse[]>('GET', '/availability'),
    aircraftAvailability: (aircraftId: string) =>
      request<AircraftAvailabilityResponse>('GET', `/aircraft/${aircraftId}/availability`),

    listMaintenanceItems: (query: { aircraftId?: string } = {}) =>
      request<MaintenanceItemResponse[]>(
        'GET',
        query.aircraftId ? `/maintenance?aircraft_id=${query.aircraftId}` : '/maintenance',
      ),
    /** Append-only. There is no update and no delete, here or in the API. */
    recordCompliance: (input: CreateComplianceRecordRequest) =>
      request<{ id: string; maintenance_item: MaintenanceItemResponse | null }>(
        'POST',
        '/compliance-records',
        input,
      ),

    // ---- squawks --------------------------------------------------------
    listSquawks: (query: { aircraftId?: string; open?: boolean } = {}) => {
      const params = new URLSearchParams();
      if (query.aircraftId) params.set('aircraft_id', query.aircraftId);
      if (query.open) params.set('open', 'true');
      const search = params.toString();
      return request<SquawkResponse[]>('GET', search ? `/squawks?${search}` : '/squawks');
    },
    /**
     * §8.2: the idempotency key is required, not optional. A squawk is filed
     * in the same conditions as a post-flight entry, and filing the same
     * defect twice is how a squawk log stops being readable.
     */
    createSquawk: (input: CreateSquawkRequest, idempotencyKey: string) =>
      request<SquawkResponse>('POST', '/squawks', input, { idempotencyKey }),

    // ---- scheduling (§3.3) ----------------------------------------------
    /**
     * The whole club's calendar, not just this pilot's.
     *
     * §4.4 gives a Pilot `reservations: write` with scope `own`, and the
     * policies behind it scope the *writing* — `reservation_own_insert` and
     * `reservation_own_update` — while SELECT stays tenant-wide. That is the
     * point of a shared aeroplane: you cannot book around other people
     * without seeing them. `mine` narrows it for the "my bookings" view.
     */
    listReservations: (
      query: { from?: string; to?: string; aircraftId?: string; mine?: boolean } = {},
    ) => {
      const params = new URLSearchParams();
      if (query.from) params.set('from', query.from);
      if (query.to) params.set('to', query.to);
      if (query.aircraftId) params.set('aircraft_id', query.aircraftId);
      if (query.mine) params.set('mine', 'true');
      const search = params.toString();
      return request<ReservationResponse[]>(
        'GET',
        search ? `/reservations?${search}` : '/reservations',
      );
    },
    /**
     * No idempotency key, unlike a flight or a squawk — and deliberately not
     * queued offline either. §8.2 queues the writes that must not be lost
     * standing at an aeroplane; a booking is a claim on a shared resource in
     * the future, and one made from a phone with no signal could be granted
     * against a calendar the phone has not seen. The exclusion constraint is
     * what decides, and it can only decide online.
     */
    createReservation: (input: CreateReservationRequest) =>
      request<ReservationResponse>('POST', '/reservations', input),
    cancelReservation: (id: string) =>
      request<ReservationResponse>('POST', `/reservations/${id}/cancel`),
    listBlackouts: (query: { from?: string; to?: string; aircraftId?: string } = {}) => {
      const params = new URLSearchParams();
      if (query.from) params.set('from', query.from);
      if (query.to) params.set('to', query.to);
      if (query.aircraftId) params.set('aircraft_id', query.aircraftId);
      const search = params.toString();
      return request<BlackoutResponse[]>('GET', search ? `/blackouts?${search}` : '/blackouts');
    },

    // ---- member billing (§3.7) -------------------------------------------
    /**
     * Their own, and only their own.
     *
     * The `member` parameter the web treasurer's view uses is deliberately
     * not exposed here: a Pilot holds `charges: read` scope `own`, so asking
     * for somebody else's returns an empty statement rather than an error,
     * and a client that can ask is a client that will one day ask by
     * accident. Omitting it makes the endpoint answer the only question this
     * client has.
     *
     * Behind `member_billing`, so this 404s on a free tenant — the one call
     * in this client that can. §8.3: the app reads the flag and does not
     * offer the screen, and says nothing about why.
     */
    statement: (query: { from?: string; to?: string } = {}) => {
      const params = new URLSearchParams();
      if (query.from) params.set('from', query.from);
      if (query.to) params.set('to', query.to);
      const search = params.toString();
      return request<StatementResponse>('GET', search ? `/statement?${search}` : '/statement');
    },

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
