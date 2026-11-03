"use client";

import { useQuery } from "@tanstack/react-query";
import { request } from "@/lib/api/http";
import type { LinkedAccounts, Me } from "@/lib/api/types";
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

export function useSwitchLinkedAccount() {
  return useLinkedAccountAction<Me, { account_uuid: string }>(
    "linked-accounts/switch",
  );
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
