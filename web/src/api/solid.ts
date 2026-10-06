/**
 * Solid helpers on top of the endpoint functions:
 *  - createApiResource: createResource whose error is always an ApiError (read it with `resource.error`).
 *  - createAction: a mutation with `pending`, `error` and an optional toast on failure; returns undefined on error.
 *  - createPagedList: cursor pagination with `loadMore`, `reset` and optimistic `mutate`.
 */
import { batch, createResource, createSignal, type Accessor, type InitializedResourceReturn, type ResourceReturn } from "solid-js";
import { ApiError } from "./errors";
import type { Page, PageQuery } from "./types";

/** Called by createAction for failures when `report` is not false. The shell installs the toast reporter. */
let reporter: ((error: ApiError, title?: string) => void) | undefined;
export function setErrorReporter(next: (error: ApiError, title?: string) => void): void {
  reporter = next;
}
/** Shows an ApiError the way the shell does (a toast with message and hint). */
export function reportError(error: unknown, title?: string): ApiError {
  const normalized = ApiError.from(error);
  reporter?.(normalized, title);
  return normalized;
}

/**
 * `createResource` with ApiError-typed failures. With a source, the fetch reruns when it changes (null/false/undefined
 * skips). Use `<Suspense>`/skeletons for loading and render `resource.error.message` + `.hint` inline.
 */
export function createApiResource<T>(fetcher: () => Promise<T>): ResourceReturn<T>;
export function createApiResource<T>(fetcher: () => Promise<T>, options: { initialValue: T }): InitializedResourceReturn<T>;
export function createApiResource<T, S>(source: Accessor<S | false | null | undefined>, fetcher: (source: S) => Promise<T>): ResourceReturn<T>;
export function createApiResource<T, S>(a: unknown, b?: unknown): ResourceReturn<T> | InitializedResourceReturn<T> {
  if (typeof b === "function") {
    const fetcher = b as (source: S) => Promise<T>;
    return createResource(a as Accessor<S | false | null | undefined>, async (source: S) => {
      try {
        return await fetcher(source);
      } catch (error) {
        throw ApiError.from(error);
      }
    });
  }
  const fetcher = a as () => Promise<T>;
  const wrapped = async () => {
    try {
      return await fetcher();
    } catch (error) {
      throw ApiError.from(error);
    }
  };
  return b ? createResource(wrapped, b as { initialValue: T }) : createResource(wrapped);
}

export interface Action<A extends unknown[], R> {
  /** Runs the call. Resolves with the result, or undefined when it failed (the error is in `error()`). */
  run: (...args: A) => Promise<R | undefined>;
  /** Like run, but rejects with the ApiError (for callers that render their own failure, such as ConfirmMorph). */
  runOrThrow: (...args: A) => Promise<R>;
  pending: Accessor<boolean>;
  error: Accessor<ApiError | undefined>;
  clearError: () => void;
}

export interface ActionOptions<R> {
  /** Toast the failure (default true). Pass a string to use it as the toast title. */
  report?: boolean | string;
  onSuccess?: (result: R) => void;
  onError?: (error: ApiError) => void;
}

/** A mutation: `const save = createAction(api.me.update); await save.run({display_name})`. */
export function createAction<A extends unknown[], R>(fn: (...args: A) => Promise<R>, options: ActionOptions<R> = {}): Action<A, R> {
  const [pending, setPending] = createSignal(false);
  const [error, setError] = createSignal<ApiError>();
  let inFlight = 0;
  const runOrThrow = async (...args: A): Promise<R> => {
    const token = ++inFlight;
    batch(() => {
      setPending(true);
      setError(undefined);
    });
    try {
      const result = await fn(...args);
      options.onSuccess?.(result);
      return result;
    } catch (raw) {
      const failure = ApiError.from(raw);
      setError(failure);
      options.onError?.(failure);
      if (options.report !== false) reporter?.(failure, typeof options.report === "string" ? options.report : undefined);
      throw failure;
    } finally {
      if (token === inFlight) setPending(false);
    }
  };
  return {
    runOrThrow,
    run: (...args: A) => runOrThrow(...args).catch(() => undefined),
    pending,
    error,
    clearError: () => setError(undefined),
  };
}

export interface PagedList<T> {
  items: Accessor<T[]>;
  /** True while the first page loads. */
  loading: Accessor<boolean>;
  /** True while a further page loads. */
  loadingMore: Accessor<boolean>;
  error: Accessor<ApiError | undefined>;
  hasMore: Accessor<boolean>;
  loadMore: () => Promise<void>;
  /** Reloads from the first page (after a filter change or a mutation). */
  reset: () => Promise<void>;
  /** Optimistic edits: `mutate(items => items.filter(...))`. */
  mutate: (update: (items: T[]) => T[]) => void;
}

/** Cursor pagination over a `Page<T>` endpoint. Call `reset()` once to load (or pass `immediate`). */
export function createPagedList<T>(fetchPage: (query: PageQuery) => Promise<Page<T>>, options: { limit?: number; immediate?: boolean } = {}): PagedList<T> {
  const [items, setItems] = createSignal<T[]>([]);
  const [cursor, setCursor] = createSignal<string | null>(null);
  const [hasMore, setHasMore] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  const [loadingMore, setLoadingMore] = createSignal(false);
  const [error, setError] = createSignal<ApiError>();
  let generation = 0;
  const load = async (first: boolean) => {
    const token = first ? ++generation : generation;
    (first ? setLoading : setLoadingMore)(true);
    setError(undefined);
    try {
      const page = await fetchPage({ limit: options.limit ?? 50, cursor: first ? null : cursor() });
      if (token !== generation) return;
      batch(() => {
        setItems(previous => (first ? page.items : [...previous, ...page.items]));
        setCursor(page.next_cursor);
        setHasMore(page.next_cursor !== null && page.next_cursor !== undefined);
      });
    } catch (raw) {
      if (token === generation) setError(ApiError.from(raw));
    } finally {
      if (token === generation) (first ? setLoading : setLoadingMore)(false);
    }
  };
  const list: PagedList<T> = {
    items,
    loading,
    loadingMore,
    error,
    hasMore,
    loadMore: () => (hasMore() && !loadingMore() ? load(false) : Promise.resolve()),
    reset: () => load(true),
    mutate: update => setItems(update),
  };
  if (options.immediate ?? true) void list.reset();
  return list;
}

/** Reads every page (for small lists such as owned apps). Stops after `maxPages` as a guard. */
export async function collectPages<T>(fetchPage: (query: PageQuery) => Promise<Page<T>>, maxPages = 20): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const result: Page<T> = await fetchPage({ limit: 200, cursor });
    out.push(...result.items);
    if (!result.next_cursor) break;
    cursor = result.next_cursor;
  }
  return out;
}
