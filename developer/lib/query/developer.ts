"use client";

/**
 * Queries and mutations for the developer site (/, /apps/[appId]/[[...tab]]): owned apps, an app's sign-in setup with
 * optimistic concurrency, its user base, imports, webhook deliveries and App verification proofs. Every call goes through the BFF.
 */
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/endpoints";
import type { AppVerificationRequest, ManagedAppProofsQuery } from "../api/types";
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

export function useAccountVerificationRequest(appId: string) {
  return useQuery({ queryKey: queryKeys.me.accountVerification(appId), queryFn: () => api.apps.accountVerification.get(appId) });
}

export function useRequestAccountVerification(appId: string) {
  const client = useQueryClient();
  return useIdempotentMutation((reason: string, idempotencyKey) => api.apps.accountVerification.submit(appId, reason, { idempotencyKey }), {
    onSuccess: async result => {
      client.setQueryData(queryKeys.me.accountVerification(appId), result);
      await client.invalidateQueries({ queryKey: queryKeys.me.accountVerificationRoot });
    },
    meta: { toast: false },
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

export function useAppUser(appId: string, uuid: string | null) {
  return useQuery({ queryKey: queryKeys.app.user(appId, uuid ?? ""), queryFn: () => api.apps.user(appId, uuid ?? ""), enabled: !!uuid });
}

export function useImports(appId: string) {
  return useQuery({ queryKey: queryKeys.app.imports(appId), queryFn: () => api.apps.imports.list(appId, { limit: 50 }) });
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Webhook                                                                                                             */
/* ------------------------------------------------------------------------------------------------------------------ */

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
 * Sets the webhook URL: `run(url)`. The stored signing secret is kept (`secret` null); when none was stored, the answer's
 * new `secret` (whsec_…) is shown once, so this is a secret mutation (never cached). Pass `{ toast: false }` to explain
 * a refused URL beside the field instead of in a toast.
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

/* ------------------------------------------------------------------------------------------------------------------ */
/* Proofs                                                                                                              */
/* ------------------------------------------------------------------------------------------------------------------ */

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
export function useCreateAppVerification(appId: string, meta: { toast?: boolean } = {}) {
  const client = useQueryClient();
  return useSecretMutation((body: AppVerificationRequest, idempotencyKey) => api.apps.proofs.createAppVerification(appId, body, { idempotencyKey }), {
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
