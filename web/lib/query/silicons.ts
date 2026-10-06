"use client";

/**
 * Queries and mutations for Silicons and custodian requests (/silicons, the identity card's counts).
 * Secrets in answers (a generated STK, a webhook secret) are shown exactly once: keep them in component state only
 * (never in the query cache, never in browser storage).
 */
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api } from "../api/endpoints";
import type { CreateSilicon, ManagedSilicon, Page, UpdateSilicon } from "../api/types";
import { useIdempotentMutation } from "./idempotency";
import { queryKeys } from "./keys";
import { useSession } from "./session";

/** Puts a Silicon the server just returned into the list and its own cache entry. */
function storeSilicon(client: QueryClient, silicon: ManagedSilicon): void {
  client.setQueryData(queryKeys.me.silicon(silicon.uuid), silicon);
  client.setQueryData<Page<ManagedSilicon>>(queryKeys.me.silicons, page => page
    ? { ...page, items: page.items.some(item => item.uuid === silicon.uuid) ? page.items.map(item => (item.uuid === silicon.uuid ? silicon : item)) : [...page.items, silicon] }
    : page);
}

function refreshSilicons(client: QueryClient): void {
  void client.invalidateQueries({ queryKey: queryKeys.me.silicons });
  void client.invalidateQueries({ queryKey: queryKeys.me.view });
  void client.invalidateQueries({ queryKey: queryKeys.me.historyRoot });
}

/** Silicons this Carbon is custodian of, in the service's order (account number). */
export function useSilicons() {
  const { status, session } = useSession();
  return useQuery({
    queryKey: queryKeys.me.silicons,
    queryFn: () => api.me.silicons.list({ limit: 200 }),
    enabled: status === "signed_in" && session?.account.kind === "carbon",
  });
}

/** One Silicon (by uuid or si:id). */
export function useSilicon(uuid: string | null) {
  return useQuery({ queryKey: queryKeys.me.silicon(uuid ?? ""), queryFn: () => api.me.silicons.get(uuid ?? ""), enabled: !!uuid });
}

/** Creates a Silicon with me as custodian. The answer's `stk` / `webhook_secret` are shown once. Same input, same key. */
export function useCreateSilicon() {
  const client = useQueryClient();
  return useIdempotentMutation((body: CreateSilicon, idempotencyKey) => api.me.silicons.create(body, { idempotencyKey }), {
    onSuccess: created => {
      storeSilicon(client, created.silicon);
      refreshSilicons(client);
    },
    meta: { errorTitle: "Could not create the Silicon" },
  });
}

export function useUpdateSilicon() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ uuid, patch }: { uuid: string; patch: UpdateSilicon }) => api.me.silicons.update(uuid, patch),
    onSuccess: silicon => storeSilicon(client, silicon),
    meta: { errorTitle: "Could not save the Silicon" },
  });
}

/** Changes a Silicon's si:id (shares the 5-per-24-hours limit with the Silicon's own changes). */
export function useChangeSiliconId() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ uuid, id }: { uuid: string; id: string }) => api.me.silicons.changeId(uuid, id),
    onSuccess: silicon => {
      storeSilicon(client, silicon);
      void client.invalidateQueries({ queryKey: queryKeys.me.historyRoot });
    },
    meta: { errorTitle: "Could not change the Silicon's id" },
  });
}

/** Uploads a Silicon's photo as its custodian (PNG, JPEG, WebP or GIF, ≤ 2 MB). */
export function useUploadSiliconPhoto() {
  const client = useQueryClient();
  return useIdempotentMutation(({ uuid, file }: { uuid: string; file: Blob }, idempotencyKey) => api.me.silicons.uploadPhoto(uuid, file, { idempotencyKey }), {
    onSuccess: result => storeSilicon(client, result.silicon),
    meta: { errorTitle: "Could not upload the photo" },
  });
}

/** Rotates the STK: the old one dies at once and the Silicon is signed out everywhere. A generated STK is shown once. */
export function useRotateStk() {
  const client = useQueryClient();
  return useIdempotentMutation(({ uuid, stk }: { uuid: string; stk?: string }, idempotencyKey) => api.me.silicons.rotateStk(uuid, stk, { idempotencyKey }), {
    onSuccess: (_result, { uuid }) => {
      void client.invalidateQueries({ queryKey: queryKeys.me.silicon(uuid) });
      refreshSilicons(client);
    },
    meta: { errorTitle: "Could not rotate the STK" },
  });
}

export function useSetSiliconWebhook() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ uuid, url }: { uuid: string; url: string }) => api.me.silicons.setWebhook(uuid, url),
    onSuccess: (_result, { uuid }) => {
      void client.invalidateQueries({ queryKey: queryKeys.me.silicon(uuid) });
      void client.invalidateQueries({ queryKey: queryKeys.me.silicons });
    },
    meta: { errorTitle: "Could not set the webhook" },
  });
}

export function useRemoveSiliconWebhook() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (uuid: string) => api.me.silicons.removeWebhook(uuid),
    onSuccess: (_result, uuid) => {
      void client.invalidateQueries({ queryKey: queryKeys.me.silicon(uuid) });
      void client.invalidateQueries({ queryKey: queryKeys.me.silicons });
    },
    meta: { errorTitle: "Could not remove the webhook" },
  });
}

/** Asks another Carbon (c:id or email) to take the Silicon over; they have 14 days to accept. */
export function useTransferSilicon() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ uuid, to }: { uuid: string; to: string }) => api.me.silicons.transfer(uuid, to),
    onSuccess: () => refreshSilicons(client),
    meta: { errorTitle: "Could not start the transfer" },
  });
}

export function useCancelTransfer() {
  const client = useQueryClient();
  return useMutation({ mutationFn: (uuid: string) => api.me.silicons.cancelTransfer(uuid), onSuccess: () => refreshSilicons(client), meta: { errorTitle: "Could not cancel the transfer" } });
}

/** Deletes a Silicon account; `confirm` must be its si:id. */
export function useDeleteSilicon() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ uuid, confirm }: { uuid: string; confirm: string }) => api.me.silicons.remove(uuid, confirm),
    onSuccess: (_result, { uuid }) => {
      client.removeQueries({ queryKey: queryKeys.me.silicon(uuid) });
      refreshSilicons(client);
    },
    meta: { errorTitle: "Could not delete the Silicon" },
  });
}

/** Custodian requests addressed to me (a Silicon's own request, or a transfer to me). */
export function useCustodianRequests() {
  const { status, session } = useSession();
  return useQuery({
    queryKey: queryKeys.me.custodianRequests,
    queryFn: () => api.me.custodianRequests.list({ limit: 200 }),
    enabled: status === "signed_in" && session?.account.kind === "carbon",
  });
}

export function useAcceptCustodianRequest() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.me.custodianRequests.accept(id),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.me.custodianRequests });
      refreshSilicons(client);
    },
    meta: { errorTitle: "Could not accept the request" },
  });
}

export function useDeclineCustodianRequest() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.me.custodianRequests.decline(id),
    onSuccess: () => void client.invalidateQueries({ queryKey: queryKeys.me.custodianRequests }),
    meta: { errorTitle: "Could not decline the request" },
  });
}
