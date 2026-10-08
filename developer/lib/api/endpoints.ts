/**
 * Every endpoint of the Silicon Accounts HTTP API as a typed function, grouped the way the API is. The account site
 * calls the session and account endpoints; app-authenticated ones take explicit credentials and exist for tools, docs
 * and tests. Shapes are the server's own (see types.ts); a few list endpoints are unwrapped to their items where the
 * server answers `{items}` and has no paging (noted per function).
 *
 * Calls that change state take `CallOptions`: pass `idempotencyKey` (keep one per logical action, see
 * lib/query/idempotency.ts) on endpoints the server makes idempotent, and `signal` to cancel.
 */
import { request, seg, formBody, type RequestOptions } from "./http";
import type {
  AccountSummary, AccountVerificationRequestResult, AccountVerificationRequestState, AppDetail, AppProof, AppProofHistoryEvent, AppProofsQuery, AppPublic, AppUser, AppUserDetail, AppUsersQuery, AppVerificationRequest,
  BrowserSession, CliLoginChallenge, ConfigHistoryItem, ConsentSubmit, ContactChallenge, CreateSilicon,
  CustodianRequest, CustodianRequestStatus, DeliveriesQuery, DeviceAuthorization, DeviceRequest, EmailView, FlowCreate,
  FlowEnvelope, FlowView, HistoryItem, HistoryQuery, IdAvailability, IdentityView, ImportJob, ImportOptions, ImportRow,
  ImportRowResult, ImportRowsQuery, Introspection, IssuedProof, Jwks, ManagedAppProof, ManagedAppProofsQuery, ManagedSilicon, Me, Meta, MyApp, MyProof,
  UserVerificationRequest, OidcDiscovery, OutboxMessage, OwnedApp, Page, PageQuery, PhoneView, PhotoUploaded, ProfileUpdate,
  ProofRevokeRequest, ProofVerification, ReplayRequest, ReplayResult, ReportReceipt, SessionInfo, ShortLivedToken,
  SigninConfigPatch, SiliconAppsApp, SiliconCreated, SiliconPhotoUploaded, SiliconSelfCreate, SiliconSelfCreated,
  SiliconWebhook, SiliconWebhookTestQueued, SignupPhoto, SignupSubmit, StkRotated, TelemetryEvent, TokenRequest, TokenResponse,
  TransferRequest, UpdateSilicon, UserInfo, WebhookDelivery, WebhookDeliveryDetail, WebhookTestQueued,
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
const items = <T>(page: Page<T> | null): T[] => page?.items ?? [];

/* ------------------------------------------------- discovery ------------------------------------------------- */

export const meta = {
  /** `GET /v1/meta`: name, version, environment, public and Silicon Apps URLs, configured providers. */
  get: (signal?: AbortSignal) => request<Meta>("/v1/meta", { signal }),
  /** `GET /.well-known/openid-configuration`. */
  oidcDiscovery: () => request<OidcDiscovery>("/.well-known/openid-configuration"),
  /** `GET /.well-known/jwks.json`. */
  jwks: () => request<Jwks>("/.well-known/jwks.json"),
};

/* ---------------------------------------------- ids and lookups ---------------------------------------------- */

export const ids = {
  /**
   * `GET /v1/ids/available?id=c:saket`: invalid ids answer 200 with reason "invalid" and a precise message; taken ids
   * carry free `suggestions`. With a session, your own reserved id answers available + reclaimable.
   */
  available: (id: string, signal?: AbortSignal) => request<IdAvailability>("/v1/ids/available", { query: { id }, signal }),
};

export const accounts = {
  /** `GET /v1/accounts/{uuid}` (session or app): AccountSummary, plus custodian for Silicons. 404 once deleted. */
  get: (uuid: string, credentials?: AppCredentials) => request<AccountSummary>(`/v1/accounts/${seg(uuid)}`, { auth: credentials && asApp(credentials) }),
  /** `GET /v1/accounts/by-id/{id}`: current ids only. */
  byId: (id: string, credentials?: AppCredentials) => request<AccountSummary>(`/v1/accounts/by-id/${seg(id)}`, { auth: credentials && asApp(credentials) }),
};

/* ---------------------------------------------- hosted sign-in ---------------------------------------------- */

const flowCall = async (path: string, body?: unknown, signal?: AbortSignal): Promise<FlowView> =>
  (await request<FlowEnvelope>(path, { method: "POST", body: body ?? {}, signal })).flow;

export const flows = {
  /**
   * `POST /v1/flows` (201): validates the app and redirect URI, sets the flow cookie. Before the redirect URI is
   * validated errors are 400 unknown_app / app_disabled / redirect_uri_not_registered with no redirect (show an
   * error page); after it, errors carry `details.redirect_to` (ApiError.redirectTo).
   */
  create: async (body: FlowCreate, signal?: AbortSignal) => (await request<FlowEnvelope>("/v1/flows", { method: "POST", body, signal })).flow,
  /** `GET /v1/flows/{id}` (flow cookie). Also finalizes a Google/Apple leg. Idempotent after completion. */
  get: async (id: string, signal?: AbortSignal) => (await request<FlowEnvelope>(`/v1/flows/${seg(id)}`, { signal, quiet401: true })).flow,
  /** Continue as the browser's signed-in account. */
  continueAs: (id: string) => flowCall(`/v1/flows/${seg(id)}/continue`),
  /** Forget the chosen account for this flow (back to choose_method). */
  switchAccount: (id: string) => flowCall(`/v1/flows/${seg(id)}/switch`),
  /** Send a sign-in code to an email. */
  email: (id: string, email: string) => flowCall(`/v1/flows/${seg(id)}/email`, { email }),
  /** Send a sign-in code by SMS; `country` is the default for local-format numbers (omit it for "+CC…" numbers). */
  phone: (id: string, phone: string, country?: string) => flowCall(`/v1/flows/${seg(id)}/phone`, { phone, country }),
  /** Resend the current challenge (counts toward the send limit). */
  resend: (id: string) => flowCall(`/v1/flows/${seg(id)}/resend`),
  /** Verify the 6-digit code. Errors: invalid_code (422, remaining_attempts), code_expired (410), verification_locked (423). */
  verify: (id: string, code: string) => flowCall(`/v1/flows/${seg(id)}/verify`, { code }),
  /** Start Google or Apple: navigate the top-level window to the returned `authorize_url`. */
  oauthStart: (id: string, provider: "google" | "apple") => request<{ authorize_url: string }>(`/v1/flows/${seg(id)}/oauth/${provider}`, { method: "POST", body: {} }),
  /**
   * `POST /v1/flows/{id}/signup/photo` (201, flow and sign-up cookies): the photo picked on the sign-up page (PNG, JPEG,
   * WebP or GIF, ≤ 2 MB). It replaces an earlier one and becomes the prefilled `signup.pfp_url`; the account takes it
   * when it is created (`pfp_url: null` in the sign-up discards it). 403 signup_not_bound, 409 invalid_step, 413/415/422.
   */
  uploadSignupPhoto: (id: string, file: Blob) =>
    request<SignupPhoto>(`/v1/flows/${seg(id)}/signup/photo`, { method: "POST", raw: file, contentType: file.type || "application/octet-stream" }),
  /** Create the account (or finish an imported one). 409 id_taken with details.suggestions. */
  signup: (id: string, body: SignupSubmit) => flowCall(`/v1/flows/${seg(id)}/signup`, body),
  /** Send a code to add a missing required email. 409 email_in_use. */
  requirementEmail: (id: string, email: string) => flowCall(`/v1/flows/${seg(id)}/requirements/email`, { email }),
  /** Send a code to add a missing required phone. 409 phone_in_use. */
  requirementPhone: (id: string, phone: string, country?: string) => flowCall(`/v1/flows/${seg(id)}/requirements/phone`, { phone, country }),
  /** Verify the requirement code; the email/phone is added to the account. */
  requirementVerify: (id: string, code: string) => flowCall(`/v1/flows/${seg(id)}/requirements/verify`, { code }),
  /** Approve (with the chosen optional scopes) or decline what is shared. */
  consent: (id: string, body: ConsentSubmit) => flowCall(`/v1/flows/${seg(id)}/consent`, body),
};

/** The /authorize URL an app sends a browser to (also what /sign-in builds for the account site itself). */
export function authorizeUrl(params: FlowCreate, base = ""): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
  return `${base}/authorize?${query.toString()}`;
}

