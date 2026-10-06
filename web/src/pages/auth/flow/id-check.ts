/**
 * Live availability of the c:id on the sign-up page. Format slips are caught as you type (the server's rules: 3 to
 * 30 of a-z, 0-9, - and _); a well-formed id is asked about after a short pause (GET /v1/ids/available, rate limited
 * per network, so typing never floods it). When it is taken, a few free ids built from it are offered instead.
 */
import { createEffect, createSignal, onCleanup, untrack, type Accessor } from "solid-js";
import { ApiError, api } from "../../../api";

export type IdStatus = "idle" | "checking" | "available" | "unavailable" | "invalid" | "own" | "unknown";

export interface IdCheck {
  status: Accessor<IdStatus>;
  message: Accessor<string | null>;
  /** Free handles (without `c:`) to offer when the typed one is not available. */
  suggestions: Accessor<string[]>;
  /** Replaces the suggestions (for example with the server's after a 409 id_taken). */
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
  handle: Accessor<string>;
  /** A handle that already belongs to this sign-up (an imported account's own id): never checked. */
  own?: Accessor<string | null>;
  /** For suggestions. */
  displayName: Accessor<string>;
  dob: Accessor<string | null>;
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

export function createIdCheck(options: IdCheckOptions): IdCheck {
  // The first verdict is known before the first paint, so field messages render with the field (no late flip).
  const first = untrack(() => judge(options.handle(), options.own?.() ?? null));
  const [status, setStatus] = createSignal<IdStatus>(first.status);
  const [message, setMessage] = createSignal<string | null>(first.message);
  const [suggestions, setSuggestions] = createSignal<string[]>([]);
  let timer: number | undefined;
  let controller: AbortController | undefined;
  onCleanup(() => {
    window.clearTimeout(timer);
    controller?.abort();
  });

  const suggest = async (handle: string, signal: AbortSignal) => {
    const candidates = candidateHandles(handle, untrack(options.displayName), untrack(options.dob)).slice(0, 4);
    const answers = await Promise.all(candidates.map(candidate => api.ids.available(`c:${candidate}`, signal).then(answer => (answer.available ? candidate : null)).catch(() => null)));
    if (!signal.aborted) setSuggestions(answers.filter((value): value is string => !!value).slice(0, 3));
  };

  createEffect(() => {
    const handle = options.handle();
    const own = options.own?.() ?? null;
    window.clearTimeout(timer);
    controller?.abort();
    controller = undefined;
    setSuggestions([]);
    const verdict = judge(handle, own);
    setStatus(verdict.status);
    setMessage(verdict.message);
    if (verdict.status !== "checking") return;
    timer = window.setTimeout(async () => {
      const current = new AbortController();
      controller = current;
      try {
        const answer = await api.ids.available(`c:${handle}`, current.signal);
        if (current.signal.aborted) return;
        if (answer.available) {
          setStatus("available");
          setMessage(answer.reclaimable ? answer.message : `c:${handle} is available.`);
          return;
        }
        setStatus(answer.reason === "invalid" ? "invalid" : "unavailable");
        setMessage(answer.message);
        if (answer.reason === "taken" || answer.reason === "reserved" || answer.reason === "reserved_word") await suggest(handle, current.signal);
      } catch (raw) {
        if (current.signal.aborted) return;
        const error = ApiError.from(raw);
        // Not knowing is not a reason to block: the server checks again when the account is created.
        setStatus("unknown");
        setMessage(error.status === 429 ? "Checking ids paused for a moment (too many checks). The id is checked again when you continue." : null);
      }
    }, options.debounce ?? 320);
  });

  return { status, message, suggestions, setSuggestions };
}
