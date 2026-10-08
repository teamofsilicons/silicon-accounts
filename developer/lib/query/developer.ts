"use client";

/**
 * Queries and mutations for the developer site (/, /apps/[appId]/[[...tab]]): owned apps, an app's sign-in setup with
 * optimistic concurrency, its user base, imports, webhook deliveries and ATA proofs. Every call goes through the BFF.
 *
 * Saving the sign-in setup: send `expected_version` (the version the draft started from); a 409
 * `config_version_conflict` means someone saved in between. Never move the draft's base version silently after a
 * reload: that turns a conflict into a lost update (a review finding on the Solid build).
 */
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/endpoints";
import type { AppDetail, AppProofsQuery, AppUsersQuery, AtaRequest, DeliveriesQuery, ImportJob, ImportOptions, ImportRow, ImportRowsQuery, ManagedAppProofsQuery, ReplayRequest, SigninConfigPatch } from "../api/types";
import { useIdempotentMutation, useSecretMutation } from "./idempotency";
import { queryKeys } from "./keys";
import { useWholeList } from "./pages";
import { useSession } from "./session";

/** Every app this Carbon owns (the whole list). */
export function useOwnedApps() {
  const { status } = useSession();
  return useWholeList(queryKeys.me.ownedApps, query => api.me.ownedApps(query), status === "signed_in");
}

/** An app with its sign-in setup (secrets masked), webhook and stats. 403 not_app_owner, 404 unknown_app. */
export function useApp(appId: string | null) {
  return useQuery({ queryKey: queryKeys.app.detail(appId ?? ""), queryFn: () => api.apps.get(appId ?? ""), enabled: !!appId });
}

/** The public config the hosted pages, the iframe and the SDK read (CORS *). */
export function useAppPublic(appId: string | null) {
  return useQuery({ queryKey: queryKeys.app.public(appId ?? ""), queryFn: ({ signal }) => api.apps.public(appId ?? "", signal), enabled: !!appId });
}

/**
 * Saves part of the sign-in setup. Pass `expected_version` in the patch. The answer is the whole app, stored in the
 * cache; the version history and the public config are refreshed. Same patch, same Idempotency-Key until it succeeds.
 */
export function useUpdateSigninConfig(appId: string) {
  const client = useQueryClient();
  return useIdempotentMutation((patch: SigninConfigPatch, idempotencyKey) => api.apps.updateSigninConfig(appId, patch, { idempotencyKey }), {
    onSuccess: detail => {
      client.setQueryData<AppDetail>(queryKeys.app.detail(appId), detail);
      void client.invalidateQueries({ queryKey: queryKeys.app.configHistory(appId) });
      void client.invalidateQueries({ queryKey: queryKeys.app.public(appId) });
    },
    meta: { errorTitle: "Could not save the sign-in setup" },
  });
}