/* --------------------------------------- browser session, device, CLI --------------------------------------- */

export const session = {
  /** `GET /v1/session`: resolves null when there is no session (the server answers 401). */
  get: async (signal?: AbortSignal): Promise<BrowserSession | null> => {
    try {
      return await request<BrowserSession>("/v1/session", { signal, quiet401: true });
    } catch (error) {
      if (error instanceof Error && "status" in error && (error as { status: number }).status === 401) return null;
      throw error;
    }
  },
  /** `POST /v1/session/signout` (204): revokes this browser session and clears its cookies (also a waiting sign-up). */
  signOut: () => request<null>("/v1/session/signout", { method: "POST", body: {}, quiet401: true }),
};

export const device = {
  /** `POST /v1/device/authorize` (public): starts the CLI device flow. */
  authorize: (clientLabel?: string) => request<DeviceAuthorization>("/v1/device/authorize", { method: "POST", body: { client_label: clientLabel } }),
  /** `GET /v1/device/{user_code}` (Carbon session; case-insensitive, dash optional). 404/409/410 as documented. */
  get: (userCode: string) => request<DeviceRequest>(`/v1/device/${seg(userCode)}`),
  /** 204. A Silicon session gets 403 carbon_only. */
  approve: (userCode: string) => request<null>(`/v1/device/${seg(userCode)}/approve`, { method: "POST", body: {} }),
  deny: (userCode: string) => request<null>(`/v1/device/${seg(userCode)}/deny`, { method: "POST", body: {} }),
};

