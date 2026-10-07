"use client";

/**
 * Queries and mutations for the account area (/, /sign-in-methods, /apps, /proofs, /activity, /settings).
 * Every mutation updates or invalidates what it changed, so other pages (and the shell's name and photo) follow.
 * Failures toast with the server's message and hint unless the caller passes `meta: { toast: false }` through
 * `mutate(…, …)` options or handles them inline.
 */
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/endpoints";
import type { ApiError } from "../api/errors";
import type { EmailView, HistoryKind, Me, PhoneView, ProfileUpdate } from "../api/types";
import { useIdempotentMutation, useSecretMutation } from "./idempotency";
import { queryKeys } from "./keys";
import { useWholeList } from "./pages";
import { setMe, useSession } from "./session";

/* ------------------------------------------------------------------------------------------------------------------ */
/* Profile, photo and id                                                                                               */
/* ------------------------------------------------------------------------------------------------------------------ */

export function useUpdateProfile() {
  const client = useQueryClient();
  return useMutation<Me, ApiError, ProfileUpdate>({
    mutationFn: patch => api.me.update(patch),
    onSuccess: me => setMe(client, me),
    meta: { errorTitle: "Could not save your profile" },
  });
}

/** Uploads a profile photo (PNG, JPEG, WebP or GIF, ≤ 2 MB). The answer carries the refreshed Me view. */
export function useUploadPhoto() {
  const client = useQueryClient();
  return useIdempotentMutation((file: Blob, idempotencyKey) => api.me.uploadPhoto(file, { idempotencyKey }), {
    onSuccess: result => setMe(client, result.me),
    meta: { errorTitle: "Could not upload the photo" },
  });
}

export function useRemovePhoto() {
  const client = useQueryClient();
  return useMutation<Me, ApiError, void>({
    mutationFn: () => api.me.removePhoto(),
    onSuccess: me => setMe(client, me),
    meta: { errorTitle: "Could not remove the photo" },
  });
}

/** Changes your c:id (or a Silicon's own si:id). The old id stays reserved for you for 10 days. */
export function useChangeId() {
  const client = useQueryClient();
  return useMutation<Me, ApiError, string>({
    mutationFn: id => api.me.changeId(id),
    onSuccess: me => {
      setMe(client, me);
      void client.invalidateQueries({ queryKey: queryKeys.me.historyRoot });
    },
    meta: { errorTitle: "Could not change your id" },
  });
}

/**
 * Whether an id can be taken. Pass the id once the person paused typing (useDeferredValue or a debounce); null skips.
 * The answer carries `suggestions` when it is taken, and `reclaimable` for your own reserved id.
 */
export function useIdAvailability(id: string | null) {
  return useQuery({
    queryKey: queryKeys.idAvailability(id ?? ""),
    queryFn: ({ signal }) => api.ids.available(id ?? "", signal),
    enabled: !!id,
    staleTime: 10_000,
    retry: false,
  });
}

/** Account summaries by uuid (custodians, people in history rows). */
export function useAccount(uuid: string | null) {
  return useQuery({ queryKey: queryKeys.account(uuid ?? ""), queryFn: () => api.accounts.get(uuid ?? ""), enabled: !!uuid, staleTime: 5 * 60_000 });
}

