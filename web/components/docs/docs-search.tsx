"use client";

/**
 * Docs search: a button in the header (⌘K, Ctrl K or / from anywhere on a docs page) opens a dialog that searches
 * every page and section in the browser. The index (/docs/search-index.json) loads the first time the button is
 * pointed at, focused or used, then stays for the visit; ranking is lib/docs/search.ts.
 *
 * The field is a combobox over a listbox of results: arrows move, Enter opens, Escape clears the field and then closes.
 */
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { CornerDownLeft, FileText, Hash, Search, X } from "lucide-react";
import { DOCS_BASE } from "@/lib/docs/site";
import { prepareIndex, searchDocs, type PreparedRecord, type SearchHit, type SearchRecord } from "@/lib/docs/search";
import type { SearchSuggestion } from "@/lib/docs/types";
import styles from "./docs-search.module.css";

type IndexState = { status: "idle" | "loading" | "ready" | "failed"; records: PreparedRecord[]; error: string | null };

let indexState: IndexState = { status: "idle", records: [], error: null };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(listener => listener());

/** Loads the index once per visit (again after a failure, when asked). */
function loadIndex() {
  if (indexState.status === "loading" || indexState.status === "ready") return;
  indexState = { ...indexState, status: "loading", error: null };
  emit();
  fetch(`${DOCS_BASE}/search-index.json`, { headers: { Accept: "application/json" } })
    .then(async response => {
      if (!response.ok) throw new Error(`the search index answered ${response.status} ${response.statusText}`.trim());
      const records = (await response.json()) as SearchRecord[];
      indexState = { status: "ready", records: prepareIndex(records), error: null };
    })
    .catch((error: unknown) => {
      indexState = { status: "failed", records: [], error: error instanceof Error ? error.message : String(error) };
    })
    .finally(emit);
}

function useIndex(): IndexState {
  return useSyncExternalStore(
    listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => indexState,
    () => indexState,
  );
}

const subscribeNothing = () => () => undefined;
const isApplePlatform = () => /mac|iphone|ipad|ipod/i.test((navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? "");

/** True when a key press belongs to a text field, so "/" never steals typing. */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target.tagName === "TEXTAREA" || target.tagName === "SELECT") return true;
  return target.tagName === "INPUT" && !["button", "checkbox", "radio", "submit", "reset", "range", "color", "file"].includes((target as HTMLInputElement).type);
}

function Snippet({ hit }: { hit: SearchHit }) {
  return <>{hit.snippet.map((part, index) => (part.mark ? <mark key={index}>{part.text}</mark> : <span key={index}>{part.text}</span>))}</>;
}

