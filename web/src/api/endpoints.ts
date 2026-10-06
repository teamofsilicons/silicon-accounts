/**
 * Every endpoint of 02-api.md as a typed function, grouped the way the API is. The account site calls the session and
 * flow endpoints; app-authenticated ones take explicit credentials and exist for tools, docs and tests.
 *
 * Where the server may answer in more than one shape (noted in the client crate's phase notes), the functions
 * normalize the answer, so callers always get the documented type.
 */
import { request, seg, formBody, type RequestOptions } from "./http";
import type {
  AccountSummary, AppDetail, AppProof, AppProofsQuery, AppPublic, AppUser, AppUserDetail, AppUsersQuery,
  AtaRequest, BrowserSession, CarbonMe, CliLoginChallenge, ConfigHistoryItem, ConsentSubmit, ContactChallenge,
  CreateSilicon, CustodianRequest, CustodianRequestStatus, DeliveriesQuery, DeviceAuthorization, DeviceRequest,
  EmailView, FlowCreate, FlowEnvelope, FlowView, HistoryItem, HistoryQuery, IdAvailability, IdentityView, ImportJob,
  ImportOptions, ImportRow, ImportRowResult, ImportRowsQuery, Introspection, IssuedProof, Jwks, ManagedSilicon, Me, Meta,
  MyApp, MyProof, OboRequest, OidcDiscovery, OutboxMessage, OwnedApp, Page, PageQuery, PhoneView, PhotoUploaded,
  ProfileUpdate, ProofRevokeRequest, ProofVerification, ReplayRequest, ReplayResult, ReportReceipt, SessionInfo,
  ShortLivedToken, SigninConfigPatch, SiliconAppsApp, SiliconCreated, SiliconMe, SiliconSelfCreate, SiliconSelfCreated,
  SiliconWebhook, SignupSubmit, StkRotated, TelemetryEvent, TokenRequest, TokenResponse, TransferRequest, UpdateSilicon,
  UserInfo, WebhookAttempt, WebhookDelivery, WebhookDeliveryDetail, WebhookEvent,
} from "./types";

/** App credentials for app-authenticated endpoints. */
export interface AppCredentials {
  appId: string;
  secret: string;
}

/** Calls that change state accept an Idempotency-Key and an abort signal. */
export interface CallOptions {
  idempotencyKey?: string;
  signal?: AbortSignal;
}

const asApp = (credentials: AppCredentials): RequestOptions["auth"] => ({ basic: { appId: credentials.appId, secret: credentials.secret } });
const pageQuery = (query: PageQuery | undefined) => ({ limit: query?.limit, cursor: query?.cursor ?? undefined });

/* ---------------------------------------------- shape normalization ---------------------------------------------- */

function unwrap<T>(value: unknown, key: string): T {
  if (value && typeof value === "object" && key in (value as Record<string, unknown>)) return (value as Record<string, T>)[key] as T;
  return value as T;
}

function asList<T>(value: unknown, ...keys: string[]): T[] | null {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === "object") {
    for (const key of ["items", ...keys]) {
      const list = (value as Record<string, unknown>)[key];
      if (Array.isArray(list)) return list as T[];
    }
  }
  return null;
}

function isMe(value: unknown): value is Me {
  return !!value && typeof value === "object" && typeof (value as Me).uuid === "string" && typeof (value as Me).kind === "string" && "version" in (value as object);
}

/** PATCH /v1/me, POST /v1/me/id, DELETE /v1/me/photo answer Me or {account: Me}; anything else means "read it again". */
async function meFrom(value: unknown): Promise<Me> {
  const candidate = unwrap<unknown>(unwrap<unknown>(value, "account"), "me");
  return isMe(candidate) ? candidate : me.get();
}

function toManagedSilicon(value: unknown): ManagedSilicon {
  const record = value as Record<string, unknown>;
  if (record && typeof record === "object" && record.silicon && typeof record.silicon === "object") {
    return { ...(record.silicon as SiliconMe), pending_transfer: (record.pending_transfer as ManagedSilicon["pending_transfer"]) ?? null };
  }
  return { ...(record as unknown as SiliconMe), pending_transfer: (record?.pending_transfer as ManagedSilicon["pending_transfer"]) ?? null };
}

