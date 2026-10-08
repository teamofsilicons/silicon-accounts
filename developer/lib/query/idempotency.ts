"use client";

/**
 * Idempotency-Keys per logical action (the contract: "retrying something never does it twice").
 *
 * One key belongs to one action with one input: a person who presses "Create" again after a lost answer sends the same
 * key, so the server replays its stored answer instead of creating twice. The key changes only when the input changes
 * or the action succeeded (the review of the Solid build found fresh keys per click turning a retry into a second App verification
 * proof). The idempotent mutation hooks in lib/query use this; reach for it directly for custom calls:
 *
 *   const keys = useIdempotencyKey();
 *   await api.apps.webhook.set(appId, url, { idempotencyKey: keys.for({ appId, url }) });
 *   keys.reset();
 */
import { useCallback, useMemo, useRef } from "react";
import { useMutation, type UseMutationOptions, type UseMutationResult } from "@tanstack/react-query";
import { newIdempotencyKey } from "../api/http";
import type { ApiError } from "../api/errors";
import type { QueryMeta } from "./client";

/** A stable text for any input: object keys sorted, files described by name, size, type and date. */
export function stableSignature(value: unknown): string {
  const seen = new WeakSet<object>();
  const walk = (input: unknown): unknown => {
    if (typeof Blob !== "undefined" && input instanceof Blob) {
      const file = input as Blob & { name?: string; lastModified?: number };
      return `blob:${file.name ?? ""}:${file.size}:${file.type}:${file.lastModified ?? ""}`;
    }
    if (input === undefined) return null;
    if (input === null || typeof input !== "object") return input;
    if (seen.has(input)) return "[cycle]";
    seen.add(input);
    if (Array.isArray(input)) return input.map(walk);
    return Object.fromEntries(Object.keys(input as Record<string, unknown>).sort().map(key => [key, walk((input as Record<string, unknown>)[key])]));
  };
  return JSON.stringify(walk(value));
}

export interface IdempotencyKeys {
  /** The key for this input: the same while the input is unchanged and has not succeeded yet, a new one otherwise. */
  for: (input: unknown) => string;
  /** Call after success: the next action gets a fresh key. */
  reset: () => void;
}

export function useIdempotencyKey(): IdempotencyKeys {
  const current = useRef<{ signature: string; key: string } | null>(null);
  return useMemo(() => ({
    for(input: unknown) {
      const signature = stableSignature(input);
      if (!current.current || current.current.signature !== signature) current.current = { signature, key: newIdempotencyKey() };
      return current.current.key;
    },
    reset() {
      current.current = null;
    },
  }), []);
}

/**
 * useMutation for an endpoint the server makes idempotent: `fn` receives the variables and the key for them. The key is
 * kept across retries of the same input and dropped after success.
 */
export function useIdempotentMutation<TData, TVariables>(
  fn: (variables: TVariables, idempotencyKey: string) => Promise<TData>,
  options: Omit<UseMutationOptions<TData, ApiError, TVariables>, "mutationFn"> = {},
): UseMutationResult<TData, ApiError, TVariables> {
  const keys = useIdempotencyKey();
  const { onSuccess, ...rest } = options;
  return useMutation<TData, ApiError, TVariables>({
    ...rest,
    mutationFn: variables => fn(variables, keys.for(variables)),
    onSuccess: (...args) => {
      keys.reset();
      return onSuccess?.(...args);
    },
  });
}

export interface SecretMutation<TData, TVariables> {
  /** Runs the action and resolves with its answer (the secret is the caller's to hand over); rejects on failure. */
  run: (variables: TVariables) => Promise<TData>;
  isPending: boolean;
}

/**
 * An action whose answer carries a secret shown once: a generated or chosen STK, a webhook signing secret, a proof
 * token. The answer must live only where it is shown, so the mutation is never kept: `run(input)` resolves with the
 * answer and then resets the mutation, and nothing is cached after that (gcTime 0) — not the answer, not the input (a
 * chosen STK is input). A failure keeps its Idempotency-Key, so a retry of the same input reuses it (the server
 * replays a lost answer for 10 minutes instead of acting twice); `fn` may ignore the key when the endpoint takes none.
 * Failures toast through the shared client unless `meta.toast` is false; `run` rejects either way.
 */
export function useSecretMutation<TData, TVariables = void>(
  fn: (variables: TVariables, idempotencyKey: string) => Promise<TData>,
  options: { onSuccess?: (data: TData, variables: TVariables) => void; meta?: QueryMeta } = {},
): SecretMutation<TData, TVariables> {
  const mutation = useIdempotentMutation<TData, TVariables>(fn, { gcTime: 0, onSuccess: options.onSuccess, meta: options.meta });
  const { mutateAsync, reset } = mutation;
  const run = useCallback(async (variables: TVariables): Promise<TData> => {
    try {
      return await mutateAsync(variables);
    } finally {
      reset();
    }
  }, [mutateAsync, reset]);
  return { run, isPending: mutation.isPending };
}
