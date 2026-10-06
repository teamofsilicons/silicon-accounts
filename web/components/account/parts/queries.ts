"use client";

/**
 * Account-area reads and actions the shared hooks in lib/query do not cover yet. They go through the typed client
 * (`request` / `api` from lib/api), keep TanStack Query's cache in step, and are listed as requests for the
 * foundation to adopt:
 *
 * - `useIdCheckQuery`: GET /v1/ids/available with `for=<uuid>` (a custodian taking back a Silicon's reserved id).
 * - `useConnectProvider`: POST /v1/me/identities/{google|apple} (connect Google or Apple to the signed-in Carbon).
 * - `useLinkFlow`: GET /v1/flows/{id} for the reason a connection ended (`?link_error=…&flow=…`).
 * - `useSetMeView`: replaces or patches the cached Me view (optimistic edits, answers that carry a new Me).
 * - `useEveryApp`, `useEveryProof`, `useEverySilicon`, `useEveryCustodianRequest`, `useEverySession`: whole lists
 *   (every page of 200, following `next_cursor`), where the shared hooks read the first page only.
 * - `useCreateSiliconOnce`, `useRotateStkOnce`, `useSetSiliconWebhookOnce`: the shared actions whose answers carry a
 *   secret shown once, without TanStack keeping a copy of the answer (or of a chosen STK) after it is handed over.
 * - `useChangeOwnId`, `useChangeSiliconIdInForm`: id changes whose refusals the id form explains in place (no toast).
 */
import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { api } from "@/lib/api/endpoints";
import type { ApiError } from "@/lib/api/errors";
import { request } from "@/lib/api/http";
import type { CreateSilicon, CustodianRequest, EmailView, IdAvailability, ManagedSilicon, Me, MyApp, MyProof, Page, PageQuery, PendingTransfer, PhoneView, Provider, SessionInfo, SiliconCreated, SiliconWebhook, StkRotated, Timestamp, TransferRequest } from "@/lib/api/types";
import { useIdempotentMutation } from "@/lib/query/idempotency";
import { queryKeys } from "@/lib/query/keys";
import { setMe, useSession } from "@/lib/query/session";

/** `GET /v1/ids/available?id=…[&for=…]`, cached per id and subject. Disabled while `id` is null. */
export function useIdCheckQuery(id: string | null, forUuid?: string | null) {
  return useQuery<IdAvailability, ApiError>({
    queryKey: ["ids", "available", id ?? "", forUuid ?? null],
    queryFn: ({ signal }) => request<IdAvailability>("/v1/ids/available", { query: { id: id ?? "", for: forUuid ?? undefined }, signal }),
    enabled: !!id,
    staleTime: 5_000,
    retry: false,
  });
}

export interface ProviderConnection {
  authorize_url: string;
  flow_id: string;
  provider: Provider;
  expires_at: Timestamp;
}

/**
 * Starts connecting Google or Apple to this Carbon: the answer's `authorize_url` is where the browser goes next (a
 * full navigation). The provider sends it back to `returnTo` with `?linked=…&email_added=…` or `?link_error=…`.
 */
export function useConnectProvider() {
  return useMutation<ProviderConnection, ApiError, { provider: Provider; returnTo: string }>({
    mutationFn: ({ provider, returnTo }) => request<ProviderConnection>(`/v1/me/identities/${provider}`, { method: "POST", body: { return_to: returnTo } }),
    meta: { errorTitle: "Could not start connecting it" },
  });
}

/** The flow a provider connection ran in, read for its error (code, message, hint). Never retried, never toasted. */
export function useLinkFlow(flowId: string | null) {
  return useQuery({
    queryKey: queryKeys.flow(flowId ?? ""),
    queryFn: ({ signal }) => api.flows.get(flowId ?? "", signal),
    enabled: !!flowId,
    retry: false,
    staleTime: Infinity,
  });
}

/**
 * Writes to the cached Me view: `set(me)` replaces it with an answer from the server (and the session summary the
 * dock shows), `patch(fn)` edits it in place (optimistic changes; returns the previous value to roll back with).
 */