export function useConfigHistory(appId: string, options: { enabled?: boolean } = {}) {
  return useInfiniteQuery({
    queryKey: queryKeys.app.configHistory(appId),
    queryFn: ({ pageParam }) => api.apps.configHistory(appId, { limit: 50, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: page => page.next_cursor,
    enabled: options.enabled !== false,
  });
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* User base and imports                                                                                               */
/* ------------------------------------------------------------------------------------------------------------------ */

export function useAppUsers(appId: string, query: Omit<AppUsersQuery, "cursor" | "limit"> = {}) {
  return useInfiniteQuery({
    queryKey: queryKeys.app.users(appId, query),
    queryFn: ({ pageParam }) => api.apps.users(appId, { ...query, limit: 50, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: page => page.next_cursor,
  });
}

export function useAppUser(appId: string, uuid: string | null) {
  return useQuery({ queryKey: queryKeys.app.user(appId, uuid ?? ""), queryFn: () => api.apps.user(appId, uuid ?? ""), enabled: !!uuid });
}

export function useImports(appId: string) {
  return useQuery({ queryKey: queryKeys.app.imports(appId), queryFn: () => api.apps.imports.list(appId, { limit: 50 }) });
}

const runningJob = (job: ImportJob | undefined) => !!job && (job.status === "queued" || job.status === "running");

/** One import job, polled every second while it is queued or running (the poll stops with the component). */
export function useImport(appId: string, jobId: string | null) {
  return useQuery({
    queryKey: queryKeys.app.import(appId, jobId ?? ""),
    queryFn: () => api.apps.imports.get(appId, jobId ?? ""),
    enabled: !!jobId,
    refetchInterval: query => (runningJob(query.state.data) ? 1000 : false),
  });
}

export function useImportRows(appId: string, jobId: string | null, query: Omit<ImportRowsQuery, "cursor" | "limit"> = {}) {
  return useInfiniteQuery({
    queryKey: queryKeys.app.importRows(appId, jobId ?? "", query),
    queryFn: ({ pageParam }) => api.apps.imports.rows(appId, jobId ?? "", { ...query, limit: 100, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: page => page.next_cursor,
    enabled: !!jobId,
  });
}

export type StartImport =
  | { kind: "csv"; csv: string | Blob; options: ImportOptions }
  | { kind: "rows"; rows: ImportRow[]; options: ImportOptions };

/** Starts an import (202 {job}). The same file and options keep one Idempotency-Key until the import starts. */
export function useStartImport(appId: string) {
  const client = useQueryClient();
  return useIdempotentMutation((input: StartImport, idempotencyKey) =>
    input.kind === "csv"
      ? api.apps.imports.startCsv(appId, input.csv, input.options, { idempotencyKey })
      : api.apps.imports.startRows(appId, input.rows, input.options, { idempotencyKey }), {
    onSuccess: job => {
      client.setQueryData(queryKeys.app.import(appId, job.id), job);
      void client.invalidateQueries({ queryKey: queryKeys.app.imports(appId) });
    },
    meta: { errorTitle: "Could not start the import" },
  });
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Webhook                                                                                                             */
/* ------------------------------------------------------------------------------------------------------------------ */

export function useWebhookDeliveries(appId: string, query: Omit<DeliveriesQuery, "cursor" | "limit"> = {}) {
  return useInfiniteQuery({
    queryKey: queryKeys.app.deliveries(appId, query),
    queryFn: ({ pageParam }) => api.apps.webhook.deliveries(appId, { ...query, limit: 50, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: page => page.next_cursor,
  });
}

export function useWebhookDelivery(appId: string, deliveryId: string | null) {
  return useQuery({ queryKey: queryKeys.app.delivery(appId, deliveryId ?? ""), queryFn: () => api.apps.webhook.delivery(appId, deliveryId ?? ""), enabled: !!deliveryId });
}

function useRefreshApp(appId: string) {
  const client = useQueryClient();
  return () => {
    void client.invalidateQueries({ queryKey: queryKeys.app.detail(appId) });
    void client.invalidateQueries({ queryKey: queryKeys.app.root(appId).concat("deliveries") });
  };
}

/**
 * Sets the webhook URL: `run(url)`. The answer's `secret` (whsec_…) is shown once, so this is a secret mutation (never
 * cached). Pass `{ toast: false }` to explain a refused URL beside the field instead of in a toast.
 */
export function useSetWebhook(appId: string, meta: { toast?: boolean } = {}) {
  const refresh = useRefreshApp(appId);
  return useSecretMutation((url: string, idempotencyKey) => api.apps.webhook.set(appId, url, { idempotencyKey }), { onSuccess: refresh, meta: { errorTitle: "Could not set the webhook", ...meta } });
}

export function useRemoveWebhook(appId: string) {
  const refresh = useRefreshApp(appId);
  return useMutation({ mutationFn: () => api.apps.webhook.remove(appId), onSuccess: refresh, meta: { errorTitle: "Could not remove the webhook" } });
}

/**
 * Rotates the signing secret: `run()`. The new one is shown once (a secret mutation, never cached). One rotation per
 * press, even when the answer is lost (the retry reuses the key and the server replays the answer).
 */
export function useRotateWebhookSecret(appId: string) {
  const refresh = useRefreshApp(appId);
  return useSecretMutation((_: void, idempotencyKey) => api.apps.webhook.rotateSecret(appId, { idempotencyKey }), { onSuccess: refresh, meta: { errorTitle: "Could not rotate the secret" } });
}

/** Enqueues a `ping`. */
export function useTestWebhook(appId: string) {
  const refresh = useRefreshApp(appId);
  return useIdempotentMutation((_: void, idempotencyKey) => api.apps.webhook.test(appId, { idempotencyKey }), { onSuccess: refresh, meta: { errorTitle: "Could not send the test" } });
}

/**
 * Replays deliveries. A 200 can still skip some (`skipped` with a reason): read it, a skipped delivery was not queued.
 */
export function useReplayDeliveries(appId: string) {
  const client = useQueryClient();
  return useIdempotentMutation((body: ReplayRequest, idempotencyKey) => api.apps.webhook.replay(appId, body, { idempotencyKey }), {
    onSuccess: () => void client.invalidateQueries({ queryKey: queryKeys.app.root(appId).concat("deliveries") }),
    meta: { errorTitle: "Could not replay the deliveries" },
  });
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Proofs                                                                                                              */
/* ------------------------------------------------------------------------------------------------------------------ */

export function useAppProofs(appId: string, query: Omit<AppProofsQuery, "cursor" | "limit"> = {}) {
  return useInfiniteQuery({
    queryKey: queryKeys.app.proofs(appId, query),
    queryFn: ({ pageParam }) => api.apps.proofs.list(appId, { ...query, limit: 50, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: page => page.next_cursor,
  });
}

export function useManagedAppProofs(query: Omit<ManagedAppProofsQuery, "cursor" | "limit"> = {}) {
  return useInfiniteQuery({
    queryKey: queryKeys.me.appProofs(query),
    queryFn: ({ pageParam }) => api.me.appProofs({ ...query, limit: 50, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: page => page.next_cursor,
  });
}

export function useAppProofHistory(appId: string, proofId: string, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: queryKeys.app.proofHistory(appId, proofId),
    queryFn: ({ pageParam }) => api.apps.proofs.history(appId, proofId, { limit: 50, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: page => page.next_cursor,
    enabled,
  });
}

/**
 * Issues an app-to-app proof for exactly one receiving app: `run({ receiving_app, scopes, access_ttl_seconds })`. Its proof token and refresh token are shown once, so this is a secret
 * mutation (never cached). The same request keeps one key, so a retry never issues twice. Pass `{ toast: false }` to
 * explain a refusal in place.
 */
export function useCreateAta(appId: string, meta: { toast?: boolean } = {}) {
  const client = useQueryClient();
  return useSecretMutation((body: AtaRequest, idempotencyKey) => api.apps.proofs.createAta(appId, body, { idempotencyKey }), {
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.app.root(appId).concat("proofs") }),
        client.invalidateQueries({ queryKey: queryKeys.me.appProofsRoot }),
      ]);
    },
    meta: { errorTitle: "Could not issue the proof", ...meta },
  });
}

export function useRevokeAppProof(appId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (proofId: string) => api.apps.proofs.revoke(appId, proofId),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.app.root(appId).concat("proofs") }),
        client.invalidateQueries({ queryKey: queryKeys.me.appProofsRoot }),
      ]);
    },
    meta: { errorTitle: "Could not revoke the proof" },
  });
}
