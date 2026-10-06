"use client";

/**
 * Hosted sign-in and device approval (/authorize, /authorize/flow/[id], /device, /sign-in).
 *
 * A flow is one cached FlowView (`queryKeys.flow(id)`); every action answers the next FlowView, which replaces it, so
 * the page re-renders from `flow.step`. Flow failures are shown inline by the hosted pages (never a toast: the
 * Carbon reads them on the card), so these mutations opt out of toasts.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/endpoints";
import type { ApiError } from "../api/errors";
import type { FlowCreate, FlowView } from "../api/types";
import { queryKeys } from "./keys";

/** `POST /v1/flows`: creates the flow (sets its cookie) and seeds the cache. */
export function useCreateFlow() {
  const client = useQueryClient();
  return useMutation<FlowView, ApiError, FlowCreate>({
    mutationFn: body => api.flows.create(body),
    onSuccess: flow => client.setQueryData(queryKeys.flow(flow.id), flow),
    meta: { toast: false },
  });
}

/** The flow, read once (GET also finalizes a returning Google/Apple leg); no background refetching. */
export function useFlow(id: string | null) {
  return useQuery({
    queryKey: queryKeys.flow(id ?? ""),
    queryFn: ({ signal }) => api.flows.get(id ?? "", signal),
    enabled: !!id,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

/**
 * Runs one flow action and stores the FlowView it answers:
 *
 *   const action = useFlowAction(flow.id);
 *   action.mutate(id => api.flows.verify(id, code));
 */
export function useFlowAction(id: string) {
  const client = useQueryClient();
  return useMutation<FlowView, ApiError, (flowId: string) => Promise<FlowView>>({
    mutationFn: run => run(id),
    onSuccess: flow => client.setQueryData(queryKeys.flow(flow.id), flow),
    meta: { toast: false },
  });
}

/** Re-reads the flow (after an error that may have moved it, or a change made in another tab). */
export function useRefreshFlow(id: string) {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: queryKeys.flow(id) });
}

/** `GET /v1/device/{user_code}` for the approval page (Carbon session). */
export function useDeviceRequest(userCode: string | null) {
  return useQuery({ queryKey: queryKeys.device(userCode ?? ""), queryFn: () => api.device.get(userCode ?? ""), enabled: !!userCode, retry: false, refetchOnWindowFocus: false });
}

export function useDecideDevice() {
  const client = useQueryClient();
  return useMutation<null, ApiError, { userCode: string; approve: boolean }>({
    mutationFn: ({ userCode, approve }) => (approve ? api.device.approve(userCode) : api.device.deny(userCode)),
    onSettled: (_data, _error, { userCode }) => void client.invalidateQueries({ queryKey: queryKeys.device(userCode) }),
    meta: { toast: false },
  });
}
