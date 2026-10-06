import { Check, ChevronDown, ChevronRight, ChevronUp, ChevronsDownUp, ChevronsUpDown, Copy, Link2, Search, X } from "lucide-solid";
import { For, Show, createEffect, createMemo, createSignal, createUniqueId, on, onCleanup, onMount, untrack, type JSX } from "solid-js";
import { Presence, Swap } from "../lib/presence";
import { createPresenceList } from "../lib/presence-list";
import { copyText as writeClipboard } from "../lib/copy";
import { animate, instant, motionTokens, prefersReducedMotion, spring, tween, type AnimationControls } from "../lib/motion";
import { cx } from "../lib/cx";
import { useSquircle } from "../lib/squircle";
import styles from "./json-viewer.module.css";

export type JsonValueType = "object" | "array" | "string" | "number" | "boolean" | "null" | "other";

export interface JsonViewerCopyDetail {
  kind: "value" | "path";
  path: string;
  text: string;
}

export interface JsonViewerProps {
  data: unknown;
  /** Name of the root in paths, as in `root.users[0].name`. Defaults to "root". */
  rootName?: string;
  /** Levels open on first render when `defaultExpanded` is not set. Defaults to 1, which opens the root. */
  defaultExpandDepth?: number;
  /** Paths of open branches (controlled). */
  expanded?: string[];
  defaultExpanded?: string[];
  onExpandedChange?: (paths: string[]) => void;
  /** Show the search field. Defaults to true. */
  searchable?: boolean;
  query?: string;
  defaultQuery?: string;
  onQueryChange?: (query: string) => void;
  /** Children shown per page in a long array or object. Defaults to 50. */
  pageSize?: number;
  /** Show copy value and copy path actions. Defaults to true. */
  copyable?: boolean;
  onCopy?: (detail: JsonViewerCopyDetail) => void;
  /** Called when a row becomes the current one. */
  onSelect?: (detail: { path: string; value: unknown; type: JsonValueType }) => void;
  /** Show the path of the current row under the tree. Defaults to true. */
  showPath?: boolean;
  /** Height of the scrolling tree area. Defaults to 420px. */
  maxHeight?: number | string;
  /** Accessible name of the tree. */
  label?: string;
  class?: string;
}

interface Row {
  id: string;
  kind: "node" | "more";
  level: number;
  name: string | number | null;
  value: unknown;
  type: JsonValueType;
  count: number;
  open: boolean;
  parent: string | null;
  posinset: number;
  setsize: number;
  /** For "more" rows: how many children are still hidden. */
  hidden?: number;
}

const ROW = 30;
const PAD = 6;
const IDENT = /^[A-Za-z_$][\w$]*$/;