function toDeliveryDetail(value: unknown): WebhookDeliveryDetail {
  const record = (value ?? {}) as Record<string, unknown>;
  if (record.delivery && typeof record.delivery === "object") {
    return {
      delivery: record.delivery as WebhookDelivery,
      attempts: Array.isArray(record.attempts) ? (record.attempts as WebhookAttempt[]) : [],
      payload: (record.payload as WebhookEvent | undefined) ?? null,
    };
  }
  const attempts = Array.isArray(record.attempts) ? (record.attempts as WebhookAttempt[]) : [];
  const delivery = { ...(record as unknown as WebhookDelivery), attempts: Array.isArray(record.attempts) ? attempts.length : (record.attempts as number) ?? 0 };
  delete (delivery as Partial<{ payload: unknown }>).payload;
  return { delivery, attempts, payload: (record.payload as WebhookEvent | undefined) ?? null };
}

/* ------------------------------------------------- discovery ------------------------------------------------- */

export const meta = {
  /** `GET /v1/meta` — name, version, environment, public and Silicon Apps URLs, configured providers. */
  get: (signal?: AbortSignal) => request<Meta>("/v1/meta", { signal }),
  /** `GET /healthz` → "ok". */
  health: () => request<string>("/healthz"),
  /** `GET /readyz` → {database:"ok"} or 503. */
  ready: () => request<{ database: string }>("/readyz"),
  /** `GET /.well-known/openid-configuration`. */
  oidcDiscovery: () => request<OidcDiscovery>("/.well-known/openid-configuration"),
  /** `GET /.well-known/jwks.json`. */
  jwks: () => request<Jwks>("/.well-known/jwks.json"),
};

/* ---------------------------------------------- ids and lookups ---------------------------------------------- */

export const ids = {
  /** `GET /v1/ids/available?id=c:saket` — invalid ids answer 200 with reason "invalid" and a precise message. */
  available: (id: string, signal?: AbortSignal) => request<IdAvailability>("/v1/ids/available", { query: { id }, signal }),
};

export const accounts = {
  /** `GET /v1/accounts/{uuid}` (session or app) — AccountSummary, plus custodian for Silicons. */
  get: (uuid: string, credentials?: AppCredentials) => request<AccountSummary>(`/v1/accounts/${seg(uuid)}`, { auth: credentials && asApp(credentials) }),
  /** `GET /v1/accounts/by-id/{id}` — current ids only. */
  byId: (id: string, credentials?: AppCredentials) => request<AccountSummary>(`/v1/accounts/by-id/${seg(id)}`, { auth: credentials && asApp(credentials) }),
};

/* ---------------------------------------------- hosted sign-in ---------------------------------------------- */

const flowCall = async (path: string, body?: unknown, signal?: AbortSignal): Promise<FlowView> =>
  (await request<FlowEnvelope>(path, { method: "POST", body: body ?? {}, signal })).flow;

export const flows = {
  /** `POST /v1/flows` — validates the app and redirect URI, sets the flow cookie. 400 unknown_app / redirect_uri_not_registered / app_disabled. */
  create: async (body: FlowCreate, signal?: AbortSignal) => (await request<FlowEnvelope>("/v1/flows", { method: "POST", body, signal })).flow,
  /** `GET /v1/flows/{id}` (flow cookie). */
  get: async (id: string, signal?: AbortSignal) => (await request<FlowEnvelope>(`/v1/flows/${seg(id)}`, { signal, quiet401: true })).flow,
  /** Continue as the browser's signed-in account. */
  continueAs: (id: string) => flowCall(`/v1/flows/${seg(id)}/continue`),
  /** Forget the chosen account for this flow (back to choose_method). */
  switchAccount: (id: string) => flowCall(`/v1/flows/${seg(id)}/switch`),
  /** Send a sign-in code to an email. */
  email: (id: string, email: string) => flowCall(`/v1/flows/${seg(id)}/email`, { email }),
  /** Send a sign-in code by SMS; `country` is the default for local-format numbers. */
  phone: (id: string, phone: string, country?: string) => flowCall(`/v1/flows/${seg(id)}/phone`, { phone, country }),
  /** Resend the current challenge (counts toward the send limit). */
  resend: (id: string) => flowCall(`/v1/flows/${seg(id)}/resend`),
  /** Verify the 6-digit code. Errors: invalid_code (422, remaining_attempts), code_expired (410), verification_locked (423). */
  verify: (id: string, code: string) => flowCall(`/v1/flows/${seg(id)}/verify`, { code }),
  /** Start Google or Apple: navigate the browser to the returned `authorize_url`. */
  oauthStart: (id: string, provider: "google" | "apple") => request<{ authorize_url: string }>(`/v1/flows/${seg(id)}/oauth/${provider}`, { method: "POST", body: {} }),
  /** Create the account (or finish an imported one). 409 id_taken with details.suggestions. */
  signup: (id: string, body: SignupSubmit) => flowCall(`/v1/flows/${seg(id)}/signup`, body),
  /** Send a code to add a missing required email. */
  requirementEmail: (id: string, email: string) => flowCall(`/v1/flows/${seg(id)}/requirements/email`, { email }),
  /** Send a code to add a missing required phone. */
  requirementPhone: (id: string, phone: string, country?: string) => flowCall(`/v1/flows/${seg(id)}/requirements/phone`, { phone, country }),
  /** Verify the requirement code; the email/phone is added to the account. */
  requirementVerify: (id: string, code: string) => flowCall(`/v1/flows/${seg(id)}/requirements/verify`, { code }),
  /** Approve (with the chosen optional scopes) or decline what is shared. */
  consent: (id: string, body: ConsentSubmit) => flowCall(`/v1/flows/${seg(id)}/consent`, body),
};