export function DocsSearch({ suggestions }: { suggestions: SearchSuggestion[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const index = useIndex();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const lastPointer = useRef({ x: -1, y: -1 });
  const id = useId().replace(/:/g, "");
  const apple = useSyncExternalStore(subscribeNothing, isApplePlatform, () => true);

  const hits = useMemo(() => (index.status === "ready" && query.trim() ? searchDocs(index.records, query) : []), [index, query]);
  const showingSuggestions = !query.trim();
  const options: Array<{ href: string; key: string }> = showingSuggestions ? suggestions.map(entry => ({ href: entry.href, key: entry.href })) : hits.map(hit => ({ href: hit.record.u, key: hit.record.u }));
  const activeIndex = Math.min(active, Math.max(options.length - 1, 0));

  const show = useCallback(() => {
    loadIndex();
    setOpen(true);
  }, []);

  // ⌘K / Ctrl K anywhere, and "/" when not typing, open the search.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (open) setOpen(false);
        else show();
        return;
      }
      if (event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey && !open && !isTyping(event.target)) {
        event.preventDefault();
        show();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, show]);

  // The highlighted result stays in view while moving with the arrows.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const go = (href: string, event?: ReactMouseEvent) => {
    // ⌘/Ctrl-click opens the result in a new tab and keeps the search open.
    if (event && (event.metaKey || event.ctrlKey || event.shiftKey)) {
      window.open(href, "_blank", "noopener");
      return;
    }
    setOpen(false);
    setQuery("");
    setActive(0);
    router.push(href);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive(value => (options.length ? (Math.min(value, options.length - 1) + 1) % options.length : 0));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive(value => (options.length ? (Math.min(value, options.length - 1) - 1 + options.length) % options.length : 0));
    } else if (event.key === "Home" && options.length) {
      event.preventDefault();
      setActive(0);
    } else if (event.key === "End" && options.length) {
      event.preventDefault();
      setActive(options.length - 1);
    } else if (event.key === "Enter") {
      const target = options[activeIndex];
      if (target) {
        event.preventDefault();
        go(target.href);
      }
    }
  };

  const optionId = (position: number) => `docs-search-${id}-${position}`;
  const pointerMove = (position: number) => (event: ReactPointerEvent) => {
    if (event.clientX === lastPointer.current.x && event.clientY === lastPointer.current.y) return;
    lastPointer.current = { x: event.clientX, y: event.clientY };
    setActive(position);
  };

  let status: string;
  if (showingSuggestions) status = "Suggested pages";
  else if (index.status === "loading" || index.status === "idle") status = "Loading the search index…";
  else if (index.status === "failed") status = "Search is unavailable";
  else status = hits.length ? `${hits.length === 24 ? "Top 24" : hits.length} result${hits.length === 1 ? "" : "s"}` : "No results";

  return (
    <DialogPrimitive.Root open={open} onOpenChange={next => (next ? show() : setOpen(false))}>
      <DialogPrimitive.Trigger asChild>
        <button
          type="button"
          className={styles.trigger}
          data-sq="surface"
          aria-keyshortcuts={apple ? "Meta+K /" : "Control+K /"}
          onPointerEnter={loadIndex}
          onFocus={loadIndex}
        >
          <Search size={16} strokeWidth={1.75} aria-hidden="true" />
          <span className={styles.triggerLabel}>Search the docs</span>
          <kbd className={styles.triggerKey} data-sq="surface">{apple ? "⌘ K" : "Ctrl K"}</kbd>
        </button>
      </DialogPrimitive.Trigger>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className={styles.overlay} />
        <div className={styles.positioner}>
          <DialogPrimitive.Content
            className={styles.panel}
            data-sq="clip"
            aria-describedby={undefined}
            onOpenAutoFocus={event => {
              event.preventDefault();
              inputRef.current?.focus();
            }}
            onEscapeKeyDown={event => {
              // The first Escape clears the field; the next one closes the search.
              if (!query) return;
              event.preventDefault();
              setQuery("");
              setActive(0);
            }}
          >
            <DialogPrimitive.Title className="sr-only">Search the docs</DialogPrimitive.Title>
            <div className={styles.searchRow}>
              <Search size={18} strokeWidth={1.75} aria-hidden="true" className={styles.searchIcon} />
              <input
                ref={inputRef}
                className={styles.input}
                type="search"
                role="combobox"
                aria-label="Search the docs"
                aria-autocomplete="list"
                aria-expanded="true"
                aria-controls={`docs-search-${id}-list`}
                aria-activedescendant={options.length ? optionId(activeIndex) : undefined}
                placeholder="Search pages, endpoints, errors, commands…"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                enterKeyHint="go"
                value={query}
                onChange={event => {
                  setQuery(event.target.value);
                  setActive(0);
                }}
                onKeyDown={onKeyDown}
              />
              {query ? (
                <button type="button" className={styles.clear} aria-label="Clear the search" onClick={() => { setQuery(""); setActive(0); inputRef.current?.focus(); }}>
                  <X size={15} strokeWidth={1.75} aria-hidden="true" />
                </button>
              ) : null}
              <DialogPrimitive.Close className={styles.close}>Esc</DialogPrimitive.Close>
            </div>

            <div className={styles.status} role="status" aria-live="polite">{status}</div>

            {index.status === "failed" && !showingSuggestions ? (
              <div className={styles.empty}>
                <strong>The search index could not be loaded</strong>
                <span>{index.error}. Check the connection, then try again.</span>
                <button type="button" className={styles.retry} data-sq="surface" onClick={loadIndex}>Try again</button>
              </div>
            ) : !showingSuggestions && index.status === "ready" && !hits.length ? (
              <div className={styles.empty}>
                <strong>No page mentions “{query.trim()}”</strong>
                <span>Every word has to appear. Try fewer words, an endpoint such as /v1/oauth/token, an error code such as invalid_grant, or a command such as accounts login.</span>
              </div>
            ) : (
              <ul ref={listRef} id={`docs-search-${id}-list`} className={styles.results} role="listbox" aria-label={showingSuggestions ? "Suggested pages" : "Search results"}>
                {showingSuggestions
                  ? suggestions.map((entry, position) => (
                      <li key={entry.href} id={optionId(position)} role="option" aria-selected={position === activeIndex} data-index={position} className={styles.result} data-active={position === activeIndex ? "" : undefined} onPointerMove={pointerMove(position)} onClick={event => go(entry.href, event)}>
                        <span className={styles.resultIcon} aria-hidden="true"><FileText size={16} strokeWidth={1.75} /></span>
                        <span className={styles.resultText}>
                          <span className={styles.resultTitle}>{entry.title}</span>
                        </span>
                        <span className={styles.resultGroup}>{entry.group}</span>
                      </li>
                    ))
                  : hits.map((hit, position) => (
                      <li key={hit.record.u} id={optionId(position)} role="option" aria-selected={position === activeIndex} data-index={position} className={styles.result} data-active={position === activeIndex ? "" : undefined} onPointerMove={pointerMove(position)} onClick={event => go(hit.record.u, event)}>
                        <span className={styles.resultIcon} aria-hidden="true">{hit.record.h ? <Hash size={16} strokeWidth={1.75} /> : <FileText size={16} strokeWidth={1.75} />}</span>
                        <span className={styles.resultText}>
                          <span className={styles.resultTitle}>{hit.record.h ?? hit.record.t}</span>
                          <span className={styles.resultSnippet}>
                            {hit.record.h ? <span className={styles.resultPage}>{hit.record.t} · </span> : null}
                            <Snippet hit={hit} />
                          </span>
                        </span>
                        <span className={styles.resultGroup}>{hit.record.g}</span>
                      </li>
                    ))}
              </ul>
            )}

            <div className={styles.footer} aria-hidden="true">
              <span><kbd>↑</kbd><kbd>↓</kbd> to choose</span>
              <span><kbd><CornerDownLeft size={11} strokeWidth={2} /></kbd> to open</span>
              <span><kbd>esc</kbd> to close</span>
              <span className={styles.footerNote}>Searches in your browser</span>
            </div>
          </DialogPrimitive.Content>
        </div>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