export const cliLogin = {
  /** `POST /v1/cli/login/start`: existing active Carbons only (404 account_not_found otherwise). */
  start: (contact: { email: string } | { phone: string; country?: string }) => request<CliLoginChallenge>("/v1/cli/login/start", { method: "POST", body: contact }),
  /** `POST /v1/cli/login/verify`: first-party token response (aud=accounts). */
  verify: (challengeId: string, code: string, clientLabel?: string) =>
    request<TokenResponse>("/v1/cli/login/verify", { method: "POST", body: { challenge_id: challengeId, code, client_label: clientLabel } }),
};

/* --------------------------------------------- my account --------------------------------------------- */

export const me = {
  /** `GET /v1/me`: the full own view (Carbon or Silicon). */
  get: (signal?: AbortSignal) => request<Me>("/v1/me", { signal }),
  /** `PATCH /v1/me` → Me. Silicons cannot change dob (422 dob_immutable); unknown fields answer 422. */
  update: (patch: ProfileUpdate) => request<Me>("/v1/me", { method: "PATCH", body: patch }),
  /** `POST /v1/me/photo` (201): PNG, JPEG, WebP or GIF, ≤ 2 MB, ≤ 8192 px per side, 20 per hour. */
  uploadPhoto: (file: Blob, options?: CallOptions) =>
    request<PhotoUploaded>("/v1/me/photo", { method: "POST", raw: file, contentType: file.type || "application/octet-stream", idempotencyKey: options?.idempotencyKey, signal: options?.signal }),
  /** `DELETE /v1/me/photo` → Me (back to the default photo). */
  removePhoto: () => request<Me>("/v1/me/photo", { method: "DELETE" }),
  /**
   * `POST /v1/me/id` → Me. 409 id_taken (details.suggestions) / id_reserved (details.reserved_until), 422 invalid_id,
   * 429 rate_limited after 5 changes per rolling 24 h. The old id stays reserved for you for 10 days.
   */
  changeId: (id: string) => request<Me>("/v1/me/id", { method: "POST", body: { id } }),
  /** `DELETE /v1/me` (204). 409 custodian_of_silicons (details.silicons) while you are custodian of any Silicon. */
  deleteAccount: (confirm: string) => request<null>("/v1/me", { method: "DELETE", body: { confirm } }),

  emails: {
    /** `GET /v1/me/emails` (no paging; the items). */
    list: async () => items(await request<Page<EmailView>>("/v1/me/emails")),
    /** Sends a code (409 email_in_use / email_already_added, 422 email_limit_reached at 10). */
    add: (email: string) => request<ContactChallenge>("/v1/me/emails", { method: "POST", body: { email } }),
    /** Adds the verified email; answers the whole list. Wrong codes count per address (422 / 423 like the flow). */
    verify: async (challengeId: string, code: string) => items(await request<Page<EmailView>>("/v1/me/emails/verify", { method: "POST", body: { challenge_id: challengeId, code } })),
    makePrimary: async (email: string) => items(await request<Page<EmailView>>(`/v1/me/emails/${seg(email)}/primary`, { method: "POST", body: {} })),
    /** 409 cannot_remove_primary. */
    remove: async (email: string) => items(await request<Page<EmailView>>(`/v1/me/emails/${seg(email)}`, { method: "DELETE" })),
  },

  phones: {
    list: async () => items(await request<Page<PhoneView>>("/v1/me/phones")),
    /** `country` is the default for local-format numbers; omit it for a number written with its "+CC" calling code. */
    add: (phone: string, country?: string) => request<ContactChallenge>("/v1/me/phones", { method: "POST", body: { phone, country } }),
    verify: async (challengeId: string, code: string) => items(await request<Page<PhoneView>>("/v1/me/phones/verify", { method: "POST", body: { challenge_id: challengeId, code } })),
    makePrimary: async (phone: string) => items(await request<Page<PhoneView>>(`/v1/me/phones/${seg(phone)}/primary`, { method: "POST", body: {} })),
    remove: async (phone: string) => items(await request<Page<PhoneView>>(`/v1/me/phones/${seg(phone)}`, { method: "DELETE" })),
  },

  identities: {
    list: async () => items(await request<Page<IdentityView>>("/v1/me/identities")),
    /** 409 last_sign_in_method when it is the only way left to sign in. */
    remove: (provider: "google" | "apple", subject: string) => request<null>(`/v1/me/identities/${seg(provider)}/${seg(subject)}`, { method: "DELETE" }),
  },

  apps: {
    /** Apps I have signed into (the first-party `accounts` is never listed). */
    list: (query?: PageQuery) => request<Page<MyApp>>("/v1/me/apps", { query: pageQuery(query) }),
    /** Removes an app's access (204): its sessions and User verification proofs about me are revoked and it is told. */
    removeAccess: (appId: string) => request<null>(`/v1/me/apps/${seg(appId)}`, { method: "DELETE" }),
  },

  sessions: {
    /** Browser sessions and first-party (CLI / Silicon) sign-ins. */
    list: (query?: PageQuery) => request<Page<SessionInfo>>("/v1/me/sessions", { query: pageQuery(query) }),
    revoke: (id: string) => request<null>(`/v1/me/sessions/${seg(id)}`, { method: "DELETE" }),
  },

  /** Sign-ins, id changes, custodian changes, proofs, app access and security events, newest first. */
  history: (query?: HistoryQuery) => request<Page<HistoryItem>>("/v1/me/history", { query: { ...pageQuery(query), kind: query?.kind } }),

  proofs: {
    /** User verification proofs issued on my behalf. */
    list: (query?: PageQuery) => request<Page<MyProof>>("/v1/me/proofs", { query: pageQuery(query) }),
    revoke: (proofId: string) => request<null>(`/v1/me/proofs/${seg(proofId)}`, { method: "DELETE" }),
  },

  appProofs: (query?: ManagedAppProofsQuery) => request<Page<ManagedAppProof>>("/v1/me/app-verifications", {
    query: { ...pageQuery(query), app_id: query?.app_id, status: query?.status },
  }),

  /** `POST /v1/me/short-lived-tokens`: a 2-minute, single-use token an app exchanges for this account's tokens. */
  shortLivedToken: (appId: string) => request<ShortLivedToken>("/v1/me/short-lived-tokens", { method: "POST", body: { app_id: appId } }),

  /** A Silicon's own webhook (session(silicon)). */
  webhook: {
    set: (url: string) => request<SiliconWebhook>("/v1/me/webhook", { method: "PUT", body: { url } }),
    remove: () => request<null>("/v1/me/webhook", { method: "DELETE" }),
    /** 202. 409 webhook_not_set; 10 per hour. */
    test: () => request<SiliconWebhookTestQueued>("/v1/me/webhook/test", { method: "POST", body: {} }),
  },

  /** Apps this Carbon owns (developer area). */
  ownedApps: (query?: PageQuery) => request<Page<OwnedApp>>("/v1/me/owned-apps", { query: pageQuery(query) }),

  /** Silicons this Carbon is custodian of. `{uuid}` accepts the si:id too. Unknown body fields answer 422. */
  silicons: {
    list: (query?: PageQuery) => request<Page<ManagedSilicon>>("/v1/me/silicons", { query: pageQuery(query) }),
    /** Creates a Silicon with me as custodian (201). A generated STK is in the answer exactly once. */
    create: (body: CreateSilicon, options?: CallOptions) => request<SiliconCreated>("/v1/me/silicons", { method: "POST", body, idempotencyKey: options?.idempotencyKey, signal: options?.signal }),
    get: (uuid: string) => request<ManagedSilicon>(`/v1/me/silicons/${seg(uuid)}`),
    update: (uuid: string, patch: UpdateSilicon) => request<ManagedSilicon>(`/v1/me/silicons/${seg(uuid)}`, { method: "PATCH", body: patch }),
    /** Shares the 5-changes-per-24-hours limit with the Silicon's own POST /v1/me/id (429). */
    changeId: (uuid: string, id: string) => request<ManagedSilicon>(`/v1/me/silicons/${seg(uuid)}/id`, { method: "POST", body: { id } }),
    /** `POST /v1/me/silicons/{uuid}/photo` (201): the custodian uploads the Silicon's photo (same rules as /v1/me/photo). */
    uploadPhoto: (uuid: string, file: Blob, options?: CallOptions) =>
      request<SiliconPhotoUploaded>(`/v1/me/silicons/${seg(uuid)}/photo`, { method: "POST", raw: file, contentType: file.type || "application/octet-stream", idempotencyKey: options?.idempotencyKey, signal: options?.signal }),
    setWebhook: (uuid: string, url: string) => request<SiliconWebhook>(`/v1/me/silicons/${seg(uuid)}/webhook`, { method: "PUT", body: { url } }),
    removeWebhook: (uuid: string) => request<null>(`/v1/me/silicons/${seg(uuid)}/webhook`, { method: "DELETE" }),
    /** Kills the old STK at once and signs the Silicon out everywhere. Omit `stk` to generate one (shown once). */
    rotateStk: (uuid: string, stk?: string, options?: CallOptions) =>
      request<StkRotated>(`/v1/me/silicons/${seg(uuid)}/stk`, { method: "POST", body: stk ? { stk } : {}, idempotencyKey: options?.idempotencyKey, signal: options?.signal }),
    /**
     * Asks another Carbon (`c:id` or email) to take over (201); they have 14 days to accept. 409 transfer_pending,
     * 422 transfer_to_self, 404 custodian_not_found, 429 after 30 per hour.
     */
    transfer: async (uuid: string, to: string) => (await request<{ request: TransferRequest }>(`/v1/me/silicons/${seg(uuid)}/transfer`, { method: "POST", body: { to } })).request,
    cancelTransfer: (uuid: string) => request<null>(`/v1/me/silicons/${seg(uuid)}/transfer`, { method: "DELETE" }),
    /** Deletes the Silicon account (204); `confirm` must be its si:id. */
    remove: (uuid: string, confirm: string) => request<null>(`/v1/me/silicons/${seg(uuid)}`, { method: "DELETE", body: { confirm } }),
  },

  /** Custodian requests addressed to me (by uuid or any verified email of mine). */
  custodianRequests: {
    list: (query?: PageQuery) => request<Page<CustodianRequest>>("/v1/me/custodian-requests", { query: pageQuery(query) }),
    /** 204. 404 custodian_request_not_found, 409 custodian_request_not_pending, 410 custodian_request_expired… */
    accept: (id: string) => request<null>(`/v1/me/custodian-requests/${seg(id)}/accept`, { method: "POST", body: {} }),
    decline: (id: string) => request<null>(`/v1/me/custodian-requests/${seg(id)}/decline`, { method: "POST", body: {} }),
  },
};