/** `DELETE /v1/me`; `confirm` is your c:id. On success the session is gone: leave with a full load to "/". */
export function useDeleteAccount() {
  return useMutation<null, ApiError, string>({
    mutationFn: confirm => api.me.deleteAccount(confirm),
    meta: { errorTitle: "Could not delete your account" },
  });
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Emails, phones and linked identities                                                                                */
/* ------------------------------------------------------------------------------------------------------------------ */

function useContactLists() {
  const client = useQueryClient();
  return {
    emails: (items: EmailView[]) => {
      client.setQueryData(queryKeys.me.emails, items);
      void client.invalidateQueries({ queryKey: queryKeys.me.view });
    },
    phones: (items: PhoneView[]) => {
      client.setQueryData(queryKeys.me.phones, items);
      void client.invalidateQueries({ queryKey: queryKeys.me.view });
    },
  };
}

export function useEmails() {
  const { status } = useSession();
  return useQuery({ queryKey: queryKeys.me.emails, queryFn: () => api.me.emails.list(), enabled: status === "signed_in" });
}

/** Sends a code to a new email: answers `{challenge_id, destination, expires_at, resend_available_at}`. */
export function useAddEmail() {
  return useMutation({ mutationFn: (email: string) => api.me.emails.add(email), meta: { errorTitle: "Could not send the code" } });
}

/** Verifies the code (wrong codes are usually shown beside the code input: pass meta toast false). */
export function useVerifyEmail() {
  const lists = useContactLists();
  return useMutation({
    mutationFn: ({ challengeId, code }: { challengeId: string; code: string }) => api.me.emails.verify(challengeId, code),
    onSuccess: lists.emails,
    meta: { errorTitle: "Could not add the email" },
  });
}

export function useMakePrimaryEmail() {
  const lists = useContactLists();
  return useMutation({ mutationFn: (email: string) => api.me.emails.makePrimary(email), onSuccess: lists.emails, meta: { errorTitle: "Could not change the primary email" } });
}

export function useRemoveEmail() {
  const lists = useContactLists();
  return useMutation({ mutationFn: (email: string) => api.me.emails.remove(email), onSuccess: lists.emails, meta: { errorTitle: "Could not remove the email" } });
}

export function usePhones() {
  const { status } = useSession();
  return useQuery({ queryKey: queryKeys.me.phones, queryFn: () => api.me.phones.list(), enabled: status === "signed_in" });
}

/** `country` only for local-format numbers; a number written with "+CC" is sent as typed. */
export function useAddPhone() {
  return useMutation({ mutationFn: ({ phone, country }: { phone: string; country?: string }) => api.me.phones.add(phone, country), meta: { errorTitle: "Could not send the code" } });
}

export function useVerifyPhone() {
  const lists = useContactLists();
  return useMutation({
    mutationFn: ({ challengeId, code }: { challengeId: string; code: string }) => api.me.phones.verify(challengeId, code),
    onSuccess: lists.phones,
    meta: { errorTitle: "Could not add the phone number" },
  });
}

export function useMakePrimaryPhone() {
  const lists = useContactLists();
  return useMutation({ mutationFn: (phone: string) => api.me.phones.makePrimary(phone), onSuccess: lists.phones, meta: { errorTitle: "Could not change the primary phone number" } });
}

export function useRemovePhone() {
  const lists = useContactLists();
  return useMutation({ mutationFn: (phone: string) => api.me.phones.remove(phone), onSuccess: lists.phones, meta: { errorTitle: "Could not remove the phone number" } });
}

export function useIdentities() {
  const { status } = useSession();
  return useQuery({ queryKey: queryKeys.me.identities, queryFn: () => api.me.identities.list(), enabled: status === "signed_in" });
}

export function useUnlinkIdentity() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ provider, subject }: { provider: "google" | "apple"; subject: string }) => api.me.identities.remove(provider, subject),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.me.identities });
      void client.invalidateQueries({ queryKey: queryKeys.me.view });
    },
    meta: { errorTitle: "Could not unlink it" },
  });
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Apps, sessions, history and proofs                                                                                  */
/* ------------------------------------------------------------------------------------------------------------------ */

/** Every app this account signed into (the whole list, every page of 200; see lib/query/pages.ts). */
export function useMyApps() {
  const { status } = useSession();
  return useWholeList(queryKeys.me.apps, query => api.me.apps.list(query), status === "signed_in");
}

export function useRemoveAppAccess() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (appId: string) => api.me.apps.removeAccess(appId),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.me.apps });
      void client.invalidateQueries({ queryKey: queryKeys.me.proofs });
    },
    meta: { errorTitle: "Could not remove access" },
  });
}

/** Every browser and terminal signed in to this account (the whole list). */
export function useSessions() {
  const { status } = useSession();
  return useWholeList(queryKeys.me.sessions, query => api.me.sessions.list(query), status === "signed_in");
}

export function useRevokeSession() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.me.sessions.revoke(id),
    onSuccess: () => void client.invalidateQueries({ queryKey: queryKeys.me.sessions }),
    meta: { errorTitle: "Could not sign that session out" },
  });
}

/** History, newest first, 50 at a time (`fetchNextPage()` for older). */
export function useHistory(kind?: HistoryKind | null) {
  const { status } = useSession();
  return useInfiniteQuery({
    queryKey: queryKeys.me.history(kind),
    queryFn: ({ pageParam }) => api.me.history({ kind: kind ?? undefined, limit: 50, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: page => page.next_cursor,
    enabled: status === "signed_in",
  });
}

/** Every OBO proof about this account, active and ended (the whole list). */
export function useMyProofs() {
  const { status } = useSession();
  return useWholeList(queryKeys.me.proofs, query => api.me.proofs.list(query), status === "signed_in");
}

export function useRevokeMyProof() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (proofId: string) => api.me.proofs.revoke(proofId),
    onSuccess: () => void client.invalidateQueries({ queryKey: queryKeys.me.proofs }),
    meta: { errorTitle: "Could not revoke the proof" },
  });
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* A Silicon's own webhook (a Silicon signed in to the site)                                                            */
/* ------------------------------------------------------------------------------------------------------------------ */

/** Sets a Silicon's own webhook; its signing secret comes back once (`run(url)`; see useSecretMutation). */
export function useSetOwnWebhook() {
  const client = useQueryClient();
  return useSecretMutation((url: string) => api.me.webhook.set(url), {
    onSuccess: () => void client.invalidateQueries({ queryKey: queryKeys.me.view }),
    meta: { errorTitle: "Could not set the webhook" },
  });
}

export function useRemoveOwnWebhook() {
  const client = useQueryClient();
  return useMutation({ mutationFn: () => api.me.webhook.remove(), onSuccess: () => void client.invalidateQueries({ queryKey: queryKeys.me.view }), meta: { errorTitle: "Could not remove the webhook" } });
}

export function useTestOwnWebhook() {
  return useMutation({ mutationFn: () => api.me.webhook.test(), meta: { errorTitle: "Could not send the test" } });
}
