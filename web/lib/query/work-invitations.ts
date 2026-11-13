"use client";
import { useQuery } from "@tanstack/react-query";
import { request, seg } from "@/lib/api/http";
import { useIdempotentMutation } from "./idempotency";
export interface WorkInvitation {
  invitation_id: string;
  org: { org_id: string; name: string; logo_url: string | null };
  handle: string;
  email?: string;
  needs_link: boolean;
  return_to: string;
  expires_at?: string;
}
export const useWorkInvitation = (ticket: string) =>
  useQuery({
    queryKey: ["work-invitation", ticket],
    queryFn: () =>
      request<WorkInvitation>(`/v1/work-invitations/${seg(ticket)}`),
    retry: false,
  });
export function useWorkInvitationAction<T, V>(ticket: string, action: string) {
  return useIdempotentMutation(
    (body: V, idempotencyKey) =>
      request<T>(`/v1/work-invitations/${seg(ticket)}/${action}`, {
        method: "POST",
        body,
        idempotencyKey,
      }),
    { meta: { toast: false } },
  );
}
