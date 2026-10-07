/**
 * The typed Silicon Accounts API client (framework-free).
 *
 *   import { api, ApiError } from "@/lib/api";
 *   const me = await api.me.get();
 *
 * In components, use the TanStack Query hooks in lib/query instead of calling these directly: they share the cache,
 * toast failures with the server's message and hint, and keep Idempotency-Keys per logical action.
 *
 * Same origin (Next proxies /v1 to the API), cookies included, JSON in and out. Failures reject with ApiError
 * (status, code, message, hint, details, requestId, retryAfter). See web/README.md.
 */
export * from "./types";
export { ApiError, type ApiErrorInit } from "./errors";
export {
  request, configureApi, setApiHeader, apiBaseUrl, newIdempotencyKey, queryString, seg, formBody,
  type RequestOptions, type ApiConfig, type HttpMethod, type QueryValue,
} from "./http";
export {
  api, meta, ids, accounts, flows, session, device, cliLogin, me, silicons, apps, proofs, oauth, reports, telemetry,
  devOutbox, internal, authorizeUrl, carbonOnly, type Api, type AppCredentials, type CallOptions,
} from "./endpoints";
export { PROOF_REVOKE_REASONS, proofRevokeReason, SESSION_ORIGINS } from "./labels";
