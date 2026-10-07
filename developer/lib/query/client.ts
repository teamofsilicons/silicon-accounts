/**
 * The TanStack Query client every page shares (created once per browser tab by the root providers).
 *
 * - Errors are ApiError everywhere (`Register.defaultError`), with the server's message and hint.
 * - A failed mutation toasts "title + message + hint" unless it opts out with `meta: { toast: false }` (pages that
 *   show the failure inline, such as a wrong code beside the code input). Set `meta.errorTitle` for the toast title.
 * - A failed query does not toast: pages render it inline with a retry (Arc: an alert next to the cause).
 * - A 401 that means the sign-in is gone (isSignedOutError) marks the session gone (see lib/query/session.ts), and the
 *   shell sends the visitor to sign in. Other 401s (an endpoint refusing this token) show where they happen.
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

/**
 * 401 codes that mean this browser is no longer signed in to the developer site: the BFF's own `signed_out`, and what
 * the API says when the sign-in behind the token is gone. Other 401s (`token_wrong_audience`: an endpoint that refuses
 * the developer site's token) are shown where they happen and never sign anyone out.
 */
const SIGNED_OUT = new Set(["signed_out", "token_revoked", "account_deleted", "unauthenticated", "invalid_token"]);

export function isSignedOutError(error: unknown): boolean {
  const failure = ApiError.from(error);
  return failure.status === 401 && SIGNED_OUT.has(failure.code);
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
        if (isSignedOutError(error)) onUnauthenticated();
      },
    }),
    mutationCache: new MutationCache({
      onError: (error, _variables, _context, mutation) => {
        const failure = ApiError.from(error);
        if (isSignedOutError(failure)) onUnauthenticated();
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