function typeOf(value: unknown): JsonValueType {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "object": return "object";
    case "string": return "string";
    case "number": case "bigint": return "number";
    case "boolean": return "boolean";
    default: return "other";
  }
}
const isBranch = (type: JsonValueType) => type === "object" || type === "array";
function entries(value: unknown): [string | number, unknown][] {
  if (Array.isArray(value)) return value.map((item, index) => [index, item]);
  if (value && typeof value === "object") return Object.entries(value as Record<string, unknown>);
  return [];
}
const childPath = (parent: string, key: string | number) => (typeof key === "number" ? `${parent}[${key}]` : IDENT.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`);
const within = (ancestor: string, id: string) => id === ancestor || id.startsWith(`${ancestor}.`) || id.startsWith(`${ancestor}[`);
function primitiveText(value: unknown, type: JsonValueType) {
  if (type === "string") return value as string;
  if (type === "null") return "null";
  return String(value);
}
function valueText(value: unknown, type: JsonValueType) {
  if (type === "string") return value as string;
  if (isBranch(type)) return JSON.stringify(value, null, 2);
  return primitiveText(value, type);
}
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const countLabel = (row: { type: JsonValueType; count: number }) => (row.type === "array" ? plural(row.count, "item", "items") : plural(row.count, "key", "keys"));

function allBranches(data: unknown, rootName: string) {
  const out: string[] = [];
  const visit = (value: unknown, id: string) => {
    if (!isBranch(typeOf(value))) return;
    out.push(id);
    for (const [key, child] of entries(value)) visit(child, childPath(id, key));
  };
  visit(data, rootName);
  return out;
}
function branchesToDepth(data: unknown, rootName: string, depth: number) {
  const out: string[] = [];
  const visit = (value: unknown, id: string, level: number) => {
    if (level >= depth || !isBranch(typeOf(value))) return;
    out.push(id);
    for (const [key, child] of entries(value)) visit(child, childPath(id, key), level + 1);
  };
  visit(data, rootName, 0);
  return out;
}

interface SearchResult { matches: string[]; ancestors: Set<string>; needed: Map<string, number> }
/** Finds keys and primitive values that contain the query, the branches that hold them, and how far each page must reach. */
function searchJson(data: unknown, rootName: string, needle: string): SearchResult {
  const matches: string[] = [];
  const ancestors = new Set<string>();
  const needed = new Map<string, number>();
  const frames: [string, number][] = [];
  const visit = (value: unknown, id: string, name: string | number | null) => {
    if (matches.length >= 2000) return;
    const type = typeOf(value);
    const keyHit = typeof name === "string" && name.toLowerCase().includes(needle);
    const valueHit = !isBranch(type) && primitiveText(value, type).toLowerCase().includes(needle);
    if (keyHit || valueHit) {
      matches.push(id);
      for (const [frame, index] of frames) {
        ancestors.add(frame);
        needed.set(frame, Math.max(needed.get(frame) ?? 0, index + 1));
      }
    }
    if (!isBranch(type)) return;
    entries(value).forEach(([key, child], index) => {
      frames.push([id, index]);
      visit(child, childPath(id, key), key);
      frames.pop();
    });
  };
  visit(data, rootName, null);
  return { matches, ancestors, needed };
}

function Highlight(props: { text: string; needle: string; current: boolean }) {
  const parts = createMemo(() => {
    const needle = props.needle;
    const text = props.text;
    if (!needle) return [{ text, hit: false }];
    const lower = text.toLowerCase();
    const out: Array<{ text: string; hit: boolean }> = [];
    let from = 0;
    let at = lower.indexOf(needle);
    while (at !== -1) {
      if (at > from) out.push({ text: text.slice(from, at), hit: false });
      out.push({ text: text.slice(at, at + needle.length), hit: true });
      from = at + needle.length;
      at = lower.indexOf(needle, from);
    }
    if (from < text.length) out.push({ text: text.slice(from), hit: false });
    return out;
  });
  return <For each={parts()}>{part => (part.hit ? <mark class={styles.mark} data-current={props.current || undefined}>{part.text}</mark> : part.text)}</For>;
}

type CopyState = "idle" | "done" | "error";
/** Icon-only copy action. The glyph swaps in place, so the button never changes width. */
function CopyAction(props: { label: string; icon: "copy" | "link"; onCopy: () => Promise<void>; class?: string; focusable?: boolean }) {
  const [state, setState] = createSignal<CopyState>("idle");
  let timer = 0;
  onCleanup(() => window.clearTimeout(timer));
  const run = async () => {
    window.clearTimeout(timer);
    try { await props.onCopy(); setState("done"); } catch { setState("error"); }
    timer = window.setTimeout(() => setState("idle"), 1400);
  };
  return (
    <button
      type="button"
      tabIndex={props.focusable ? undefined : -1}
      class={cx(styles.action, props.class)}
      data-state={state()}
      aria-label={state() === "done" ? "Copied" : state() === "error" ? "Copy failed" : props.label}
      title={props.label}
      onClick={event => { event.stopPropagation(); void run(); }}
    >
      <Swap
        value={state()}
        class={styles.actionGlyph}
        enter={el => animate(el, { opacity: [0, 1], scale: prefersReducedMotion() ? 1 : [0.6, 1] }, prefersReducedMotion() ? tween(motionTokens.duration.instant) : { ...spring.snappy, opacity: tween(motionTokens.duration.instant) })}
        exit={el => animate(el, { opacity: 0, scale: prefersReducedMotion() ? 1 : 0.6 }, tween(motionTokens.duration.instant))}
      >
        {value => (value === "done"
          ? <Check size={14} stroke-width={2} aria-hidden="true" />
          : value === "error"
            ? <X size={14} stroke-width={2} aria-hidden="true" />
            : props.icon === "link" ? <Link2 size={14} stroke-width={1.75} aria-hidden="true" /> : <Copy size={14} stroke-width={1.75} aria-hidden="true" />)}
      </Swap>
    </button>
  );
}

/**
 * Arc JsonViewer: a collapsible tree for JSON (webhook payloads). Values are coloured by type, branches unfold row by
 * row, search highlights every match and opens the branches that hold them, long arrays and objects load in pages, and
 * each row can copy its value or path. WAI-ARIA tree pattern: arrows move and open, Home and End jump, Enter toggles,
 * the modifier key with C copies the focused value, and "/" jumps to search.
 */
export function JsonViewer(props: JsonViewerProps) {
  const uid = createUniqueId();
  const rootName = () => props.rootName ?? "root";
  const pageSize = () => props.pageSize ?? 50;
  const copyable = () => props.copyable !== false;
  let tree: HTMLDivElement | undefined;
  let searchInput: HTMLInputElement | undefined;
  let highlightEl: HTMLSpanElement | undefined;
  const rowRefs = new Map<string, HTMLDivElement>();

  // Open branches.
  const [expandedInternal, setExpandedInternal] = createSignal<string[]>(untrack(() => props.defaultExpanded ?? branchesToDepth(props.data, rootName(), props.defaultExpandDepth ?? 1)));
  const base = createMemo(() => new Set(props.expanded ?? expandedInternal()));
  const setExpanded = (next: Set<string>) => {
    const list = [...next];
    if (props.expanded === undefined) setExpandedInternal(list);
    props.onExpandedChange?.(list);
  };

  // Search. Branches holding a match open on their own; closing one while searching is remembered until the query changes.
  const [queryInternal, setQueryInternal] = createSignal(untrack(() => props.defaultQuery ?? ""));
  const query = () => props.query ?? queryInternal();
  const needle = () => query().trim().toLowerCase();
  const setQuery = (next: string) => {
    if (props.query === undefined) setQueryInternal(next);
    props.onQueryChange?.(next);
  };
  const search = createMemo<SearchResult | null>(() => (needle() ? searchJson(props.data, rootName(), needle()) : null));
  const [closedWhileSearching, setClosedWhileSearching] = createSignal<{ needle: string; ids: Set<string> }>({ needle: "", ids: new Set() });
  const closed = () => (closedWhileSearching().needle === needle() ? closedWhileSearching().ids : null);
  const [matchIndex, setMatchIndex] = createSignal(0);
  const matchCount = () => search()?.matches.length ?? 0;
  const matchSet = createMemo(() => new Set(search()?.matches ?? []));
  const currentMatch = () => {
    const result = search();
    return result && matchCount() ? result.matches[Math.min(matchIndex(), matchCount() - 1)] : null;
  };
  const isOpen = (id: string) => {
    const result = search();
    if (result && result.ancestors.has(id)) return !closed()?.has(id);
    return base().has(id);
  };

  // Pages for long branches.
  const [pages, setPages] = createSignal<Record<string, number>>({});
  const limitOf = (id: string) => Math.max((pages()[id] ?? 1) * pageSize(), search()?.needed.get(id) ?? 0);

  // The visible rows, flat. Each row unfolds its own height, so nested branches, pages and expand all share one motion.
  const rows = createMemo(() => {
    const out: Row[] = [];
    const visit = (value: unknown, id: string, name: string | number | null, level: number, parent: string | null, posinset: number, setsize: number) => {
      const type = typeOf(value);
      const list = isBranch(type) ? entries(value) : [];
      const open = isBranch(type) && isOpen(id);
      out.push({ id, kind: "node", level, name, value, type, count: list.length, open, parent, posinset, setsize });
      if (!open) return;
      const limit = limitOf(id);
      const shown = list.slice(0, limit);
      const more = list.length - shown.length;
      const size = shown.length + (more > 0 ? 1 : 0);
      shown.forEach(([key, child], index) => visit(child, childPath(id, key), key, level + 1, id, index + 1, size));
      if (more > 0) out.push({ id: `${id}::more`, kind: "more", level: level + 1, name: null, value: null, type: "other", count: 0, open: false, parent: id, posinset: size, setsize: size, hidden: more });
    };
    visit(props.data, rootName(), null, 1, null, 1, 1);
    return out;
  });
  const rowById = createMemo(() => new Map(rows().map(row => [row.id, row])));
  const ids = createMemo(() => rows().map(row => row.id), undefined, { equals: (a, b) => a.length === b.length && a.every((value, index) => value === b[index]) });
  const { entries: presence, release } = createPresenceList(ids, id => id);

  // The current row. When it is folded away, the nearest visible branch that holds it takes over.
  const [activeRaw, setActiveRaw] = createSignal(untrack(rootName));
  const active = createMemo(() => {
    const raw = activeRaw();
    if (rowById().has(raw)) return raw;
    let best = rootName();
    for (const row of rows()) if (row.kind === "node" && within(row.id, raw) && row.id.length > best.length) best = row.id;
    return best;
  });
  const activeIndex = () => Math.max(0, rows().findIndex(row => row.id === active()));
  const activeRow = () => rows()[activeIndex()];

  let lastReported: string | null = null;
  createEffect(() => {
    const row = activeRow();
    if (!row || row.kind !== "node" || lastReported === row.id) return;
    lastReported = row.id;
    props.onSelect?.({ path: row.id, value: row.value, type: row.type });
  });

  // Scrolling keeps the current row in view, springing to where it will sit once rows finish unfolding.
  let scrollFlight: AnimationControls | undefined;
  const reveal = (index: number, center: boolean) => {
    if (!tree) return;
    const node = tree;
    const top = PAD + index * ROW;
    const bottom = top + ROW;
    const view = node.clientHeight;
    const now = node.scrollTop;
    let target = now;
    if (center) target = top - view / 2 + ROW / 2;
    else if (top < now + 4) target = top - 4;
    else if (bottom > now + view - 4) target = bottom - view + 4;
    target = Math.max(0, target);
    if (Math.abs(target - now) < 1) return;
    scrollFlight?.stop();
    if (prefersReducedMotion()) { node.scrollTop = target; return; }
    scrollFlight = animate(now, target, { ...spring.smooth, onUpdate: value => { node.scrollTop = value; } });
  };
  onCleanup(() => scrollFlight?.stop());

  // The highlight travels to where the current row will settle (rows have one fixed height).
  let highlightShown = false;
  createEffect(on([activeIndex, active, activeRaw], ([index, current, raw]) => {
    if (!highlightEl) return;
    const folded = current !== raw;
    const y = PAD + index * ROW + 1;
    animate(highlightEl, { y, opacity: 1 }, !highlightShown || folded || prefersReducedMotion() ? instant : { y: spring.smooth, opacity: instant });
    highlightShown = true;
  }));

  let pendingFocus = false;
  let pendingReveal: "nearest" | "center" | null = null;
  const [navigation, setNavigation] = createSignal(0);
  createEffect(on([active, navigation], () => queueMicrotask(() => {
    if (pendingFocus) {
      pendingFocus = false;
      rowRefs.get(active())?.focus({ preventScroll: true });
    }
    if (pendingReveal) {
      reveal(activeIndex(), pendingReveal === "center");
      pendingReveal = null;
    }
  }), { defer: true }));
  const moveTo = (id: string, focus = true, how: "nearest" | "center" = "nearest") => {
    pendingFocus = focus;
    pendingReveal = how;
    setActiveRaw(id);
    setNavigation(count => count + 1);
  };

  const toggle = (id: string, next?: boolean) => {
    const open = isOpen(id);
    const want = next ?? !open;
    if (want === open) return;
    if (search()?.ancestors.has(id)) {
      const set = new Set(closed() ?? []);
      if (want) set.delete(id);
      else set.add(id);
      setClosedWhileSearching({ needle: needle(), ids: set });
      if (want && !base().has(id)) setExpanded(new Set(base()).add(id));
      return;
    }
    const set = new Set(base());
    if (want) set.add(id);
    else set.delete(id);
    setExpanded(set);
  };
  const expandAll = () => {
    setExpanded(new Set(allBranches(props.data, rootName())));
    setClosedWhileSearching({ needle: needle(), ids: new Set() });
    moveTo(active(), false, "nearest");
  };
  const collapseAll = () => {
    const rootOpen = isBranch(typeOf(props.data)) ? [rootName()] : [];
    setExpanded(new Set(rootOpen));
    setClosedWhileSearching({ needle: needle(), ids: new Set([...(search()?.ancestors ?? [])].filter(id => id !== rootName())) });
    setPages({});
    moveTo(rootName(), false, "nearest");
  };
  const showMore = (parent: string) => setPages(current => ({ ...current, [parent]: Math.ceil(limitOf(parent) / pageSize()) + 1 }));

  // Copy.
  const [announcement, setAnnouncement] = createSignal("");
  const copy = async (row: Row, kind: "value" | "path") => {
    const text = kind === "path" ? row.id : valueText(row.value, row.type);
    const ok = await writeClipboard(text);
    if (!ok) {
      setAnnouncement("Copy failed");
      throw new Error("The clipboard is not available here.");
    }
    setAnnouncement(`Copied ${kind === "path" ? "path" : "value of"} ${row.id}`);
    props.onCopy?.({ kind, path: row.id, text });
  };

  // Search navigation.
  const stepMatch = (step: number) => {
    const result = search();
    if (!result || !matchCount()) return;
    const next = (((Math.min(matchIndex(), matchCount() - 1) + step) % matchCount()) + matchCount()) % matchCount();
    setMatchIndex(next);
    moveTo(result.matches[next]!, false, "center");
  };
  const onQuery = (next: string) => {
    const hadNeedle = !!needle();
    setQuery(next);
    setMatchIndex(0);
    const trimmed = next.trim().toLowerCase();
    if (trimmed) {
      const first = searchJson(props.data, rootName(), trimmed).matches[0];
      if (first) moveTo(first, false, "center");
    } else if (hadNeedle) moveTo(activeRaw(), false, "nearest");
  };
  const onSearchKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Enter") { event.preventDefault(); stepMatch(event.shiftKey ? -1 : 1); }
    else if (event.key === "Escape" && query()) { event.preventDefault(); event.stopPropagation(); onQuery(""); }
    else if (event.key === "ArrowDown" && !event.altKey) { event.preventDefault(); moveTo(active(), true); }
  };
  const onTreeKeyDown = (event: KeyboardEvent) => {
    const list = rows();
    const index = activeIndex();
    const row = list[index];
    if (!row || event.altKey) return;
    const mod = event.metaKey || event.ctrlKey;
    if (mod && event.key.toLowerCase() === "c") {
      if (row.kind === "node" && !window.getSelection()?.toString()) { event.preventDefault(); void copy(row, event.shiftKey ? "path" : "value").catch(() => {}); }
      return;
    }
    if (mod) return;
    const go = (to: number) => { event.preventDefault(); const target = list[Math.max(0, Math.min(list.length - 1, to))]; if (target) moveTo(target.id); };
    switch (event.key) {
      case "ArrowDown": go(index + 1); break;
      case "ArrowUp": go(index - 1); break;
      case "Home": go(0); break;
      case "End": go(list.length - 1); break;
      case "ArrowRight":
        event.preventDefault();
        if (row.kind === "node" && isBranch(row.type)) { if (!row.open) toggle(row.id, true); else if (row.count) go(index + 1); }
        break;
      case "ArrowLeft":
        event.preventDefault();
        if (row.kind === "node" && row.open) toggle(row.id, false);
        else if (row.parent) moveTo(row.parent);
        break;
      case "Enter": case " ":
        event.preventDefault();
        if (row.kind === "more") showMore(row.parent!);
        else if (isBranch(row.type)) toggle(row.id);
        break;
      case "/":
        if (props.searchable !== false) { event.preventDefault(); searchInput?.focus(); searchInput?.select(); }
        break;
      default:
    }
  };

  const describe = (row: Row) => {
    const name = row.name === null ? rootName() : String(row.name);
    if (row.kind === "more") return `Show ${Math.min(pageSize(), row.hidden ?? 0)} more, ${row.hidden} hidden`;
    return isBranch(row.type) ? `${name}, ${row.type}, ${countLabel(row)}` : `${name}: ${primitiveText(row.value, row.type)}`;
  };
  const bulk = () => rows().length > 400;
  let mounted = false;
  onMount(() => { mounted = true; });

  const maxHeight = () => (typeof props.maxHeight === "number" ? `${props.maxHeight}px` : props.maxHeight ?? "420px");

  return (
    <div ref={el => useSquircle(el)} class={cx(styles.root, props.class)} style={{ "--json-max-height": maxHeight() }}>
      <Show when={props.searchable !== false || rows().length > 1}>
        <div class={styles.toolbar}>
          <Show when={props.searchable !== false} fallback={<span class={styles.grow} />}>
            <label ref={el => useSquircle(el)} class={styles.search}>
              <Search size={15} stroke-width={1.75} aria-hidden="true" class={styles.searchIcon} />
              <input
                ref={searchInput}
                type="search"
                class={styles.input}
                value={query()}
                placeholder="Search keys and values"
                aria-label="Search JSON"
                aria-controls={`${uid}-tree`}
                onInput={event => onQuery(event.currentTarget.value)}
                onKeyDown={onSearchKeyDown}
                spellcheck={false}
                autocomplete="off"
              />
              <Presence
                when={!!needle()}
                enter={el => animate(el, { opacity: [0, 1], x: prefersReducedMotion() ? 0 : [6, 0] }, tween(motionTokens.duration.fast, motionTokens.ease.enter))}
                exit={el => animate(el, { opacity: 0, x: prefersReducedMotion() ? 0 : 6 }, tween(motionTokens.duration.fast))}
              >
                {ref => (
                  <span ref={ref} class={styles.matches}>
                    <span class={styles.count} aria-live="polite">{matchCount() ? `${Math.min(matchIndex(), matchCount() - 1) + 1}/${matchCount()}` : "0/0"}</span>
                    <button type="button" class={styles.tool} aria-label="Previous match" disabled={!matchCount()} onClick={() => stepMatch(-1)}><ChevronUp size={15} stroke-width={1.75} aria-hidden="true" /></button>
                    <button type="button" class={styles.tool} aria-label="Next match" disabled={!matchCount()} onClick={() => stepMatch(1)}><ChevronDown size={15} stroke-width={1.75} aria-hidden="true" /></button>
                  </span>
                )}
              </Presence>
            </label>
          </Show>
          <span class={styles.divider} aria-hidden="true" />
          <button type="button" class={styles.tool} aria-label="Expand all" title="Expand all" onClick={expandAll}><ChevronsUpDown size={15} stroke-width={1.75} aria-hidden="true" /></button>
          <button type="button" class={styles.tool} aria-label="Collapse all" title="Collapse all" onClick={collapseAll}><ChevronsDownUp size={15} stroke-width={1.75} aria-hidden="true" /></button>
        </div>
      </Show>

      <div ref={tree} id={`${uid}-tree`} role="tree" aria-label={props.label ?? "JSON"} class={styles.tree} onKeyDown={onTreeKeyDown}>
        <span ref={highlightEl} class={styles.highlight} aria-hidden="true" />
        <For each={presence()}>
          {entry => {
            let last = untrack(() => rowById().get(entry.item()));
            const row = () => {
              const next = rowById().get(entry.item());
              if (next) last = next;
              return last!;
            };
            const isActive = () => !entry.leaving() && row().id === active();
            const branch = () => isBranch(row().type);
            const matched = () => !!search() && row().kind === "node" && matchSet().has(row().id);
            const isCurrentMatch = () => row().id === currentMatch();
            const mark = () => (matched() ? needle() : "");
            createEffect(on(entry.leaving, leaving => {
              const node = rowRefs.get(entry.key);
              if (!leaving || !node) return;
              if (prefersReducedMotion() || bulk()) { release(entry); return; }
              node.style.overflow = "hidden";
              animate(node, { height: [`${node.offsetHeight}px`, "0px"], opacity: 0 }, { height: spring.smooth, opacity: tween(motionTokens.duration.fast) }).then(() => release(entry));
            }, { defer: true }));
            return (
              <div
                ref={node => {
                  rowRefs.set(entry.key, node);
                  onCleanup(() => { if (rowRefs.get(entry.key) === node) rowRefs.delete(entry.key); });
                  if (mounted && entry.entering && !prefersReducedMotion() && !bulk()) {
                    node.style.overflow = "hidden";
                    animate(node, { height: ["0px", `${ROW}px`], opacity: [0, 1] }, { height: spring.smooth, opacity: tween(motionTokens.duration.fast) }).then(() => { node.style.overflow = ""; });
                  }
                }}
                role="treeitem"
                tabIndex={isActive() ? 0 : -1}
                aria-level={row().level}
                aria-posinset={row().posinset}
                aria-setsize={row().setsize}
                aria-expanded={row().kind === "node" && branch() ? row().open : undefined}
                aria-selected={isActive()}
                aria-label={describe(row())}
                aria-hidden={entry.leaving() || undefined}
                class={styles.row}
                data-kind={row().kind}
                data-active={isActive() || undefined}
                style={{ "--level": String(row().level - 1) }}
                onFocus={event => { if (event.target === event.currentTarget && row().id !== active()) setActiveRaw(row().id); }}
                onClick={() => {
                  const current = row();
                  if (current.kind === "more") { showMore(current.parent!); moveTo(current.id); return; }
                  if (branch()) toggle(current.id);
                  moveTo(current.id);
                }}
              >
                <span class={styles.line}>
                  <Show
                    when={row().kind === "node"}
                    fallback={
                      <span class={styles.more}>
                        <span class={styles.moreLabel}>Show {Math.min(pageSize(), row().hidden ?? 0)} more</span>
                        <span class={styles.muted}>{row().hidden} hidden</span>
                      </span>
                    }
                  >
                    <span class={styles.chevron} data-open={row().open || undefined} data-branch={branch() || undefined} aria-hidden="true">
                      <Show when={branch()}><ChevronRight size={14} stroke-width={1.75} /></Show>
                    </span>
                    <span class={typeof row().name === "number" ? styles.index : styles.key}>
                      {row().name === null ? rootName() : typeof row().name === "number" ? row().name : <Highlight text={String(row().name)} needle={mark()} current={isCurrentMatch()} />}
                    </span>
                    <span class={styles.colon} aria-hidden="true">{row().name === null && branch() ? "" : ":"}</span>
                    <Show
                      when={branch()}
                      fallback={
                        <span class={styles.value} data-type={row().type} title={row().type === "string" && (row().value as string).length > 40 ? (row().value as string) : undefined}>
                          <Show when={row().type === "string"} fallback={<Highlight text={primitiveText(row().value, row().type)} needle={mark()} current={isCurrentMatch()} />}>
                            "<Highlight text={row().value as string} needle={mark()} current={isCurrentMatch()} />"
                          </Show>
                        </span>
                      }
                    >
                      <span class={styles.summary}>
                        <Show when={!row().open}>
                          <span class={styles.preview}>{row().type === "array" ? "[…]" : `{ ${entries(row().value).slice(0, 3).map(([key]) => key).join(", ")}${row().count > 3 ? ", …" : ""} }`}</span>
                        </Show>
                        <span class={styles.countLabel}>{countLabel(row())}</span>
                      </span>
                    </Show>
                    <Show when={copyable()}>
                      <span class={styles.actions}>
                        <CopyAction label="Copy value" icon="copy" onCopy={() => copy(row(), "value")} />
                        <CopyAction label="Copy path" icon="link" onCopy={() => copy(row(), "path")} />
                      </span>
                    </Show>
                  </Show>
                </span>
              </div>
            );
          }}
        </For>
      </div>

      <Show when={props.showPath !== false && activeRow()}>
        {current => (
          <div class={styles.pathBar}>
            <code class={styles.path} title={current().kind === "node" ? current().id : current().parent ?? ""}>{current().kind === "node" ? current().id : current().parent}</code>
            <span class={styles.pathType}>{current().kind === "node" ? (isBranch(current().type) ? `${current().type}, ${countLabel(current())}` : current().type) : "page"}</span>
            <Show when={copyable() && current().kind === "node"}>
              <CopyAction focusable class={styles.pathCopy} label="Copy path" icon="copy" onCopy={() => copy(current(), "path")} />
            </Show>
          </div>
        )}
      </Show>
      <span class={styles.srOnly} role="status">{announcement()}</span>
    </div>
  );
}

/** Pretty JSON in a code block style, for small payloads that do not need a tree. */
export function JsonPreview(props: { value: unknown; class?: string }): JSX.Element {
  return <pre class={cx(styles.plain, props.class)}>{JSON.stringify(props.value, null, 2)}</pre>;
}

export default JsonViewer;