/** The /authorize URL an app sends a browser to (also what /sign-in builds for the account site). */
export function authorizeUrl(params: FlowCreate, base = ""): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
  return `${base}/authorize?${query.toString()}`;
}

/* --------------------------------------- browser session, device, CLI --------------------------------------- */

export const session = {
  /**
   * `GET /v1/session` — resolves null when there is no session: a 401 (the documented answer), or a 200 whose
   * `account` is null (accepted too, so the server can answer signed-out browsers without a failed request).
   */
  get: async (signal?: AbortSignal): Promise<BrowserSession | null> => {
    try {
      const value = await request<Partial<BrowserSession> | null>("/v1/session", { signal, quiet401: true });
      return value?.account && value.session ? (value as BrowserSession) : null;
    } catch (error) {
      if (error instanceof Error && "status" in error && (error as { status: number }).status === 401) return null;
      throw error;
    }
  },
  /** `POST /v1/session/signout` — revokes this browser session and clears the cookie. */
  signOut: () => request<null>("/v1/session/signout", { method: "POST", body: {}, quiet401: true }),
};

export const device = {
  /** `POST /v1/device/authorize` (public) — starts the CLI device flow. */
  authorize: (clientLabel?: string) => request<DeviceAuthorization>("/v1/device/authorize", { method: "POST", body: { client_label: clientLabel } }),
  /** `GET /v1/device/{user_code}` (Carbon session). */
  get: (userCode: string) => request<DeviceRequest>(`/v1/device/${seg(userCode)}`),
  approve: (userCode: string) => request<null>(`/v1/device/${seg(userCode)}/approve`, { method: "POST", body: {} }),
  deny: (userCode: string) => request<null>(`/v1/device/${seg(userCode)}/deny`, { method: "POST", body: {} }),
};

export const cliLogin = {
  /** `POST /v1/cli/login/start` — existing active Carbons only (404 account_not_found otherwise). */
  start: (contact: { email: string } | { phone: string; country?: string }) => request<CliLoginChallenge>("/v1/cli/login/start", { method: "POST", body: contact }),
  /** `POST /v1/cli/login/verify` — first-party token response (aud=accounts). */
  verify: (challengeId: string, code: string, clientLabel?: string) =>
    request<TokenResponse>("/v1/cli/login/verify", { method: "POST", body: { challenge_id: challengeId, code, client_label: clientLabel } }),
};

/* --------------------------------------------- my account --------------------------------------------- */

const contactList = async <T>(path: string, key: string, answer?: unknown): Promise<T[]> => {
  const list = asList<T>(answer, key);
  if (list) return list;
  return asList<T>(await request<unknown>(path), key) ?? [];
};