/* ---------------------------------------------- Silicons (public) ---------------------------------------------- */

export const silicons = {
  /** `POST /v1/silicons` (201): a Silicon creates its own account and names a custodian (c:id or email). */
  selfCreate: (body: SiliconSelfCreate, options?: CallOptions) => request<SiliconSelfCreated>("/v1/silicons", { method: "POST", body, idempotencyKey: options?.idempotencyKey, signal: options?.signal }),
  /** `GET /v1/silicons/requests/{id}` with the `sarq_…` request token. */
  requestStatus: (id: string, requestToken: string) => request<CustodianRequestStatus>(`/v1/silicons/requests/${seg(id)}`, { auth: { bearer: requestToken } }),
  /** `POST /v1/silicons/login`: si:id + STK → first-party tokens. 401 invalid_credentials, 403 custodian_pending, 423 login_locked. */
  login: (id: string, stk: string, clientLabel?: string) => request<TokenResponse>("/v1/silicons/login", { method: "POST", body: { id, stk, client_label: clientLabel } }),
};

/* --------------------------------------------------- apps --------------------------------------------------- */

/** For app-or-owner endpoints: the owner's session (default) or the app's own credentials. */
type Owner = AppCredentials | undefined;
const ownerAuth = (credentials: Owner) => (credentials ? asApp(credentials) : undefined);
type OwnerCall = CallOptions & { credentials?: AppCredentials };

