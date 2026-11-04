"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { request } from "@/lib/api/http";
import { queryKeys } from "./keys";

export interface InterfaceSession { session_id: string; interface_id: string; name: string; logo_url: string | null; apps: string[]; created_at: string; expires_at: string }
const key = ["interface-sessions"] as const;
export function useInterfaceSessions() {
  return useQuery({ queryKey: key, queryFn: ({ signal }) => request<{ sessions: InterfaceSession[] }>("/v1/me/interface-sessions", { signal }) });
}
export function useRemoveInterfaceAccess() {
  const client = useQueryClient();
  return useMutation({ mutationFn: (id: string) => request<{ revoked_sessions: number }>(`/v1/me/interfaces/${encodeURIComponent(id)}`, { method: "DELETE", idempotencyKey: true }), onSuccess: async () => { await Promise.all([client.invalidateQueries({ queryKey: key }), client.invalidateQueries({ queryKey: queryKeys.me.apps })]); } });
}