export const me = {
  /** `GET /v1/me` — the full own view (Carbon or Silicon). */
  get: (signal?: AbortSignal) => request<Me>("/v1/me", { signal }),
  /** `PATCH /v1/me` — Silicons cannot change dob (422 dob_immutable). */
  update: async (patch: ProfileUpdate) => meFrom(await request<unknown>("/v1/me", { method: "PATCH", body: patch })),
  /** `POST /v1/me/photo` — PNG, JPEG, WebP or GIF up to 2 MB. */
  uploadPhoto: (file: Blob) => request<PhotoUploaded>("/v1/me/photo", { method: "POST", raw: file, contentType: file.type || "application/octet-stream" }),
  /** `DELETE /v1/me/photo` — back to the default photo. */
  removePhoto: async () => meFrom(await request<unknown>("/v1/me/photo", { method: "DELETE" })),
  /** `POST /v1/me/id` — 409 id_taken / id_reserved, 422 invalid_id. The old id stays reserved for you for 10 days. */
  changeId: async (id: string) => meFrom(await request<unknown>("/v1/me/id", { method: "POST", body: { id } })),
  /** `DELETE /v1/me` — 409 custodian_of_silicons while you are custodian of any Silicon. */
  deleteAccount: (confirm: string) => request<null>("/v1/me", { method: "DELETE", body: { confirm } }),

  emails: {
    list: () => contactList<EmailView>("/v1/me/emails", "emails"),
    /** Sends a code (409 email_in_use / email_already_added, 422 email_limit_reached at 10). */
    add: (email: string) => request<ContactChallenge>("/v1/me/emails", { method: "POST", body: { email } }),
    verify: async (challengeId: string, code: string) => contactList<EmailView>("/v1/me/emails", "emails", await request<unknown>("/v1/me/emails/verify", { method: "POST", body: { challenge_id: challengeId, code } })),
    makePrimary: async (email: string) => contactList<EmailView>("/v1/me/emails", "emails", await request<unknown>(`/v1/me/emails/${seg(email)}/primary`, { method: "POST", body: {} })),
    /** 409 cannot_remove_primary. */
    remove: async (email: string) => contactList<EmailView>("/v1/me/emails", "emails", await request<unknown>(`/v1/me/emails/${seg(email)}`, { method: "DELETE" })),
  },

  phones: {
    list: () => contactList<PhoneView>("/v1/me/phones", "phones"),
    add: (phone: string, country?: string) => request<ContactChallenge>("/v1/me/phones", { method: "POST", body: { phone, country } }),
    verify: async (challengeId: string, code: string) => contactList<PhoneView>("/v1/me/phones", "phones", await request<unknown>("/v1/me/phones/verify", { method: "POST", body: { challenge_id: challengeId, code } })),
    makePrimary: async (phone: string) => contactList<PhoneView>("/v1/me/phones", "phones", await request<unknown>(`/v1/me/phones/${seg(phone)}/primary`, { method: "POST", body: {} })),
    remove: async (phone: string) => contactList<PhoneView>("/v1/me/phones", "phones", await request<unknown>(`/v1/me/phones/${seg(phone)}`, { method: "DELETE" })),
  },

  identities: {
    list: () => contactList<IdentityView>("/v1/me/identities", "identities"),
    remove: (provider: "google" | "apple", subject: string) => request<null>(`/v1/me/identities/${seg(provider)}/${seg(subject)}`, { method: "DELETE" }),
  },

  apps: {
    /** Apps I have signed into. */
    list: (query?: PageQuery) => request<Page<MyApp>>("/v1/me/apps", { query: pageQuery(query) }),
    /** Removes an app's access: its sessions and OBO proofs about me are revoked and it is told. */
    removeAccess: (appId: string) => request<null>(`/v1/me/apps/${seg(appId)}`, { method: "DELETE" }),
  },

  sessions: {
    list: () => request<Page<SessionInfo> | SessionInfo[]>("/v1/me/sessions").then(value => asList<SessionInfo>(value, "sessions") ?? []),
    revoke: (id: string) => request<null>(`/v1/me/sessions/${seg(id)}`, { method: "DELETE" }),
  },

  /** Sign-ins, id changes, custodian changes, proofs, app access and security events, newest first. */
  history: (query?: HistoryQuery) => request<Page<HistoryItem>>("/v1/me/history", { query: { ...pageQuery(query), kind: query?.kind } }),

  proofs: {
    /** OBO proofs issued on my behalf. */
    list: (query?: PageQuery) => request<Page<MyProof>>("/v1/me/proofs", { query: pageQuery(query) }),
    revoke: (proofId: string) => request<null>(`/v1/me/proofs/${seg(proofId)}`, { method: "DELETE" }),
  },

  /** `POST /v1/me/short-lived-tokens` — a 2-minute, single-use token an app exchanges for this account's tokens. */
  shortLivedToken: (appId: string) => request<ShortLivedToken>("/v1/me/short-lived-tokens", { method: "POST", body: { app_id: appId } }),

  /** A Silicon's own webhook (session(silicon)). */
  webhook: {
    set: (url: string) => request<SiliconWebhook>("/v1/me/webhook", { method: "PUT", body: { url } }),
    remove: () => request<null>("/v1/me/webhook", { method: "DELETE" }),
    test: () => request<{ event_id?: string } | null>("/v1/me/webhook/test", { method: "POST", body: {} }),
  },

  /** Apps this Carbon owns (developer area). */
  ownedApps: (query?: PageQuery) => request<Page<OwnedApp>>("/v1/me/owned-apps", { query: pageQuery(query) }),

  /** Silicons this Carbon is custodian of. */
  silicons: {
    list: async (query?: PageQuery): Promise<Page<ManagedSilicon>> => {
      const page = await request<Page<unknown>>("/v1/me/silicons", { query: pageQuery(query) });
      return { items: (asList<unknown>(page) ?? []).map(toManagedSilicon), next_cursor: page?.next_cursor ?? null };
    },
    /** Creates a Silicon with me as custodian. A generated STK is in the answer exactly once. */
    create: (body: CreateSilicon, options?: CallOptions) => request<SiliconCreated>("/v1/me/silicons", { method: "POST", body, idempotencyKey: options?.idempotencyKey ?? true, signal: options?.signal }),
    get: async (uuid: string) => toManagedSilicon(await request<unknown>(`/v1/me/silicons/${seg(uuid)}`)),
    update: async (uuid: string, patch: UpdateSilicon) => unwrap<SiliconMe>(await request<unknown>(`/v1/me/silicons/${seg(uuid)}`, { method: "PATCH", body: patch }), "silicon"),
    changeId: async (uuid: string, id: string) => unwrap<SiliconMe>(await request<unknown>(`/v1/me/silicons/${seg(uuid)}/id`, { method: "POST", body: { id } }), "silicon"),
    setWebhook: (uuid: string, url: string) => request<SiliconWebhook>(`/v1/me/silicons/${seg(uuid)}/webhook`, { method: "PUT", body: { url } }),
    removeWebhook: (uuid: string) => request<null>(`/v1/me/silicons/${seg(uuid)}/webhook`, { method: "DELETE" }),
    /** Kills the old STK at once and signs the Silicon out everywhere. Omit `stk` to generate one (shown once). */
    rotateStk: (uuid: string, stk?: string) => request<StkRotated>(`/v1/me/silicons/${seg(uuid)}/stk`, { method: "POST", body: stk ? { stk } : {} }),
    /** Asks another Carbon (`c:id` or email) to take over; they have 14 days to accept. */
    transfer: async (uuid: string, to: string) => unwrap<TransferRequest>(await request<unknown>(`/v1/me/silicons/${seg(uuid)}/transfer`, { method: "POST", body: { to } }), "request"),
    cancelTransfer: (uuid: string) => request<null>(`/v1/me/silicons/${seg(uuid)}/transfer`, { method: "DELETE" }),
    /** Deletes the Silicon account; `confirm` must be its si:id. */
    remove: (uuid: string, confirm: string) => request<null>(`/v1/me/silicons/${seg(uuid)}`, { method: "DELETE", body: { confirm } }),
  },

  /** Custodian requests addressed to me (by uuid or any verified email of mine). */
  custodianRequests: {
    list: (query?: PageQuery) => request<Page<CustodianRequest>>("/v1/me/custodian-requests", { query: pageQuery(query) }),
    accept: (id: string) => request<null>(`/v1/me/custodian-requests/${seg(id)}/accept`, { method: "POST", body: {} }),
    decline: (id: string) => request<null>(`/v1/me/custodian-requests/${seg(id)}/decline`, { method: "POST", body: {} }),
  },
};

