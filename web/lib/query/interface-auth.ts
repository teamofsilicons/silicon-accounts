"use client";
import { useMutation } from "@tanstack/react-query";
import { request } from "@/lib/api/http";
import type { Branding } from "@/lib/api/types";

export interface InterfaceFlow {
  flow_id: string;
  interface: { interface_id: string; name: string; logo_url: string | null; branding: Partial<Branding> };
  apps: Array<{ app_id: string; name: string; logo_url: string | null; description: string | null; scopes: string[]; optional_scopes: string[] }>;
  consent_required: boolean;
}
export function useInterfaceAuth() {
  const start = useMutation({ mutationFn: (body: Record<string, string>) => request<InterfaceFlow>("/v1/interface-auth/flows", { body, quiet401: true }), meta: { toast: false } });
  const decide = useMutation({ mutationFn: ({ id, approve, optional_scopes }: { id: string; approve: boolean; optional_scopes: Record<string, string[]> }) => request<{ redirect_to: string }>(`/v1/interface-auth/flows/${encodeURIComponent(id)}/decision`, { body: { approve, optional_scopes }, quiet401: true }), meta: { toast: false } });
  return { start, decide };
}
