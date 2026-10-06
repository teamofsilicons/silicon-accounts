/**
 * The typed Silicon Accounts API client for the web app.
 *
 *   import { api, ApiError, createAction } from "../../api";
 *   const me = await api.me.get();
 *   const save = createAction(api.me.update, { report: "Could not save your profile" });
 *
 * Same-origin, cookies included, JSON in and out. Failures reject with ApiError (status, code, message, hint,
 * details, requestId, retryAfter). See web/README.md for conventions.
 */
export * from "./types";
export { ApiError, type ApiErrorInit } from "./errors";
export { request, configureApi, apiBaseUrl, newIdempotencyKey, queryString, seg, type RequestOptions, type ApiConfig, type HttpMethod } from "./http";
export {
  api, meta, ids, accounts, flows, session, device, cliLogin, me, silicons, apps, proofs, oauth, reports, telemetry, devOutbox, internal,
  authorizeUrl, carbonOnly, type Api, type AppCredentials, type CallOptions,
} from "./endpoints";
export { createApiResource, createAction, createPagedList, collectPages, reportError, setErrorReporter, type Action, type ActionOptions, type PagedList } from "./solid";