/** Narrowing helper: the Carbon view of Me (throws a precise error for a Silicon). */
export function carbonOnly(value: Me): CarbonMe {
  if (value.kind !== "carbon") throw new Error(`This page is for Carbons; ${value.id ?? value.uuid} is a Silicon.`);
  return value;
}

/* ---------------------------------------------- Silicons (public) ---------------------------------------------- */

export const silicons = {
  /** `POST /v1/silicons` — a Silicon creates its own account and names a custodian (c:id or email). */
  selfCreate: (body: SiliconSelfCreate, options?: CallOptions) => request<SiliconSelfCreated>("/v1/silicons", { method: "POST", body, idempotencyKey: options?.idempotencyKey ?? true, signal: options?.signal }),
  /** `GET /v1/silicons/requests/{id}` with the `sarq_…` request token. */
  requestStatus: (id: string, requestToken: string) => request<CustodianRequestStatus>(`/v1/silicons/requests/${seg(id)}`, { auth: { bearer: requestToken } }),
  /** `POST /v1/silicons/login` — si:id + STK → first-party tokens. 401 invalid_credentials, 403 custodian_pending, 423 login_locked. */
  login: (id: string, stk: string, clientLabel?: string) => request<TokenResponse>("/v1/silicons/login", { method: "POST", body: { id, stk, client_label: clientLabel } }),
};

