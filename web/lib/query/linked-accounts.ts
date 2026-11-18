"use client";

import { useQuery } from "@tanstack/react-query";
import { request } from "@/lib/api/http";
import type { LinkedAccounts } from "@/lib/api/types";
import { useIdempotentMutation } from "./idempotency";

export function useLinkedAccounts() {
  return useQuery({
    queryKey: ["me", "linked-accounts"],
    queryFn: () => request<LinkedAccounts>("/v1/me/linked-accounts"),
  });
}

export function useLinkedAccountAction<T, V>(action: string) {
  return useIdempotentMutation(
    (body: V, idempotencyKey) =>
      request<T>(`/v1/me/${action}`, { method: "POST", body, idempotencyKey }),
    { meta: { toast: false } },
  );
}

export function useBrowserAccounts(enabled = true) {
  return useQuery({
    queryKey: ["session", "accounts"],
    queryFn: () => request<Pick<LinkedAccounts, "accounts">>("/v1/session/accounts"),
    enabled,
  });
}

export const browserProfileChanged = "accounts.active-profile";

export function useSwitchBrowserAccount() {
  return useIdempotentMutation(async (body: { account_uuid: string }) => {
    await request<void>("/v1/session/accounts/switch", { method: "POST", body });
    try { localStorage.setItem(browserProfileChanged, body.account_uuid); } catch { /* Storage can be disabled. */ }
  }, { meta: { toast: false } });
}

export interface AccountLinkRequest {
  id: string;
  source: {
    uuid: string;
    id: string;
    display_name: string;
    org?: { org_id: string; name: string } | null;
  };
  target: { uuid: string; id: string; display_name: string };
  expires_at: string;
}
export function useAccountLinkRequests() {
  return useQuery({
    queryKey: ["me", "linked-account-requests"],
    queryFn: () =>
      request<{ items: AccountLinkRequest[] }>(
        "/v1/me/linked-accounts/requests",
      ),
    retry: false,
  });
}
