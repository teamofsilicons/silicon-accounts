"use client";

/**
 * Developer-area reads that need more than the shared hooks in lib/query/developer.ts give (same query keys, so the
 * cache stays one): lists that keep the previous page on screen while a new search or filter loads, and following an
 * import job with backoff that stops for good on a permanent failure (a review finding on the SolidJS build: its
 * poller leaked and retried a 404 forever).
 */
import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api/endpoints";
import { ApiError } from "@/lib/api/errors";
import type { AppProofsQuery, AppUsersQuery, DeliveriesQuery, ImportJob, ImportRowsQuery } from "@/lib/api/types";
import { queryKeys } from "@/lib/query/keys";

/** The app's user base, filtered on the server; the last page stays shown while the next query loads. */
export function useUserBase(appId: string, query: Omit<AppUsersQuery, "cursor" | "limit">) {
  return useInfiniteQuery({
    queryKey: queryKeys.app.users(appId, query),
    queryFn: ({ pageParam }) => api.apps.users(appId, { ...query, limit: 50, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: page => page.next_cursor,
    placeholderData: keepPreviousData,
  });
}

export function useDeliveryList(appId: string, query: Omit<DeliveriesQuery, "cursor" | "limit">) {
  return useInfiniteQuery({
    queryKey: queryKeys.app.deliveries(appId, query),
    queryFn: ({ pageParam }) => api.apps.webhook.deliveries(appId, { ...query, limit: 50, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: page => page.next_cursor,
    placeholderData: keepPreviousData,
  });
}

export function useProofList(appId: string, query: Omit<AppProofsQuery, "cursor" | "limit">) {
  return useInfiniteQuery({
    queryKey: queryKeys.app.proofs(appId, query),
    queryFn: ({ pageParam }) => api.apps.proofs.list(appId, { ...query, limit: 50, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: page => page.next_cursor,
    placeholderData: keepPreviousData,
  });
}

export function useImportRowList(appId: string, jobId: string, query: Omit<ImportRowsQuery, "cursor" | "limit">) {
  return useInfiniteQuery({
    queryKey: queryKeys.app.importRows(appId, jobId, query),
    queryFn: ({ pageParam }) => api.apps.imports.rows(appId, jobId, { ...query, limit: 50, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: page => page.next_cursor,
    placeholderData: keepPreviousData,
  });
}

const POLL_MS = 900;
const MAX_POLL_BACKOFF_MS = 15_000;
const running = (job: ImportJob | undefined) => !!job && (job.status === "queued" || job.status === "running");
/** Following a job survives a network blip, a restart or a rate limit; other failures (a 403, a 404) never heal. */
export const retryableFailure = (error: ApiError) => error.isNetwork || error.status === 408 || error.status === 429 || error.status >= 500;

/** Consecutive failed reads per job (reset by a successful one), for the poll's backoff. */
const failures = new Map<string, number>();

/**
 * One import job, polled while it is queued or running: every 0.9 s, backing off after failures (up to 15 s, or the
 * server's Retry-After), and never again after a failure that cannot heal. The poll stops with the component, and only
 * one ever runs per job (the query cache dedupes).
 */
export function useImportJob(appId: string, jobId: string | null) {
  return useQuery({
    queryKey: queryKeys.app.import(appId, jobId ?? ""),
    queryFn: async () => {
      const key = `${appId}/${jobId ?? ""}`;
      try {
        const job = await api.apps.imports.get(appId, jobId ?? "");
        failures.delete(key);
        return job;
      } catch (error) {
        failures.set(key, (failures.get(key) ?? 0) + 1);
        throw error;
      }
    },
    enabled: !!jobId,
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval: query => {
      const error = query.state.status === "error" && query.state.error ? ApiError.from(query.state.error) : null;
      if (error && !retryableFailure(error)) return false;
      const failed = failures.get(`${appId}/${jobId ?? ""}`) ?? 0;
      if (error && failed > 0) return Math.min(MAX_POLL_BACKOFF_MS, Math.max(POLL_MS * 2 ** failed, (error.retryAfter ?? 0) * 1000));
      return running(query.state.data) ? POLL_MS : false;
    },
  });
}