/* --------------------------------------------------- apps --------------------------------------------------- */

/** For app-or-owner endpoints: the owner's session (default) or the app's own credentials. */
type Owner = AppCredentials | undefined;
const ownerAuth = (credentials: Owner) => (credentials ? asApp(credentials) : undefined);

export const apps = {
  /** `GET /v1/apps/{app_id}/public` (CORS *). */
  public: (appId: string, signal?: AbortSignal) => request<AppPublic>(`/v1/apps/${seg(appId)}/public`, { signal }),
  /** `GET /v1/apps/{app_id}` — config with secrets masked, webhook, stats. */
  get: (appId: string, credentials?: Owner) => request<AppDetail>(`/v1/apps/${seg(appId)}`, { auth: ownerAuth(credentials) }),
  /** `PATCH /v1/apps/{app_id}/signin-config` — deep merge; 422 with details.fields; 409 config_version_conflict. */
  updateSigninConfig: (appId: string, patch: SigninConfigPatch, options?: CallOptions & { credentials?: AppCredentials }) =>
    request<AppDetail>(`/v1/apps/${seg(appId)}/signin-config`, { method: "PATCH", body: patch, idempotencyKey: options?.idempotencyKey ?? true, auth: ownerAuth(options?.credentials), signal: options?.signal }),
  configHistory: (appId: string, query?: PageQuery, credentials?: Owner) =>
    request<Page<ConfigHistoryItem>>(`/v1/apps/${seg(appId)}/signin-config/history`, { query: pageQuery(query), auth: ownerAuth(credentials) }),

  users: (appId: string, query?: AppUsersQuery, credentials?: Owner) =>
    request<Page<AppUser>>(`/v1/apps/${seg(appId)}/users`, { query: { ...pageQuery(query), q: query?.q, status: query?.status, kind: query?.kind, source: query?.source }, auth: ownerAuth(credentials) }),
  user: async (appId: string, uuid: string, credentials?: Owner) => unwrap<AppUserDetail>(await request<unknown>(`/v1/apps/${seg(appId)}/users/${seg(uuid)}`, { auth: ownerAuth(credentials) }), "user"),

  imports: {
    /** Starts an import from JSON rows. 422 unknown_columns unless options.ignore_unknown_columns. */
    startRows: async (appId: string, rows: ImportRow[], options: ImportOptions = {}, call?: CallOptions & { credentials?: AppCredentials }) =>
      unwrap<ImportJob>(await request<unknown>(`/v1/apps/${seg(appId)}/imports`, { method: "POST", body: { rows, options }, idempotencyKey: call?.idempotencyKey ?? true, auth: ownerAuth(call?.credentials), signal: call?.signal }), "job"),
    /** Starts an import from CSV text or a file; options travel as query parameters. */
    startCsv: async (appId: string, csv: string | Blob, options: ImportOptions = {}, call?: CallOptions & { credentials?: AppCredentials }) =>
      unwrap<ImportJob>(await request<unknown>(`/v1/apps/${seg(appId)}/imports`, {
        method: "POST",
        raw: csv,
        contentType: "text/csv",
        query: { default_country: options.default_country, ignore_unknown_columns: options.ignore_unknown_columns, dry_run: options.dry_run, update_existing: options.update_existing },
        idempotencyKey: call?.idempotencyKey ?? true,
        auth: ownerAuth(call?.credentials),
        signal: call?.signal,
      }), "job"),
    list: (appId: string, query?: PageQuery, credentials?: Owner) => request<Page<ImportJob>>(`/v1/apps/${seg(appId)}/imports`, { query: pageQuery(query), auth: ownerAuth(credentials) }),
    get: async (appId: string, jobId: string, credentials?: Owner) => unwrap<ImportJob>(await request<unknown>(`/v1/apps/${seg(appId)}/imports/${seg(jobId)}`, { auth: ownerAuth(credentials) }), "job"),
    rows: (appId: string, jobId: string, query?: ImportRowsQuery, credentials?: Owner) =>
      request<Page<ImportRowResult>>(`/v1/apps/${seg(appId)}/imports/${seg(jobId)}/rows`, { query: { ...pageQuery(query), outcome: query?.outcome }, auth: ownerAuth(credentials) }),
  },

  webhook: {
    /** Sets the URL; a new `whsec_…` secret is returned (shown once) each time. */
    set: (appId: string, url: string, credentials?: Owner) => request<{ url: string; secret: string }>(`/v1/apps/${seg(appId)}/webhook`, { method: "PUT", body: { url }, auth: ownerAuth(credentials) }),
    remove: (appId: string, credentials?: Owner) => request<null>(`/v1/apps/${seg(appId)}/webhook`, { method: "DELETE", auth: ownerAuth(credentials) }),
    rotateSecret: (appId: string, credentials?: Owner) => request<{ secret: string }>(`/v1/apps/${seg(appId)}/webhook/rotate-secret`, { method: "POST", body: {}, auth: ownerAuth(credentials) }),
    /** Enqueues a `ping` event. */
    test: (appId: string, credentials?: Owner) => request<{ event_id: string }>(`/v1/apps/${seg(appId)}/webhook/test`, { method: "POST", body: {}, auth: ownerAuth(credentials) }),
    deliveries: (appId: string, query?: DeliveriesQuery, credentials?: Owner) =>
      request<Page<WebhookDelivery>>(`/v1/apps/${seg(appId)}/webhook/deliveries`, { query: { ...pageQuery(query), status: query?.status }, auth: ownerAuth(credentials) }),
    delivery: async (appId: string, deliveryId: string, credentials?: Owner) => toDeliveryDetail(await request<unknown>(`/v1/apps/${seg(appId)}/webhook/deliveries/${seg(deliveryId)}`, { auth: ownerAuth(credentials) })),
    /** Re-queues up to 100 deliveries to the current URL with the current secret; skips accounts that lost access. */
    replay: (appId: string, body: ReplayRequest, options?: CallOptions & { credentials?: AppCredentials }) =>
      request<ReplayResult>(`/v1/apps/${seg(appId)}/webhook/replay`, { method: "POST", body, idempotencyKey: options?.idempotencyKey ?? true, auth: ownerAuth(options?.credentials), signal: options?.signal }),
  },

  proofs: {
    /** Proofs issued by the app. */
    list: (appId: string, query?: AppProofsQuery, credentials?: Owner) =>
      request<Page<AppProof>>(`/v1/apps/${seg(appId)}/proofs`, { query: { ...pageQuery(query), kind: query?.kind, status: query?.status }, auth: ownerAuth(credentials) }),
    /** The ATA page stand-in: issue an app-to-app proof for `audiences` (token shown once). */
    createAta: (appId: string, body: AtaRequest, options?: CallOptions & { credentials?: AppCredentials }) =>
      request<IssuedProof>(`/v1/apps/${seg(appId)}/proofs/ata`, { method: "POST", body, idempotencyKey: options?.idempotencyKey ?? true, auth: ownerAuth(options?.credentials), signal: options?.signal }),
    revoke: (appId: string, proofId: string, credentials?: Owner) => request<null>(`/v1/apps/${seg(appId)}/proofs/${seg(proofId)}`, { method: "DELETE", auth: ownerAuth(credentials) }),
  },
};