export function useSetMeView() {
  const client = useQueryClient();
  const set = useCallback((me: Me) => setMe(client, me), [client]);
  const patch = useCallback((change: (me: Me) => Me): Me | undefined => {
    const previous = client.getQueryData<Me>(queryKeys.me.view);
    if (previous) client.setQueryData<Me>(queryKeys.me.view, change(previous));
    return previous;
  }, [client]);
  const refresh = useCallback(() => client.invalidateQueries({ queryKey: queryKeys.me.view }), [client]);
  return { set, patch, refresh };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Removals that show their result first                                                                               */
/* ------------------------------------------------------------------------------------------------------------------ */

/**
 * How long a "Removed" / "Revoked" / "Signed out" result shows in place before the cache changes and the row folds
 * away (or the card moves to the other view).
 */
export const SETTLE_MS = 700;

/**
 * A mutation whose cache update waits `delay` ms after success, so the control that ran it can show its result in place
 * first. Failures toast with `errorTitle` (and reject, for the inline message).
 */
export function useSettledMutation<TData, TVars>(
  fn: (variables: TVars) => Promise<TData>,
  settle: (client: ReturnType<typeof useQueryClient>, data: TData, variables: TVars) => void,
  options: { errorTitle: string; delay?: number },
) {
  const client = useQueryClient();
  return useMutation<TData, ApiError, TVars>({
    mutationFn: fn,
    onSuccess: (data, variables) => {
      window.setTimeout(() => settle(client, data, variables), options.delay ?? SETTLE_MS);
    },
    meta: { errorTitle: options.errorTitle },
  });
}

/** Puts a fresh emails or phones list into the caches (the list and the Me view). */
export function storeContacts(client: ReturnType<typeof useQueryClient>, channel: "email" | "phone", items: EmailView[] | PhoneView[]): void {
  if (channel === "email") {
    client.setQueryData(queryKeys.me.emails, items);
    client.setQueryData<Me>(queryKeys.me.view, me => (me && me.kind === "carbon" ? { ...me, emails: items as EmailView[] } : me));
  } else {
    client.setQueryData(queryKeys.me.phones, items);
    client.setQueryData<Me>(queryKeys.me.view, me => (me && me.kind === "carbon" ? { ...me, phones: (items as PhoneView[]).map(({ phone, is_primary, verified_at }) => ({ phone, is_primary, verified_at })) } : me));
  }
  void client.invalidateQueries({ queryKey: queryKeys.me.view });
}

/** Removes an email or phone number; the row shows "Removed" first. 409 cannot_remove_primary. */
export function useRemoveContact(channel: "email" | "phone") {
  return useSettledMutation<EmailView[] | PhoneView[], string>(
    value => (channel === "email" ? api.me.emails.remove(value) : api.me.phones.remove(value)),
    (client, items) => storeContacts(client, channel, items),
    { errorTitle: channel === "email" ? "The email was not removed" : "The phone number was not removed" },
  );
}

/**
 * Verifies the code for a new email or phone number. Never toasts on its own: a wrong code is answered beside the code
 * input, everything else is toasted by the caller.
 */
export function useVerifyContact(channel: "email" | "phone") {
  const client = useQueryClient();
  return useMutation<EmailView[] | PhoneView[], ApiError, { challengeId: string; code: string }>({
    mutationFn: ({ challengeId, code }) => (channel === "email" ? api.me.emails.verify(challengeId, code) : api.me.phones.verify(challengeId, code)),
    onSuccess: items => storeContacts(client, channel, items),
    meta: { toast: false },
  });
}

/** Unlinks Google or Apple; the row shows "Unlinked" first. 409 last_sign_in_method. */
export function useUnlinkProvider() {
  return useSettledMutation(
    ({ provider, subject }: { provider: Provider; subject: string }) => api.me.identities.remove(provider, subject),
    (client, _data, { provider, subject }) => {
      client.setQueryData<Me>(queryKeys.me.view, me => (me && me.kind === "carbon" ? { ...me, identities: me.identities.filter(item => !(item.provider === provider && item.subject === subject)) } : me));
      void client.invalidateQueries({ queryKey: queryKeys.me.identities });
      void client.invalidateQueries({ queryKey: queryKeys.me.view });
    },
    { errorTitle: "It is still linked" },
  );
}

/** Signs another browser or terminal out; the row shows "Signed out" first. */
export function useSignOutSession() {
  return useSettledMutation(
    (id: string) => api.me.sessions.revoke(id),
    (client, _data, id) => {
      client.setQueryData<Page<SessionInfo>>(queryKeys.me.sessions, page => (page ? { ...page, items: page.items.filter(item => item.id !== id) } : page));
      void client.invalidateQueries({ queryKey: queryKeys.me.sessions });
    },
    { errorTitle: "That session is still signed in" },
  );
}

/** Removes an app's access; the card shows "Access removed", then moves to the removed apps. */
export function useRemoveAccess() {
  return useSettledMutation(
    (appId: string) => api.me.apps.removeAccess(appId),
    (client, _data, appId) => {
      const at = new Date().toISOString();
      client.setQueryData<Page<MyApp>>(queryKeys.me.apps, page => (page ? { ...page, items: page.items.map(item => (item.app.app_id === appId ? { ...item, status: "access_removed", active_sessions: 0, access_removed_at: at } : item)) } : page));
      void client.invalidateQueries({ queryKey: queryKeys.me.apps });
      void client.invalidateQueries({ queryKey: queryKeys.me.proofs });
    },
    { errorTitle: "The app still has access", delay: 900 },
  );
}

/** Revokes a proof about you; the card shows "Revoked", then moves to the ended proofs. */
export function useRevokeProof() {
  return useSettledMutation(
    (proofId: string) => api.me.proofs.revoke(proofId),
    (client, _data, proofId) => {
      const at = new Date().toISOString();
      client.setQueryData<Page<MyProof>>(queryKeys.me.proofs, page => (page ? { ...page, items: page.items.map(item => (item.proof_id === proofId ? { ...item, status: "revoked", revoked_at: at, revoke_reason: "revoked_by_account" } : item)) } : page));
      void client.invalidateQueries({ queryKey: queryKeys.me.proofs });
    },
    { errorTitle: "The proof was not revoked", delay: 900 },
  );
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Silicons: actions whose result shows before the page changes                                                        */
/* ------------------------------------------------------------------------------------------------------------------ */

/** Puts a Silicon into the list and its own cache entry, keeping a pending transfer the answer did not carry. */
export function storeSiliconItem(client: ReturnType<typeof useQueryClient>, uuid: string, change: (silicon: ManagedSilicon) => ManagedSilicon): void {
  client.setQueryData<Page<ManagedSilicon>>(queryKeys.me.silicons, page => (page ? { ...page, items: page.items.map(item => (item.uuid === uuid ? change(item) : item)) } : page));
  client.setQueryData<ManagedSilicon>(queryKeys.me.silicon(uuid), silicon => (silicon ? change(silicon) : silicon));
}

/** Refreshes what a change to a Silicon can touch: the list, Me (custodian_of) and the history. */
export function refreshSiliconViews(client: ReturnType<typeof useQueryClient>): void {
  void client.invalidateQueries({ queryKey: queryKeys.me.silicons });
  void client.invalidateQueries({ queryKey: queryKeys.me.view });
  void client.invalidateQueries({ queryKey: queryKeys.me.historyRoot });
}

/** Back to the default photo (PATCH pfp_url null); "Removed" shows first. */
export function useSiliconDefaultPhoto() {
  return useSettledMutation(
    (uuid: string) => api.me.silicons.update(uuid, { pfp_url: null }),
    (client, silicon) => {
      storeSiliconItem(client, silicon.uuid, current => ({ ...current, ...silicon, pending_transfer: silicon.pending_transfer ?? current.pending_transfer }));
      void client.invalidateQueries({ queryKey: queryKeys.me.historyRoot });
    },
    { errorTitle: "The photo was not removed" },
  );
}

/** Removes a Silicon's webhook; "Removed" shows first. */
export function useRemoveSiliconWebhookSettled() {
  return useSettledMutation(
    (uuid: string) => api.me.silicons.removeWebhook(uuid),
    (client, _data, uuid) => {
      storeSiliconItem(client, uuid, current => ({ ...current, webhook_url: null }));
      refreshSiliconViews(client);
    },
    { errorTitle: "The webhook was not removed" },
  );
}

/** Cancels a pending transfer; "Cancelled" shows first. */
export function useCancelTransferSettled() {
  return useSettledMutation(
    (uuid: string) => api.me.silicons.cancelTransfer(uuid),
    (client, _data, uuid) => {
      storeSiliconItem(client, uuid, current => ({ ...current, pending_transfer: null }));
      refreshSiliconViews(client);
    },
    { errorTitle: "The transfer was not cancelled" },
  );
}

/**
 * Starts a transfer without touching the cache, so the Silicon's card can travel to the recipient first; then
 * `settle(uuid, request)` shows the waiting transfer.
 */
export function useStartTransfer() {
  const client = useQueryClient();
  const mutation = useMutation<TransferRequest, ApiError, { uuid: string; to: string }>({
    mutationFn: ({ uuid, to }) => api.me.silicons.transfer(uuid, to),
    meta: { errorTitle: "No transfer request was sent" },
  });
  const settle = useCallback((uuid: string, request: TransferRequest, fallbackTo: string) => {
    const pending: PendingTransfer = { id: request.id, to: request.to ?? { email: fallbackTo }, created_at: request.created_at, expires_at: request.expires_at };
    storeSiliconItem(client, uuid, current => ({ ...current, pending_transfer: pending }));
    refreshSiliconViews(client);
  }, [client]);
  return { ...mutation, settle };
}

/** Deletes a Silicon without touching the cache; `settle(uuid)` removes its tile once the drawer has closed. */
export function useDeleteSiliconSettled() {
  const client = useQueryClient();
  const mutation = useMutation<null, ApiError, { uuid: string; confirm: string }>({
    mutationFn: ({ uuid, confirm }) => api.me.silicons.remove(uuid, confirm),
    meta: { errorTitle: "The Silicon was not deleted" },
  });
  const settle = useCallback((uuid: string) => {
    client.setQueryData<Page<ManagedSilicon>>(queryKeys.me.silicons, page => (page ? { ...page, items: page.items.filter(item => item.uuid !== uuid) } : page));
    client.removeQueries({ queryKey: queryKeys.me.silicon(uuid) });
    refreshSiliconViews(client);
  }, [client]);
  return { ...mutation, settle };
}

export type Decision = "accept" | "decline";

/**
 * Answers a custodian request without touching the cache (the card leaves first; then `settle` drops it and, after an
 * accept, brings in the Silicon). Never toasts on its own: the deck reports failures with the right title.
 * `settle` resolves once the Silicons list has been read again (after an accept the new Silicon's tile is then there).
 */
export function useDecideRequest() {
  const client = useQueryClient();
  const mutation = useMutation<null, ApiError, { id: string; decision: Decision }>({
    mutationFn: ({ id, decision }) => (decision === "accept" ? api.me.custodianRequests.accept(id) : api.me.custodianRequests.decline(id)),
    meta: { toast: false },
  });
  const settle = useCallback(async (id: string, decision: Decision): Promise<void> => {
    client.setQueryData<Page<CustodianRequest>>(queryKeys.me.custodianRequests, page => (page ? { ...page, items: page.items.filter(item => item.id !== id) } : page));
    void client.invalidateQueries({ queryKey: queryKeys.me.custodianRequests });
    if (decision === "accept") {
      void client.invalidateQueries({ queryKey: queryKeys.me.view });
      void client.invalidateQueries({ queryKey: queryKeys.me.historyRoot });
      await client.invalidateQueries({ queryKey: queryKeys.me.silicons }).catch(() => undefined);
    } else {
      void client.invalidateQueries({ queryKey: queryKeys.me.historyRoot });
    }
  }, [client]);
  return { ...mutation, settle };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Whole lists                                                                                                         */
/* ------------------------------------------------------------------------------------------------------------------ */

/** The API's largest page. */
const PAGE_LIMIT = 200;
/** A guard against a runaway list: 25 pages of 200. A longer list keeps its `next_cursor`, and the page says so. */
export const MAX_LIST_PAGES = 25;

/**
 * Reads a list to its end, following `next_cursor` (the API answers at most 200 per page). The answer has the shape of
 * one page, so the cache entries the shared hooks and mutations write keep working: `next_cursor` is null when every
 * item is there, and the cursor to go on from when the guard stopped it.
 */
export async function readEveryPage<T>(fetchPage: (query: PageQuery) => Promise<Page<T>>): Promise<Page<T>> {
  const items: T[] = [];
  let cursor: string | null = null;
  for (let read = 0; read < MAX_LIST_PAGES; read += 1) {
    const page: Page<T> = await fetchPage({ limit: PAGE_LIMIT, cursor });
    items.push(...page.items);
    if (!page.next_cursor) return { items, next_cursor: null };
    cursor = page.next_cursor;
  }
  return { items, next_cursor: cursor };
}

function useEveryPage<T>(queryKey: QueryKey, fetchPage: (query: PageQuery) => Promise<Page<T>>, enabled: boolean) {
  return useQuery<Page<T>, ApiError>({
    queryKey,
    queryFn: () => readEveryPage(fetchPage),
    enabled,
    // A shared hook elsewhere caches just the first page under the same key (developer pages read your apps that way):
    // a list that stops short is read again in full whenever a page here shows it.
    refetchOnMount: query => (query.state.data?.next_cursor ? "always" : true),
  });
}

/** Every app this account signed into (the shared `useMyApps` reads one page). */
export function useEveryApp() {
  const { status } = useSession();
  return useEveryPage<MyApp>(queryKeys.me.apps, query => api.me.apps.list(query), status === "signed_in");
}

/** Every OBO proof about this account, active and ended. */
export function useEveryProof() {
  const { status } = useSession();
  return useEveryPage<MyProof>(queryKeys.me.proofs, query => api.me.proofs.list(query), status === "signed_in");
}

/** Every browser and terminal signed in to this account. */
export function useEverySession() {
  const { status } = useSession();
  return useEveryPage<SessionInfo>(queryKeys.me.sessions, query => api.me.sessions.list(query), status === "signed_in");
}

/** Every Silicon this Carbon is custodian of. */
export function useEverySilicon() {
  const { status, session } = useSession();
  return useEveryPage<ManagedSilicon>(queryKeys.me.silicons, query => api.me.silicons.list(query), status === "signed_in" && session?.account.kind === "carbon");
}

/** Every custodian request waiting for this Carbon. */
export function useEveryCustodianRequest() {
  const { status, session } = useSession();
  return useEveryPage<CustodianRequest>(queryKeys.me.custodianRequests, query => api.me.custodianRequests.list(query), status === "signed_in" && session?.account.kind === "carbon");
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Id changes, answered in the form                                                                                    */
/* ------------------------------------------------------------------------------------------------------------------ */

/**
 * Changes your own id (the shared useChangeId without its toast): the id form says why a change was refused, in
 * readable words, right under the field, so a toast would only repeat it (with the service's raw times).
 */
export function useChangeOwnId() {
  const client = useQueryClient();
  return useMutation<Me, ApiError, string>({
    mutationFn: id => api.me.changeId(id),
    onSuccess: me => {
      setMe(client, me);
      void client.invalidateQueries({ queryKey: queryKeys.me.historyRoot });
    },
    meta: { toast: false },
  });
}

/** Changes a Silicon's si:id as its custodian (the shared useChangeSiliconId without its toast, for the same reason). */
export function useChangeSiliconIdInForm() {
  const client = useQueryClient();
  return useMutation<ManagedSilicon, ApiError, { uuid: string; id: string }>({
    mutationFn: ({ uuid, id }) => api.me.silicons.changeId(uuid, id),
    onSuccess: silicon => {
      upsertSilicon(client, silicon);
      void client.invalidateQueries({ queryKey: queryKeys.me.historyRoot });
    },
    meta: { toast: false },
  });
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Answers that carry a secret shown once                                                                              */
/* ------------------------------------------------------------------------------------------------------------------ */

/** Puts a Silicon the server just returned into its own cache entry and the list (adding it when it is new). */
function upsertSilicon(client: ReturnType<typeof useQueryClient>, silicon: ManagedSilicon): void {
  client.setQueryData(queryKeys.me.silicon(silicon.uuid), silicon);
  client.setQueryData<Page<ManagedSilicon>>(queryKeys.me.silicons, page => (page
    ? { ...page, items: page.items.some(item => item.uuid === silicon.uuid) ? page.items.map(item => (item.uuid === silicon.uuid ? silicon : item)) : [...page.items, silicon] }
    : page));
}

/**
 * An idempotent action whose answer carries a secret shown once (an STK, a webhook signing secret). `run(input)` resolves
 * with the answer and then resets the mutation, and the mutation is never kept after that (gcTime 0): the reveal card
 * the caller hands the secret to is its only copy, so "I've stored it" really drops it. A chosen STK in the input goes
 * the same way. A failure keeps its Idempotency-Key (a retry of the same input reuses it), but not the input.
 */
function useOnceMutation<TData, TVars>(
  fn: (variables: TVars, idempotencyKey: string) => Promise<TData>,
  onSuccess: (data: TData, variables: TVars) => void,
  errorTitle: string,
) {
  const mutation = useIdempotentMutation<TData, TVars>(fn, { gcTime: 0, onSuccess, meta: { errorTitle } });
  const { mutateAsync, reset } = mutation;
  const run = useCallback(async (variables: TVars): Promise<TData> => {
    try {
      return await mutateAsync(variables);
    } finally {
      reset();
    }
  }, [mutateAsync, reset]);
  return { run, isPending: mutation.isPending };
}

/** Creates a Silicon with me as custodian; its generated STK and webhook secret come back once. */
export function useCreateSiliconOnce() {
  const client = useQueryClient();
  return useOnceMutation<SiliconCreated, CreateSilicon>(
    (body, idempotencyKey) => api.me.silicons.create(body, { idempotencyKey }),
    created => {
      upsertSilicon(client, created.silicon);
      refreshSiliconViews(client);
    },
    "Could not create the Silicon",
  );
}

/** Rotates a Silicon's STK (the old one dies at once); a generated STK comes back once. */
export function useRotateStkOnce() {
  const client = useQueryClient();
  return useOnceMutation<StkRotated, { uuid: string; stk?: string }>(
    ({ uuid, stk }, idempotencyKey) => api.me.silicons.rotateStk(uuid, stk, { idempotencyKey }),
    (_answer, { uuid }) => {
      void client.invalidateQueries({ queryKey: queryKeys.me.silicon(uuid) });
      refreshSiliconViews(client);
    },
    "Could not rotate the STK",
  );
}

/**
 * Sets a Silicon's webhook; its new signing secret comes back once. The PUT takes no Idempotency-Key: a retry after a
 * lost answer sets the same URL again with a fresh secret, and the unseen one simply stops working.
 */
export function useSetSiliconWebhookOnce() {
  const client = useQueryClient();
  return useOnceMutation<SiliconWebhook, { uuid: string; url: string }>(
    ({ uuid, url }) => api.me.silicons.setWebhook(uuid, url),
    (answer, { uuid }) => {
      storeSiliconItem(client, uuid, current => ({ ...current, webhook_url: answer.webhook_url }));
      void client.invalidateQueries({ queryKey: queryKeys.me.silicon(uuid) });
      void client.invalidateQueries({ queryKey: queryKeys.me.silicons });
    },
    "Could not set the webhook",
  );
}