export const apps = {
  /** `GET /v1/apps/{app_id}/public` (CORS *). */
  public: (appId: string, signal?: AbortSignal) => request<AppPublic>(`/v1/apps/${seg(appId)}/public`, { signal }),
  /** `GET /v1/apps/{app_id}`: config with secrets masked, webhook, stats. 403 not_app_owner / app_mismatch. */
  get: (appId: string, credentials?: Owner) => request<AppDetail>(`/v1/apps/${seg(appId)}`, { auth: ownerAuth(credentials) }),
  accountVerification: {
    get: (appId: string) => request<AccountVerificationRequestState>(`/v1/apps/${seg(appId)}/account-verification-request`),
    submit: (appId: string, reason: string, options?: CallOptions) => request<AccountVerificationRequestResult>(`/v1/apps/${seg(appId)}/account-verification-request`, { method: "POST", body: { reason }, idempotencyKey: options?.idempotencyKey }),
  },
  /** `PATCH /v1/apps/{app_id}/signin-config`: deep merge; 422 with details.fields; 409 config_version_conflict. */
  updateSigninConfig: (appId: string, patch: SigninConfigPatch, options?: OwnerCall) =>
    request<AppDetail>(`/v1/apps/${seg(appId)}/signin-config`, { method: "PATCH", body: patch, idempotencyKey: options?.idempotencyKey, auth: ownerAuth(options?.credentials), signal: options?.signal }),
  configHistory: (appId: string, query?: PageQuery, credentials?: Owner) =>
    request<Page<ConfigHistoryItem>>(`/v1/apps/${seg(appId)}/signin-config/history`, { query: pageQuery(query), auth: ownerAuth(credentials) }),

  users: (appId: string, query?: AppUsersQuery, credentials?: Owner) =>
    request<Page<AppUser>>(`/v1/apps/${seg(appId)}/users`, { query: { ...pageQuery(query), q: query?.q, status: query?.status, kind: query?.kind, source: query?.source }, auth: ownerAuth(credentials) }),
  /** One member with its last 20 sign-ins. 404 user_not_found. */
  user: (appId: string, uuid: string, credentials?: Owner) => request<AppUserDetail>(`/v1/apps/${seg(appId)}/users/${seg(uuid)}`, { auth: ownerAuth(credentials) }),

  imports: {
    /** Starts an import from JSON rows (202). 422 unknown_columns unless options.ignore_unknown_columns. */
    startRows: async (appId: string, rows: ImportRow[], options: ImportOptions = {}, call?: OwnerCall) =>
      (await request<{ job: ImportJob }>(`/v1/apps/${seg(appId)}/imports`, { method: "POST", body: { rows, options }, idempotencyKey: call?.idempotencyKey, auth: ownerAuth(call?.credentials), signal: call?.signal })).job,
    /** Starts an import from CSV text or a file (202); options travel as query parameters. */
    startCsv: async (appId: string, csv: string | Blob, options: ImportOptions = {}, call?: OwnerCall) =>
      (await request<{ job: ImportJob }>(`/v1/apps/${seg(appId)}/imports`, {
        method: "POST",
        raw: csv,
        contentType: "text/csv",
        query: { default_country: options.default_country, ignore_unknown_columns: options.ignore_unknown_columns, dry_run: options.dry_run, update_existing: options.update_existing },
        idempotencyKey: call?.idempotencyKey,
        auth: ownerAuth(call?.credentials),
        signal: call?.signal,
      })).job,
    list: (appId: string, query?: PageQuery, credentials?: Owner) => request<Page<ImportJob>>(`/v1/apps/${seg(appId)}/imports`, { query: pageQuery(query), auth: ownerAuth(credentials) }),
    get: async (appId: string, jobId: string, credentials?: Owner) => (await request<{ job: ImportJob }>(`/v1/apps/${seg(appId)}/imports/${seg(jobId)}`, { auth: ownerAuth(credentials) })).job,
    /** Row results, filterable by outcome and by message level and code. */
    rows: (appId: string, jobId: string, query?: ImportRowsQuery, credentials?: Owner) =>
      request<Page<ImportRowResult>>(`/v1/apps/${seg(appId)}/imports/${seg(jobId)}/rows`, { query: { ...pageQuery(query), outcome: query?.outcome, level: query?.level, code: query?.code }, auth: ownerAuth(credentials) }),
  },

  webhook: {
    /** Sets the URL; a new `whsec_…` secret is returned (shown once) each time. */
    set: (appId: string, url: string, options?: OwnerCall) =>
      request<{ url: string; secret: string }>(`/v1/apps/${seg(appId)}/webhook`, { method: "PUT", body: { url }, idempotencyKey: options?.idempotencyKey, auth: ownerAuth(options?.credentials), signal: options?.signal }),
    /** 204; pending deliveries become failed. */
    remove: (appId: string, credentials?: Owner) => request<null>(`/v1/apps/${seg(appId)}/webhook`, { method: "DELETE", auth: ownerAuth(credentials) }),
    rotateSecret: (appId: string, options?: OwnerCall) =>
      request<{ secret: string }>(`/v1/apps/${seg(appId)}/webhook/rotate-secret`, { method: "POST", body: {}, idempotencyKey: options?.idempotencyKey, auth: ownerAuth(options?.credentials), signal: options?.signal }),
    /** Enqueues a `ping` event (202). */
    test: (appId: string, options?: OwnerCall) =>
      request<WebhookTestQueued>(`/v1/apps/${seg(appId)}/webhook/test`, { method: "POST", body: {}, idempotencyKey: options?.idempotencyKey, auth: ownerAuth(options?.credentials), signal: options?.signal }),
    deliveries: (appId: string, query?: DeliveriesQuery, credentials?: Owner) =>
      request<Page<WebhookDelivery>>(`/v1/apps/${seg(appId)}/webhook/deliveries`, { query: { ...pageQuery(query), status: query?.status }, auth: ownerAuth(credentials) }),
    /** One delivery with its attempts and payload (redacted when the app lost access to the account). */
    delivery: (appId: string, deliveryId: string, credentials?: Owner) => request<WebhookDeliveryDetail>(`/v1/apps/${seg(appId)}/webhook/deliveries/${seg(deliveryId)}`, { auth: ownerAuth(credentials) }),
    /** Re-queues up to 100 deliveries to the current URL with the current secret; skips accounts that lost access (200 with `skipped`). */
    replay: (appId: string, body: ReplayRequest, options?: OwnerCall) =>
      request<ReplayResult>(`/v1/apps/${seg(appId)}/webhook/replay`, { method: "POST", body, idempotencyKey: options?.idempotencyKey, auth: ownerAuth(options?.credentials), signal: options?.signal }),
  },

  proofs: {
    /** Proofs issued by the app. */
    list: (appId: string, query?: AppProofsQuery, credentials?: Owner) =>
      request<Page<AppProof>>(`/v1/apps/${seg(appId)}/proofs`, { query: { ...pageQuery(query), kind: query?.kind, status: query?.status }, auth: ownerAuth(credentials) }),
    history: (appId: string, proofId: string, query?: PageQuery) => request<Page<AppProofHistoryEvent>>(`/v1/apps/${seg(appId)}/proofs/${seg(proofId)}/history`, { query: pageQuery(query) }),
    /** The App verification page stand-in: issue an app-to-app proof for `audiences` (201; tokens shown once). The owner's session is enough. */
    createAppVerification: (appId: string, body: AppVerificationRequest, options?: OwnerCall) =>
      request<IssuedProof>(`/v1/apps/${seg(appId)}/proofs/app-verification`, { method: "POST", body, idempotencyKey: options?.idempotencyKey, auth: ownerAuth(options?.credentials), signal: options?.signal }),
    revoke: (appId: string, proofId: string, credentials?: Owner) => request<null>(`/v1/apps/${seg(appId)}/proofs/${seg(proofId)}`, { method: "DELETE", auth: ownerAuth(credentials) }),
  },
};