/* ------------------------------------------- proofs (app credentials) ------------------------------------------- */

export const proofs = {
  issueObo: (credentials: AppCredentials, body: OboRequest, options?: CallOptions) =>
    request<IssuedProof>("/v1/proofs/obo", { method: "POST", body, auth: asApp(credentials), idempotencyKey: options?.idempotencyKey ?? true, signal: options?.signal }),
  issueAta: (credentials: AppCredentials, body: AtaRequest, options?: CallOptions) =>
    request<IssuedProof>("/v1/proofs/ata", { method: "POST", body, auth: asApp(credentials), idempotencyKey: options?.idempotencyKey ?? true, signal: options?.signal }),
  refresh: (credentials: AppCredentials, proofRefreshToken: string, accessTtlSeconds?: number) =>
    request<IssuedProof>("/v1/proofs/refresh", { method: "POST", body: { proof_refresh_token: proofRefreshToken, access_ttl_seconds: accessTtlSeconds }, auth: asApp(credentials) }),
  /** The verifying app must be one of the audiences; anything else answers exactly {valid:false, expires_at:null}. */
  verify: (credentials: AppCredentials, proofToken: string) => request<ProofVerification>("/v1/proofs/verify", { method: "POST", body: { proof_token: proofToken }, auth: asApp(credentials) }),
  revoke: (credentials: AppCredentials, body: ProofRevokeRequest) => request<null>("/v1/proofs/revoke", { method: "POST", body, auth: asApp(credentials) }),
};

