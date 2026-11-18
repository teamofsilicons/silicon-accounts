/**
 * The Silicon Accounts API endpoints the developer site calls, as typed functions grouped the way the API is. Shapes
 * are the server's own (see types.ts).
 *
 * Calls that change state take `CallOptions`: pass `idempotencyKey` (keep one per logical action, see
 * lib/query/idempotency.ts) on endpoints the server makes idempotent, and `signal` to cancel.
 */
import { request, seg } from "./http";
import type {
  AccountVerificationRequestResult, AccountVerificationRequestState, AppDetail, AppProof, AppProofHistoryEvent, AppProofsQuery, AppPublic,
  AppUser, AppUserDetail, AppUsersQuery, AppVerificationRequest, ConfigHistoryItem, DeliveriesQuery, ImportJob, ImportOptions, ImportRow,
  ImportRowResult, ImportRowsQuery, IssuedProof, ManagedAppProof, ManagedAppProofsQuery, Me, Meta, OidcDiscovery, OwnedApp, Page, PageQuery,
  ReplayRequest, ReplayResult, SigninConfigPatch, WebhookDelivery, WebhookDeliveryDetail, WebhookTestQueued,
} from "./types";

/** Calls that change state accept an Idempotency-Key and an abort signal. */
export interface CallOptions {
  idempotencyKey?: string;
  signal?: AbortSignal;
}

const pageQuery = (query: PageQuery | undefined) => ({ limit: query?.limit, cursor: query?.cursor ?? undefined });

/* ------------------------------------------------- discovery ------------------------------------------------- */

export const meta = {
  /** `GET /v1/meta`: name, version, environment, public and Silicon Apps URLs, configured providers. */
  get: (signal?: AbortSignal) => request<Meta>("/v1/meta", { signal }),
  /** `GET /.well-known/openid-configuration`. */
  oidcDiscovery: () => request<OidcDiscovery>("/.well-known/openid-configuration"),
};

/* --------------------------------------------- my account --------------------------------------------- */

export const me = {
  /** `GET /v1/me`: the full own view (Carbon or Silicon). */
  get: (signal?: AbortSignal) => request<Me>("/v1/me", { signal }),

  appProofs: (query?: ManagedAppProofsQuery) => request<Page<ManagedAppProof>>("/v1/me/app-verifications", {
    query: { ...pageQuery(query), app_id: query?.app_id, status: query?.status },
  }),

  /** Apps this Carbon owns (developer area). */
  ownedApps: (query?: PageQuery) => request<Page<OwnedApp>>("/v1/me/owned-apps", { query: pageQuery(query) }),
};

/* --------------------------------------------------- apps --------------------------------------------------- */

