"use client";

/**
 * Live availability of the c:id on the sign-up page. Format slips are caught as you type (the server's rules: 3 to
 * 30 of a-z, 0-9, - and _); a well-formed id is asked about after a short pause (GET /v1/ids/available, rate limited
 * per network, so typing never floods it). When it is taken, a few free ids built from it are offered instead.
 */
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api/endpoints";
import { ApiError } from "@/lib/api/errors";

export type IdStatus = "checking" | "available" | "unavailable" | "invalid" | "own" | "unknown";

export interface IdCheck {
  status: IdStatus;
  message: string | null;
  /** Free handles (without `c:`) to offer when the typed one is not available. */
  suggestions: string[];
  /** Replaces the suggestions for the current handle (for example with the server's after a 409 id_taken). */
  setSuggestions: (handles: string[]) => void;
}

const HANDLE = /^[a-z0-9_-]+$/;

/** Lowercases and drops a typed `c:` prefix and surrounding spaces. */
export function cleanHandle(input: string): string {
  return input.trim().toLowerCase().replace(/^c:/, "");
}

/** The server's format rules, in the same words, so most slips never cost a request. */
export function handleProblem(handle: string): string | null {
  if (!handle) return "Choose an id: 3 to 30 characters of a to z, 0 to 9, - and _.";
  const bad = [...handle].find(char => !HANDLE.test(char));
  if (bad) return `"${bad === " " ? "space" : bad}" can't be in an id. Use a to z, 0 to 9, - and _.`;
  if (handle.length < 3) return `c:${handle} is too short: an id needs at least 3 characters after c:.`;
  if (handle.length > 30) return `That id is ${handle.length} characters: an id can have at most 30 after c:.`;
  return null;
}

/** Ids to offer instead of a taken one: numbered, from the name, and with the birth year. */
export function candidateHandles(handle: string, displayName: string, dob: string | null): string[] {
  const base = handle.replace(/[-_]+$/, "").slice(0, 26) || "carbon";
  const words = displayName.toLowerCase().normalize("NFKD").replace(/[^a-z0-9\s_-]/g, "").split(/[\s_-]+/).filter(Boolean);
  const year = dob && /^\d{4}/.test(dob) ? dob.slice(2, 4) : null;
  const out = [
    `${base}-2`,
    words.length >= 2 ? `${words[0]}-${words[words.length - 1]}` : null,
    year ? `${base}${year}` : null,
    `${base}-${Math.floor(Math.random() * 90) + 10}`,
    `${base}-3`,
  ];
  const seen = new Set<string>([handle]);
  return out.filter((value): value is string => {
    if (!value || seen.has(value) || handleProblem(value)) return false;
    seen.add(value);
    return true;
  });
}

export interface IdCheckOptions {
  /** The handle being edited (without `c:`). */
  handle: string;
  /** A handle that already belongs to this sign-up (an imported account's own id): never checked. */
  own?: string | null;
  /** For suggestions. */
  displayName: string;
  dob: string | null;
  /** Milliseconds to wait after typing stops. */
  debounce?: number;
}

/** What can be said about a handle without asking the server. */
function judge(handle: string, own: string | null): { status: IdStatus; message: string | null } {
  const problem = handleProblem(handle);
  if (problem) return { status: "invalid", message: problem };
  if (own && handle === own) return { status: "own", message: null };
  return { status: "checking", message: null };
}

interface Answer {
  handle: string;
  status: IdStatus;
  message: string | null;
}

export function useIdCheck({ handle, own = null, displayName, dob, debounce = 320 }: IdCheckOptions): IdCheck {
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [offered, setOffered] = useState<{ handle: string; list: string[] } | null>(null);
  // Suggestions are built from the name and date of birth at the moment of asking, not on every keystroke there.
  const context = useRef({ displayName, dob });
  useEffect(() => {
    context.current = { displayName, dob };
  });
  const verdict = judge(handle, own);

  useEffect(() => {
    if (judge(handle, own).status !== "checking") return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const result = await api.ids.available(`c:${handle}`, controller.signal);
        if (controller.signal.aborted) return;
        if (result.available) {
          setAnswer({ handle, status: "available", message: result.reclaimable ? result.message : `c:${handle} is available.` });
          return;
        }
        setAnswer({ handle, status: result.reason === "invalid" ? "invalid" : "unavailable", message: result.message });
        if (result.reason !== "taken" && result.reason !== "reserved" && result.reason !== "reserved_word") return;
        const candidates = candidateHandles(handle, context.current.displayName, context.current.dob).slice(0, 4);
        const free = await Promise.all(candidates.map(candidate => api.ids.available(`c:${candidate}`, controller.signal).then(reply => (reply.available ? candidate : null)).catch(() => null)));
        if (!controller.signal.aborted) setOffered({ handle, list: free.filter((value): value is string => !!value).slice(0, 3) });
      } catch (raw) {
        if (controller.signal.aborted) return;
        const error = ApiError.from(raw);
        // Not knowing is not a reason to block: the server checks again when the account is created.
        setAnswer({ handle, status: "unknown", message: error.status === 429 ? "Checking ids paused for a moment (too many checks). The id is checked again when you continue." : null });
      }
    }, debounce);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [handle, own, debounce]);

  const settled = verdict.status === "checking" && answer?.handle === handle ? answer : null;
  return {
    status: settled?.status ?? verdict.status,
    message: settled ? settled.message : verdict.message,
    suggestions: offered?.handle === handle ? offered.list : [],
    setSuggestions: list => setOffered({ handle, list }),
  };
}