/* --------------------------------------------- OAuth / OIDC (apps) --------------------------------------------- */

export const oauth = {
  /** `POST /v1/oauth/token` (form-encoded). Errors are RFC 6749 (`invalid_grant`, `authorization_pending`…) mapped to ApiError.code. */
  token: (body: TokenRequest, credentials?: AppCredentials) =>
    request<TokenResponse>("/v1/oauth/token", { method: "POST", raw: formBody(body as unknown as Record<string, string | undefined>), contentType: "application/x-www-form-urlencoded", auth: credentials && asApp(credentials) }),
  /** `POST /v1/oauth/revoke` — always 200 (RFC 7009). */
  revoke: (token: string, credentials?: AppCredentials, clientId?: string) =>
    request<null>("/v1/oauth/revoke", { method: "POST", raw: formBody({ token, client_id: credentials ? undefined : clientId }), contentType: "application/x-www-form-urlencoded", auth: credentials && asApp(credentials) }),
  introspect: (token: string, credentials: AppCredentials) =>
    request<Introspection>("/v1/oauth/introspect", { method: "POST", raw: formBody({ token }), contentType: "application/x-www-form-urlencoded", auth: asApp(credentials) }),
  /** `GET /v1/userinfo` with an app access token. */
  userinfo: (accessToken: string) => request<UserInfo>("/v1/userinfo", { auth: { bearer: accessToken } }),
};

/* ---------------------------------------- reports, telemetry, dev, internal ---------------------------------------- */

export const reports = {
  /** `POST /v1/reports` — mailed to the Silicon Accounts maintainers (5/hour per network). pr_url must be https. */
  create: (message: string, prUrl?: string, options?: CallOptions) =>
    request<ReportReceipt>("/v1/reports", { method: "POST", body: { message, pr_url: prUrl }, idempotencyKey: options?.idempotencyKey ?? true, signal: options?.signal, quiet401: true }),
};

export const telemetry = {
  /** `POST /v1/telemetry/events` (≤ 50 events). `optOut` sends X-Accounts-Telemetry: off so nothing is forwarded. */
  send: (events: TelemetryEvent[], optOut = false) =>
    request<null>("/v1/telemetry/events", { method: "POST", body: { events }, headers: optOut ? { "X-Accounts-Telemetry": "off" } : undefined, quiet401: true }),
};

export const devOutbox = {
  /** `GET /v1/dev/outbox` — only when the server exposes it (never in production; 404 otherwise). */
  list: (query?: { to?: string; purpose?: string; limit?: number }) => request<Page<OutboxMessage>>("/v1/dev/outbox", { query }),
};

export const internal = {
  /** `POST /v1/internal/apps/sync` — the Silicon Apps stand-in (service token). */
  syncApps: (internalToken: string, appsToSync: SiliconAppsApp[]) => request<unknown>("/v1/internal/apps/sync", { method: "POST", body: { apps: appsToSync }, auth: { bearer: internalToken } }),
};

/** Everything, as one object: `api.me.get()`, `api.flows.verify(id, code)`… */
export const api = { meta, ids, accounts, flows, session, device, cliLogin, me, silicons, apps, proofs, oauth, reports, telemetry, devOutbox, internal };
export type Api = typeof api;
