"use client";

import { ApiError as SharedApiError } from "@/lib/api/errors";
import { useQuery } from "@tanstack/react-query";
import { beginSignIn } from "@/lib/query/session";
import { telemetryEnabled } from "@/lib/telemetry";
import { useCallback, useEffect, useRef, useState } from "react";
export class ApiError extends SharedApiError {
  constructor(status: number, body: {error?: {code?: string; message?: string; hint?: string; details?: unknown}}) {
    super({status, code: body.error?.code || "request_failed", message: body.error?.message || `The service returned HTTP ${status}.`, hint: body.error?.hint, details: body.error?.details as Record<string, unknown> | undefined});
  }
}
const BASE = "/api/apps";
const pendingMutations = new Map<string, string>();
export async function api<T>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    signal?: AbortSignal;
    key?: string;
    contentType?: string;
  } = {},
): Promise<T> {
  const method = options.method || "GET";
  const headers: Record<string, string> = { Accept: "application/json" };
  if (!telemetryEnabled())
    headers["X-Apps-Telemetry"] = "off";
  if (method !== "GET")
    headers["Idempotency-Key"] = options.key || crypto.randomUUID();
  let body: BodyInit | undefined;
  if (options.body instanceof Blob) {
    headers["Content-Type"] = options.contentType || "application/gzip";
    body = options.body;
  } else if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  let fingerprint: string | undefined;
  if (method !== "GET" && !options.key) {
    const bytes =
      options.body instanceof Blob
        ? await options.body.arrayBuffer()
        : new TextEncoder().encode(String(body || ""));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    fingerprint = `${method}:${path}:${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")}`;
    headers["Idempotency-Key"] =
      pendingMutations.get(fingerprint) || headers["Idempotency-Key"];
    pendingMutations.set(fingerprint, headers["Idempotency-Key"]);
    if (pendingMutations.size > 256)
      pendingMutations.delete(pendingMutations.keys().next().value!);
  }
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body,
      signal: options.signal,
      credentials: "include",
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new ApiError(0, {
      error: {
        code: "network_unavailable",
        message: "Could not reach Silicon Apps.",
        hint: "Check your connection and try again. Retrying keeps the same request key, so an accepted action is not repeated.",
      },
    });
  }
  const payload = await response.json().catch(() => ({}));
  if (
    fingerprint &&
    (response.ok ||
      (response.status < 500 &&
        response.status !== 408 &&
        response.status !== 429))
  )
    pendingMutations.delete(fingerprint);
  if (!response.ok) throw new ApiError(response.status, payload);
  return payload as T;
}
export const login = () => beginSignIn(window.location.pathname + window.location.search);
export function useResource<T>(path: string | null, revision = 0) {
  const query = useQuery<T, Error>({
    queryKey: ["publishing", path, revision],
    queryFn: ({ signal }) => api<T>(path!, { signal }),
    enabled: !!path,
    retry: false,
    staleTime: 0,
  });
  return { data: query.data, error: query.error ?? undefined, loading: !!path && query.isPending, reload: () => { void query.refetch(); } };
}
export function useMutation(onDone?: () => void) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Error>();
  const run = async <T>(action: () => Promise<T>): Promise<T | undefined> => {
    setPending(true);
    setError(undefined);
    try {
      const result = await action();
      onDone?.();
      return result;
    } catch (error) {
      setError(error instanceof Error ? error : new Error(String(error)));
      return undefined;
    } finally {
      setPending(false);
    }
  };
  return { pending, error, run, clearError: () => setError(undefined) };
}
const pendingSaves = new Map<
  string,
  { save: () => Promise<void>; dirty: () => boolean }
>();
const keptDrafts = new Map<string, { value: object; href: string }>();
const draftListeners = new Set<() => void>();
let draftRevision = 0;
function emitDrafts() { draftRevision++; for (const listener of draftListeners) listener(); }
export const subscribeDrafts = (listener: () => void) => { draftListeners.add(listener); return () => { draftListeners.delete(listener); }; };
export const draftSnapshot = () => draftRevision;
export const pendingDrafts = () => [...keptDrafts.values()];
export function hasPendingSaves() {
  return [...pendingSaves.values()].some((entry) => entry.dirty());
}
export async function flushPendingSaves() {
  await Promise.all([...pendingSaves.values()].map((entry) => entry.save()));
}
export function useAutosave<T extends object>(
  path: string,
  initial: T,
  method = "PATCH",
  onSaved?: (result: unknown) => void,
) {
  const draftKey = `${method}:${path}:${Object.keys(initial).sort().join(",")}`;
  const restored = keptDrafts.get(draftKey);
  const [draft, setDraft] = useState<T>(() => restored ? restored.value as T : initial);
  const [status, setStatus] = useState<
    "saved" | "saving" | "unsaved" | "error"
  >(restored ? "unsaved" : "saved");
  const [error, setError] = useState<Error>();
  const latest = useRef(draft);
  const dirty = useRef(!!restored);
  const version = useRef(0);
  const running = useRef<Promise<void> | null>(null);
  const callback = useRef(onSaved);
  useEffect(() => { callback.current = onSaved; }, [onSaved]);
  const save = useCallback(async function saveDraft(): Promise<void> {
    if (running.current) {
      await running.current;
      if (dirty.current) return saveDraft();
      return;
    }
    if (!dirty.current) return;
    const current = version.current;
    const sentDraft = latest.current;
    setStatus("saving");
    const request = api(path, { method, body: latest.current })
      .then((result) => {
        if (version.current === current) {
          dirty.current = false;
          if (keptDrafts.get(draftKey)?.value === sentDraft) keptDrafts.delete(draftKey);
          emitDrafts();
          setStatus("saved");
          setError(undefined);
          callback.current?.(result);
        }
      })
      .catch((error) => {
        setStatus("error");
        setError(error);
        throw error;
      })
      .finally(() => {
        running.current = null;
      });
    running.current = request;
    await request;
  }, [path, method, draftKey]);
  const update = useCallback(
    (next: Partial<T> | ((current: T) => Partial<T>)) => {
      dirty.current = true;
      version.current++;
      setStatus("unsaved");
      const nextDraft = {
        ...latest.current,
        ...(typeof next === "function" ? next(latest.current) : next),
      };
      latest.current = nextDraft;
      keptDrafts.set(draftKey, {value: nextDraft, href: window.location.pathname + window.location.search});
      emitDrafts();
      setDraft(nextDraft);
    },
    [draftKey],
  );
  useEffect(() => {
    pendingSaves.set(draftKey, { save, dirty: () => dirty.current });
    return () => {
      if (!dirty.current) pendingSaves.delete(draftKey);
      else void save().then(() => { if (pendingSaves.get(draftKey)?.save === save) pendingSaves.delete(draftKey); }).catch(() => {});
    };
  }, [draftKey, save]);
  useEffect(() => {
    if (!dirty.current) return;
    const timer = window.setTimeout(() => {
      void save().catch(() => {});
    }, 800);
    return () => window.clearTimeout(timer);
  }, [draft, save]);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (dirty.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, []);
  return {
    draft,
    update,
    status,
    error,
    retry: () => {
      void save().catch(() => {});
    },
    save,
  };
}