/* ------------------------------------------- proofs (app credentials) ------------------------------------------- */

export const proofs = {
  issueUserVerification: (credentials: AppCredentials, body: UserVerificationRequest, options?: CallOptions) =>
    request<IssuedProof>("/v1/proofs/user-verification", { method: "POST", body, auth: asApp(credentials), idempotencyKey: options?.idempotencyKey, signal: options?.signal }),
  issueAppVerification: (credentials: AppCredentials, body: AppVerificationRequest, options?: CallOptions) =>
    request<IssuedProof>("/v1/proofs/app-verification", { method: "POST", body, auth: asApp(credentials), idempotencyKey: options?.idempotencyKey, signal: options?.signal }),
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
  /** `POST /v1/oauth/revoke`: always 200 (RFC 7009). */
  revoke: (token: string, credentials?: AppCredentials, clientId?: string) =>
    request<null>("/v1/oauth/revoke", { method: "POST", raw: formBody({ token, client_id: credentials ? undefined : clientId }), contentType: "application/x-www-form-urlencoded", auth: credentials && asApp(credentials) }),
  introspect: (token: string, credentials: AppCredentials) =>
    request<Introspection>("/v1/oauth/introspect", { method: "POST", raw: formBody({ token }), contentType: "application/x-www-form-urlencoded", auth: asApp(credentials) }),
  /** `GET /v1/userinfo` with an app access token. */
  userinfo: (accessToken: string) => request<UserInfo>("/v1/userinfo", { auth: { bearer: accessToken } }),
};

