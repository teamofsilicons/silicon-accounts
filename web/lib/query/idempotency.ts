"use client";

/**
 * Idempotency-Keys per logical action (the contract: "retrying something never does it twice").
 *
 * One key belongs to one action with one input: a person who presses "Create" again after a lost answer sends the same
 * key, so the server replays its stored answer instead of creating twice. The key changes only when the input changes
 * or the action succeeded (the review of the Solid build found fresh keys per click turning a retry into a second ATA
 * proof). The idempotent mutation hooks in lib/query use this; reach for it directly for custom calls:
 *
 *   const keys = useIdempotencyKey();
 *   await api.apps.webhook.set(appId, url, { idempotencyKey: keys.for({ appId, url }) });
 *   keys.reset();
 */
import { useMemo, useRef } from "react";
import { useMutation, type UseMutationOptions, type UseMutationResult } from "@tanstack/react-query";
import { newIdempotencyKey } from "../api/http";
import type { ApiError } from "../api/errors";

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
