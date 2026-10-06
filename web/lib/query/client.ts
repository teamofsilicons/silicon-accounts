/**
 * The TanStack Query client every page shares (created once per browser tab by the root providers).
 *
 * - Errors are ApiError everywhere (`Register.defaultError`), with the server's message and hint.
 * - A failed mutation toasts "title + message + hint" unless it opts out with `meta: { toast: false }` (pages that
 *   show the failure inline, such as a wrong code beside the code input). Set `meta.errorTitle` for the toast title.
 * - A failed query does not toast: pages render it inline with a retry (Arc: an alert next to the cause).
 * - Any 401 marks the session gone (see lib/query/session.ts), and the account shell sends the visitor to sign in.
 * - Queries retry network blips and 5xx twice; mutations never retry on their own (retries reuse the same
 *   Idempotency-Key through lib/query/idempotency.ts when the person tries again).
 */
import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { ApiError } from "../api/errors";
import { notifyError } from "../notify";

export interface QueryMeta extends Record<string, unknown> {
  /** Title of the error toast (mutations). */
  errorTitle?: string;
  /** false: never toast this failure (the page shows it inline). */
  toast?: boolean;
}

declare module "@tanstack/react-query" {
  interface Register {
    defaultError: ApiError;
    queryMeta: QueryMeta;
    mutationMeta: QueryMeta;
  }
}

/** Retry only what may succeed on its own: the network, and the server having a moment. Never 4xx. */
function shouldRetry(failureCount: number, error: unknown): boolean {
  const failure = ApiError.from(error);
  if (failure.status === 0 && failure.code !== "network_error") return false;
  if (failure.status !== 0 && failure.status < 500) return false;
  return failureCount < 2;
}

export function createQueryClient(onUnauthenticated: () => void): QueryClient {
  return new QueryClient({
    queryCache: new QueryCache({
      onError: error => {
        if (ApiError.from(error).status === 401) onUnauthenticated();
      },
    }),
    mutationCache: new MutationCache({
      onError: (error, _variables, _context, mutation) => {
        const failure = ApiError.from(error);
        if (failure.status === 401) onUnauthenticated();
        if (mutation.meta?.toast === false) return;
        notifyError(failure, mutation.meta?.errorTitle);
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        retry: shouldRetry,
        retryDelay: attempt => Math.min(4000, 600 * 2 ** attempt),
        refetchOnWindowFocus: true,
      },
      mutations: { retry: false },
    },
  });
}