export const apps = {
  /** `GET /v1/apps/{app_id}/public` (CORS *). */
  public: (appId: string, signal?: AbortSignal) => request<AppPublic>(`/v1/apps/${seg(appId)}/public`, { signal }),
  /** `GET /v1/apps/{app_id}`: config with secrets masked, webhook, stats. 403 not_app_owner / app_mismatch. */
  get: (appId: string) => request<AppDetail>(`/v1/apps/${seg(appId)}`),
  accountVerification: {
    get: (appId: string) => request<AccountVerificationRequestState>(`/v1/apps/${seg(appId)}/account-verification-request`),
    submit: (appId: string, reason: string, options?: CallOptions) => request<AccountVerificationRequestResult>(`/v1/apps/${seg(appId)}/account-verification-request`, { method: "POST", body: { reason }, idempotencyKey: options?.idempotencyKey }),
  },
  /** `PATCH /v1/apps/{app_id}/signin-config`: deep merge; 422 with details.fields; 409 config_version_conflict. */
  updateSigninConfig: (appId: string, patch: SigninConfigPatch, options?: CallOptions) =>
    request<AppDetail>(`/v1/apps/${seg(appId)}/signin-config`, { method: "PATCH", body: patch, idempotencyKey: options?.idempotencyKey, signal: options?.signal }),
  configHistory: (appId: string, query?: PageQuery) =>
    request<Page<ConfigHistoryItem>>(`/v1/apps/${seg(appId)}/signin-config/history`, { query: pageQuery(query) }),

  users: (appId: string, query?: AppUsersQuery) =>
    request<Page<AppUser>>(`/v1/apps/${seg(appId)}/users`, { query: { ...pageQuery(query), q: query?.q, status: query?.status, kind: query?.kind, source: query?.source } }),
  /** One member with its last 20 sign-ins. 404 user_not_found. */
  user: (appId: string, uuid: string) => request<AppUserDetail>(`/v1/apps/${seg(appId)}/users/${seg(uuid)}`),

  imports: {
    /** Starts an import from JSON rows (202). 422 unknown_columns unless options.ignore_unknown_columns. */
    startRows: async (appId: string, rows: ImportRow[], options: ImportOptions = {}, call?: CallOptions) =>
      (await request<{ job: ImportJob }>(`/v1/apps/${seg(appId)}/imports`, { method: "POST", body: { rows, options }, idempotencyKey: call?.idempotencyKey, signal: call?.signal })).job,
    /** Starts an import from CSV text or a file (202); options travel as query parameters. */
    startCsv: async (appId: string, csv: string | Blob, options: ImportOptions = {}, call?: CallOptions) =>
      (await request<{ job: ImportJob }>(`/v1/apps/${seg(appId)}/imports`, {
        method: "POST",
        raw: csv,
        contentType: "text/csv",
        query: { default_country: options.default_country, ignore_unknown_columns: options.ignore_unknown_columns, dry_run: options.dry_run, update_existing: options.update_existing },
        idempotencyKey: call?.idempotencyKey,
        signal: call?.signal,
      })).job,
    list: (appId: string, query?: PageQuery) => request<Page<ImportJob>>(`/v1/apps/${seg(appId)}/imports`, { query: pageQuery(query) }),
    get: async (appId: string, jobId: string) => (await request<{ job: ImportJob }>(`/v1/apps/${seg(appId)}/imports/${seg(jobId)}`)).job,
    /** Row results, filterable by outcome and by message level and code. */
    rows: (appId: string, jobId: string, query?: ImportRowsQuery) =>
      request<Page<ImportRowResult>>(`/v1/apps/${seg(appId)}/imports/${seg(jobId)}/rows`, { query: { ...pageQuery(query), outcome: query?.outcome, level: query?.level, code: query?.code } }),
  },

  webhook: {
    /**
     * Sets the URL and keeps the stored signing secret (`secret` null) and the update picks (`events`, null = every
     * update). A new `whsec_…` secret comes back (shown once) only when none was stored: the first save, or the first
     * after the webhook was removed. `rotateSecret` replaces it.
     */
    set: (appId: string, url: string, options?: CallOptions) =>
      request<{ url: string; secret: string | null; events: string[] | null }>(`/v1/apps/${seg(appId)}/webhook`, { method: "PUT", body: { url }, idempotencyKey: options?.idempotencyKey, signal: options?.signal }),
    /** 204; pending deliveries become failed. */
    remove: (appId: string) => request<null>(`/v1/apps/${seg(appId)}/webhook`, { method: "DELETE" }),
    rotateSecret: (appId: string, options?: CallOptions) =>
      request<{ secret: string }>(`/v1/apps/${seg(appId)}/webhook/rotate-secret`, { method: "POST", body: {}, idempotencyKey: options?.idempotencyKey, signal: options?.signal }),
    /** Enqueues a `ping` event (202). */
    test: (appId: string, options?: CallOptions) =>
      request<WebhookTestQueued>(`/v1/apps/${seg(appId)}/webhook/test`, { method: "POST", body: {}, idempotencyKey: options?.idempotencyKey, signal: options?.signal }),
    deliveries: (appId: string, query?: DeliveriesQuery) =>
      request<Page<WebhookDelivery>>(`/v1/apps/${seg(appId)}/webhook/deliveries`, { query: { ...pageQuery(query), status: query?.status } }),
    /** One delivery with its attempts and payload (redacted when the app lost access to the account). */
    delivery: (appId: string, deliveryId: string) => request<WebhookDeliveryDetail>(`/v1/apps/${seg(appId)}/webhook/deliveries/${seg(deliveryId)}`),
    /** Re-queues up to 100 deliveries to the current URL with the current secret; skips accounts that lost access (200 with `skipped`). */
    replay: (appId: string, body: ReplayRequest, options?: CallOptions) =>
      request<ReplayResult>(`/v1/apps/${seg(appId)}/webhook/replay`, { method: "POST", body, idempotencyKey: options?.idempotencyKey, signal: options?.signal }),
  },

  proofs: {
    /** Proofs issued by the app. */
    list: (appId: string, query?: AppProofsQuery) =>
      request<Page<AppProof>>(`/v1/apps/${seg(appId)}/proofs`, { query: { ...pageQuery(query), kind: query?.kind, status: query?.status } }),
    history: (appId: string, proofId: string, query?: PageQuery) => request<Page<AppProofHistoryEvent>>(`/v1/apps/${seg(appId)}/proofs/${seg(proofId)}/history`, { query: pageQuery(query) }),
    /** The App verification page stand-in: issue an app-to-app proof for `audiences` (201; tokens shown once). The owner's session is enough. */
    createAppVerification: (appId: string, body: AppVerificationRequest, options?: CallOptions) =>
      request<IssuedProof>(`/v1/apps/${seg(appId)}/proofs/app-verification`, { method: "POST", body, idempotencyKey: options?.idempotencyKey, signal: options?.signal }),
    revoke: (appId: string, proofId: string) => request<null>(`/v1/apps/${seg(appId)}/proofs/${seg(proofId)}`, { method: "DELETE" }),
  },
};

/** Everything, as one object: `api.me.get()`, `api.apps.get(appId)`… */
export const api = { meta, me, apps };