/* ---------------------------------------- reports, telemetry, dev, internal ---------------------------------------- */

export const reports = {
  /** `POST /v1/reports` (201): mailed to the Silicon Accounts maintainers (5/hour per network). pr_url must be https. */
  create: (message: string, prUrl?: string, options?: CallOptions) =>
    request<ReportReceipt>("/v1/reports", { method: "POST", body: { message, pr_url: prUrl }, idempotencyKey: options?.idempotencyKey, signal: options?.signal, quiet401: true }),
};

export const telemetry = {
  /** `POST /v1/telemetry/events` (202, ≤ 50 events). The opt-out header from lib/telemetry.ts rides along automatically. */
  send: (events: TelemetryEvent[]) => request<null>("/v1/telemetry/events", { method: "POST", body: { events }, quiet401: true }),
};

export const devOutbox = {
  /** `GET /v1/dev/outbox`: only when the server exposes it (never in production; 404 otherwise). */
  list: (query?: { to?: string; purpose?: string; limit?: number }) => request<Page<OutboxMessage>>("/v1/dev/outbox", { query }),
};

export const internal = {
  /** `POST /v1/internal/apps/sync`: the Silicon Apps stand-in (service token). */
  syncApps: (internalToken: string, appsToSync: SiliconAppsApp[]) => request<unknown>("/v1/internal/apps/sync", { method: "POST", body: { apps: appsToSync }, auth: { bearer: internalToken } }),
};

/** Everything, as one object: `api.me.get()`, `api.flows.verify(id, code)`… */
export const api = { meta, ids, accounts, flows, session, device, cliLogin, me, silicons, apps, proofs, oauth, reports, telemetry, devOutbox, internal };
export type Api = typeof api;

/** Narrowing helper: the Carbon view of Me (throws a precise error for a Silicon). */
export function carbonOnly(value: Me): Extract<Me, { kind: "carbon" }> {
  if (value.kind !== "carbon") throw new Error(`This page is for Carbons; ${value.id ?? value.uuid} is a Silicon.`);
  return value;
}
