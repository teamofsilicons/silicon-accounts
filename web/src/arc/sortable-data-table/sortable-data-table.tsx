import { For, Show, batch, createEffect, createMemo, createSignal, createUniqueId, on, onCleanup, onMount, untrack, type JSX } from "solid-js";
import { ArrowUp } from "lucide-solid";
import { createFlip } from "../lib/flip";
import { Presence, SwapText } from "../lib/presence";
import { animate, motionTokens, prefersReducedMotion, spring, tween } from "../lib/motion";
import { useSquircle } from "../lib/squircle";
import styles from "./sortable-data-table.module.css";

export type SortDirection = "asc" | "desc";
export type SortState = { key: string; direction: SortDirection };

export interface DataColumn<T> {
  key: string;
  label: string;
  /** Defaults to true. */
  sortable?: boolean;
  render?: (value: unknown, row: T) => JSX.Element;
  /** Right-aligns the column with tabular numerals. Detected when every value is a number. */
  numeric?: boolean;
  /** Fixed width such as 120 or "20%". Other columns are measured once and held, so sorting never reflows them. */
  width?: number | string;
  /** Value used for sorting when it differs from the shown value (for example a timestamp behind "2 hours ago"). */
  sortValue?: (row: T) => unknown;
}

export interface SortableDataTableProps<T extends Record<string, unknown>> {
  rows: T[];
  columns: DataColumn<T>[];
  rowKey: keyof T | ((row: T) => string);
  caption?: string;
  emptyMessage?: string;
  /** Sort applied on the first render. */
  defaultSort?: SortState;
  onSortChange?: (sort: SortState) => void;
  /** Adds a checkbox column, row click selection, and a count line with a clear action. */
  selectable?: boolean;
  selectedKeys?: string[];
  defaultSelectedKeys?: string[];
  onSelectionChange?: (keys: string[]) => void;
  /** Noun for the count line, as in "6 users". */
  itemName?: { one: string; other: string };
  /**
   * Opens a row (for example a details drawer). Rows become focusable; Enter or a click activates them. Ignored when
   * `selectable` is on (a click selects there).
   */
  onRowActivate?: (row: T) => void;
  class?: string;
}

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
const isEmpty = (value: unknown) => value == null || value === "";
const comparable = (value: unknown) => (value instanceof Date ? value.getTime() : value);
/** Check and dash share three points, so the header box morphs between all and some. */
const checkPath = "M4.25 9.25 L7.25 12.25 L13.75 5.75";
const dashPath = "M4.75 9 L9 9 L13.25 9";

/** The arrow fades in where a column becomes sorted and flips on a spring when the direction changes. */
function SortGlyph(props: { active: boolean; descending: boolean }) {
  let arrow: HTMLSpanElement | undefined;
  let rotation = untrack(() => (props.descending ? 180 : 0));
  let hiddenAt = -Infinity;
  let wasActive = untrack(() => props.active);
  onMount(() => {
    if (!arrow) return;
    arrow.style.rotate = `${rotation}deg`;
    arrow.style.opacity = props.active ? "1" : "0";
    arrow.style.scale = props.active ? "1" : ".6";
  });
  createEffect(on(() => [props.active, props.descending] as const, ([active, descending]) => {
    if (!arrow) return;
    const target = descending ? 180 : 0;
    const reduce = prefersReducedMotion();
    if (active) {
      // Turn only while the arrow is visible; a freshly shown arrow starts pointing the right way.
      const visible = wasActive || performance.now() - hiddenAt < 160;
      if (visible && !reduce && rotation !== target) animate(arrow, { rotate: target }, spring.snappy);
      else arrow.style.rotate = `${target}deg`;
      rotation = target;
      animate(arrow, { opacity: 1, scale: 1, filter: "blur(0px)" }, reduce ? { duration: 0 } : { opacity: tween(motionTokens.duration.standard, motionTokens.ease.enter), scale: spring.snappy, filter: tween(motionTokens.duration.standard) });
    } else {
      if (wasActive) hiddenAt = performance.now();
      animate(arrow, { opacity: 0, scale: 0.6, filter: `blur(${motionTokens.blur.subtle}px)` }, reduce ? { duration: 0 } : tween(motionTokens.duration.instant));
    }
    wasActive = active;
  }, { defer: true }));
  return (
    <span class={styles.sortIcon} aria-hidden="true">
      <ArrowUp class={styles.sortHint} size={16} stroke-width={1.75} />
      <span ref={arrow} class={styles.sortArrow}><ArrowUp size={16} stroke-width={1.75} /></span>
    </span>
  );
}

function SelectBox(props: { checked: boolean; mixed?: boolean; label: string; nav: "head" | "row"; onToggle: (extend: boolean) => void; ref?: (el: HTMLInputElement) => void }) {
  let input: HTMLInputElement | undefined;
  let fill: HTMLSpanElement | undefined;
  let path: SVGPathElement | undefined;
  const on_ = () => props.checked || !!props.mixed;
  const paint = (instant: boolean) => {
    if (input) input.indeterminate = !!props.mixed;
    if (!fill || !path) return;
    const reduce = instant || prefersReducedMotion();
    const opacity = tween(on_() ? motionTokens.duration.instant : motionTokens.duration.fast);
    animate(fill, { opacity: on_() ? 1 : 0, scale: on_() ? 1 : 0.6 }, reduce ? { duration: 0 } : { scale: spring.snappy, opacity });
    animate(path, { strokeDashoffset: on_() ? 0 : 1, opacity: on_() ? 1 : 0 }, reduce ? { duration: 0 } : { strokeDashoffset: spring.snappy, opacity });
    const d = props.mixed ? dashPath : checkPath;
    if (path.getAttribute("d") !== d) {
      if (reduce) path.setAttribute("d", d);
      else animate(path, { d }, spring.morph);
    }
  };
  onMount(() => paint(true));
  createEffect(on(() => [props.checked, props.mixed], () => paint(false), { defer: true }));
  return (
    <label class={styles.selectHit}>
      <input
        ref={el => { input = el; props.ref?.(el); }}
        type="checkbox"
        class={styles.selectInput}
        checked={props.checked}
        aria-label={props.label}
        data-nav={props.nav}
        onClick={event => event.stopPropagation()}
        onChange={event => props.onToggle((event as unknown as MouseEvent).shiftKey === true)}
      />
      <span class={styles.selectBox} data-on={on_() || undefined} aria-hidden="true">
        <span ref={fill} class={styles.selectFill} style={{ opacity: 0 }} />
        <svg class={styles.selectMark} viewBox="0 0 18 18" fill="none" aria-hidden="true">
          <path ref={path} d={checkPath} pathLength="1" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" style={{ "stroke-dasharray": "1", "stroke-dashoffset": "1", opacity: 0 }} />
        </svg>
      </span>
    </label>
  );
}

/** A count whose new value rises in place. */
function CountSwap(props: { value: string; class?: string }) {
  return (
    <span class={[styles.swap, props.class ?? ""].join(" ")}>
      <SwapText text={props.value} />
    </span>
  );
}

/**
 * Arc SortableDataTable (ported to Solid): records to compare. Header buttons sort (the arrow flips on a spring),
 * rows glide to their new places, column widths are measured once and held so nothing reflows, and the sorted column
 * carries a still tint. Optional selection with shift ranges and a count line. Below 620px rows fold into two lines
 * and the header becomes a strip of sort controls. Wide tables scroll inside their card, never the page.
 */
export function SortableDataTable<T extends Record<string, unknown>>(props: SortableDataTableProps<T>) {
  const uid = createUniqueId();
  let table: HTMLTableElement | undefined;
  let tbody: HTMLTableSectionElement | undefined;
  let selectAll: HTMLInputElement | undefined;
  let anchor: string | null = null;
  const [sort, setSort] = createSignal<SortState | null>(untrack(() => props.defaultSort ?? null));
  const [announcement, setAnnouncement] = createSignal("");
  const [internalSelection, setInternalSelection] = createSignal<string[]>(untrack(() => props.defaultSelectedKeys ?? []));
  const selection = createMemo(() => new Set(props.selectedKeys ?? internalSelection()));
  const getRowKey = (row: T) => String(typeof props.rowKey === "function" ? props.rowKey(row) : row[props.rowKey]);

  const sortedRows = createMemo(() => {
    const current = sort();
    if (!current) return props.rows;
    const column = props.columns.find(entry => entry.key === current.key);
    const valueOf = (row: T) => comparable(column?.sortValue ? column.sortValue(row) : row[current.key]);
    return props.rows.map((row, index) => ({ row, index })).sort((a, b) => {
      const left = valueOf(a.row);
      const right = valueOf(b.row);
      // Empty values stay at the bottom in both directions.
      if (isEmpty(left) || isEmpty(right)) return isEmpty(left) === isEmpty(right) ? a.index - b.index : isEmpty(left) ? 1 : -1;
      const result = typeof left === "number" && typeof right === "number" ? left - right : collator.compare(String(left), String(right));
      return (current.direction === "asc" ? result : -result) || a.index - b.index;
    }).map(entry => entry.row);
  });
  const numeric = createMemo(() => new Set(props.columns
    .filter(column => column.numeric ?? (props.rows.some(row => typeof row[column.key] === "number") && props.rows.every(row => typeof row[column.key] === "number" || isEmpty(row[column.key]))))
    .map(column => column.key)));
  const keys = createMemo(() => sortedRows().map(getRowKey));
  const selectedCount = () => keys().filter(key => selection().has(key)).length;
  const allSelected = () => keys().length > 0 && selectedCount() === keys().length;

  /* Rows glide to their new places when the order changes (Arc layout="position"). */
  const flip = createFlip(() => tbody, "tr[data-row]", el => el.getAttribute("data-row"));
  let sorting = false;
  createEffect(on(() => keys().join("\u0000"), () => {
    // Only a sort glides rows; new data simply replaces them.
    if (sorting) flip.play(spring.smooth);
    sorting = false;
  }, { defer: true }));

  /* Measure the natural column widths once, then hold them with a fixed layout so nothing reflows while rows move. */
  const signature = () => [props.selectable ? "select" : "", ...props.columns.map(column => column.key)].join("\u0000");
  const [locked, setLocked] = createSignal<{ signature: string; widths: Record<string, number> } | null>(null);
  const widths = () => (locked()?.signature === signature() ? locked()?.widths ?? null : null);
  createEffect(on(signature, current => {
    if (!table || widths()) return;
    const measure = () => {
      if (!table) return false;
      const total = table.getBoundingClientRect().width;
      if (!total || getComputedStyle(table).display !== "table") return false;
      const next: Record<string, number> = {};
      table.querySelectorAll<HTMLElement>("thead th[data-key]").forEach(cell => { next[cell.dataset.key ?? ""] = (cell.getBoundingClientRect().width / total) * 100; });
      setLocked({ signature: current, widths: next });
      return true;
    };
    queueMicrotask(() => {
      if (measure() || !table) return;
      const observer = new ResizeObserver(() => { if (measure()) observer.disconnect(); });
      observer.observe(table);
      onCleanup(() => observer.disconnect());
    });
  }));

  /* A still tint under the sorted column fills the gaps that open while rows pass each other. */
  const [band, setBand] = createSignal<{ left: number; width: number } | null>(null);
  let seenSort = false;
  const updateBand = () => {
    const key = sort()?.key;
    const cell = key ? table?.querySelector<HTMLElement>(`thead th[data-key="${CSS.escape(key)}"]`) : null;
    setBand(current => (!cell ? null : current?.left === cell.offsetLeft && current.width === cell.offsetWidth ? current : { left: cell.offsetLeft, width: cell.offsetWidth }));
  };
  createEffect(on(() => [sort()?.key, widths()], () => queueMicrotask(() => {
    updateBand();
    const key = sort()?.key;
    if (!table || !key) return;
    // On a phone the header is a scrolling strip of sort controls; keep the active one in view.
    const cell = table.querySelector<HTMLElement>(`thead th[data-key="${CSS.escape(key)}"]`);
    const strip = cell?.parentElement;
    if (cell && strip && strip.scrollWidth > strip.clientWidth && getComputedStyle(table).display !== "table") {
      const bounds = strip.getBoundingClientRect();
      const target = cell.getBoundingClientRect();
      const inset = 8;
      const start = Math.max(bounds.left, strip.querySelector("th:not([data-key])")?.getBoundingClientRect().right ?? bounds.left) + inset;
      const shift = target.right > bounds.right - inset ? target.right - bounds.right + inset : target.left < start ? target.left - start : 0;
      if (shift) strip.scrollTo({ left: strip.scrollLeft + shift, behavior: prefersReducedMotion() || !seenSort ? "auto" : "smooth" });
    }
    seenSort = true;
  })));
  onMount(() => {
    if (!table || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateBand);
    observer.observe(table);
    onCleanup(() => observer.disconnect());
  });

  const shownCount = () => selectedCount() || keys().length;
  const itemName = () => props.itemName ?? { one: "row", other: "rows" };
  const noun = () => (selectedCount() ? "selected" : keys().length === 1 ? itemName().one : itemName().other);

  const sortBy = (column: DataColumn<T>) => {
    const current = sort();
    const next: SortState = { key: column.key, direction: current?.key === column.key && current.direction === "asc" ? "desc" : "asc" };
    flip.capture();
    sorting = true;
    batch(() => {
      setSort(next);
      setAnnouncement(`Sorted by ${column.label}, ${next.direction === "asc" ? "ascending" : "descending"}`);
    });
    props.onSortChange?.(next);
  };

  const commit = (next: Set<string>) => {
    const list = keys().filter(key => next.has(key));
    if (props.selectedKeys === undefined) setInternalSelection(list);
    props.onSelectionChange?.(list);
    setAnnouncement(list.length ? `${list.length} of ${keys().length} selected` : "Selection cleared");
  };
  const toggleRow = (key: string, extend: boolean) => {
    const next = new Set(selection());
    const checked = !selection().has(key);
    const all = keys();
    const from = extend && anchor ? all.indexOf(anchor) : -1;
    const to = all.indexOf(key);
    (from < 0 ? [key] : all.slice(Math.min(from, to), Math.max(from, to) + 1)).forEach(item => (checked ? next.add(item) : next.delete(item)));
    anchor = key;
    commit(next);
  };
  const clearSelection = () => {
    commit(new Set());
    selectAll?.focus();
  };
  const interactive = () => !props.selectable && !!props.onRowActivate;
  const onRowClick = (event: MouseEvent & { currentTarget: HTMLTableRowElement }, key: string, row: T) => {
    if ((event.target as HTMLElement).closest("a, button, input, label, select, textarea, [role='button'], [contenteditable='true']") || window.getSelection()?.toString()) return;
    if (props.selectable) {
      toggleRow(key, event.shiftKey);
      // Keep the keyboard path where the pointer left off, so arrows continue from this row.
      event.currentTarget.querySelector<HTMLInputElement>("input[type='checkbox']")?.focus({ preventScroll: true });
      return;
    }
    props.onRowActivate?.(row);
  };

  /** Arrows walk the header controls, the row checkboxes (or rows); Escape clears the selection. */
  const onKeyDown = (event: KeyboardEvent & { currentTarget: HTMLDivElement }) => {
    const target = event.target as HTMLElement;
    if (event.key === "Escape" && selectedCount()) {
      event.preventDefault();
      event.stopPropagation();
      if (target.dataset.clear !== undefined) clearSelection();
      else commit(new Set());
      return;
    }
    const nav = target.dataset.nav;
    if (!nav) return;
    if (nav === "row" && interactive() && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      const row = sortedRows().find(entry => getRowKey(entry) === target.dataset.row);
      if (row) props.onRowActivate?.(row);
      return;
    }
    const list = (name: string) => [...event.currentTarget.querySelectorAll<HTMLElement>(`[data-nav="${name}"]`)];
    const items = list(nav);
    const index = items.indexOf(target);
    const steps: Record<string, [HTMLElement[], number]> = nav === "head"
      ? { ArrowRight: [items, index + 1], ArrowLeft: [items, index - 1], Home: [items, 0], End: [items, items.length - 1], ...(target === selectAll || (!props.selectable && index === 0) ? { ArrowDown: [list("row"), 0] as [HTMLElement[], number] } : {}) }
      : { ArrowDown: [items, index + 1], ArrowUp: index === 0 ? [list("head"), 0] : [items, index - 1], Home: [items, 0], End: [items, items.length - 1] };
    const step = steps[event.key];
    const next = step?.[0][step[1]];
    if (!next) return;
    event.preventDefault();
    next.focus();
  };

  const colStyle = (column: DataColumn<T>, index: number): JSX.CSSProperties | undefined => {
    if (column.width !== undefined) return { width: typeof column.width === "number" ? `${column.width}px` : column.width };
    const held = widths();
    return held && index > 0 ? { width: `${held[column.key]}%` } : undefined;
  };

  return (
    <div ref={el => useSquircle(el)} class={[styles.wrapper, props.class ?? ""].join(" ")} onKeyDown={onKeyDown}>
      <div class={styles.scroller}>
        <Show when={band()}>{value => <span class={styles.band} style={{ left: `${value().left}px`, width: `${value().width}px` }} aria-hidden="true" />}</Show>
        <table ref={table} class={styles.table} data-fixed={widths() ? "" : undefined} data-selectable={props.selectable || undefined} data-interactive={interactive() || undefined} aria-describedby={`${uid}-status`}>
          <caption>{props.caption ?? "Data table"}</caption>
          <colgroup>
            <Show when={props.selectable}><col class={styles.selectCol} /></Show>
            <For each={props.columns}>{(column, index) => <col style={colStyle(column, index())} />}</For>
          </colgroup>
          <thead>
            <tr>
              <Show when={props.selectable}>
                <th scope="col" class={styles.selectCell}>
                  <SelectBox ref={el => (selectAll = el)} checked={allSelected()} mixed={selectedCount() > 0 && !allSelected()} label="Select all rows" nav="head" onToggle={() => commit(allSelected() ? new Set() : new Set(keys()))} />
                </th>
              </Show>
              <For each={props.columns}>
                {(column, index) => {
                  const active = () => sort()?.key === column.key;
                  const sortable = column.sortable !== false;
                  return (
                    <th
                      scope="col"
                      data-key={column.key}
                      data-primary={index() === 0 || undefined}
                      data-sorted={active() || undefined}
                      data-numeric={numeric().has(column.key) || undefined}
                      data-sortable={sortable || undefined}
                      aria-sort={!sortable ? undefined : active() ? (sort()?.direction === "asc" ? "ascending" : "descending") : "none"}
                    >
                      <Show when={sortable} fallback={column.label}>
                        <button class={styles.sortButton} type="button" data-nav="head" onClick={() => sortBy(column)} aria-label={`Sort by ${column.label}${active() ? `, currently ${sort()?.direction === "asc" ? "ascending" : "descending"}` : ""}`}>
                          <span class={styles.sortInner}><span>{column.label}</span><SortGlyph active={active()} descending={active() && sort()?.direction === "desc"} /></span>
                        </button>
                      </Show>
                    </th>
                  );
                }}
              </For>
            </tr>
          </thead>
          <tbody ref={tbody}>
            <Show when={sortedRows().length} fallback={<tr><td class={styles.empty} colSpan={props.columns.length + (props.selectable ? 1 : 0)}>{props.emptyMessage ?? "No rows to show"}</td></tr>}>
              <For each={sortedRows()}>
                {row => {
                  const key = getRowKey(row);
                  const selected = () => !!props.selectable && selection().has(key);
                  return (
                    <tr
                      data-row={key}
                      data-selected={selected() || undefined}
                      data-nav={interactive() ? "row" : undefined}
                      tabIndex={interactive() ? 0 : undefined}
                      onClick={event => onRowClick(event, key, row)}
                      onMouseDown={event => { if (props.selectable && event.shiftKey) event.preventDefault(); }}
                    >
                      <Show when={props.selectable}>
                        <td class={styles.selectCell}>
                          <SelectBox checked={selected()} label={`Select ${String(row[props.columns[0]?.key ?? ""] ?? key)}`} nav="row" onToggle={extend => toggleRow(key, extend)} />
                        </td>
                      </Show>
                      <For each={props.columns}>
                        {(column, columnIndex) => (
                          <td data-label={column.label} data-primary={columnIndex() === 0 || undefined} data-sorted={sort()?.key === column.key || undefined} data-numeric={numeric().has(column.key) || undefined}>
                            {column.render ? column.render(row[column.key], row) : String(row[column.key] ?? "–")}
                          </td>
                        )}
                      </For>
                    </tr>
                  );
                }}
              </For>
            </Show>
          </tbody>
        </table>
      </div>
      <Show when={props.selectable}>
        <div class={styles.footer}>
          <span class="sr-only">{shownCount()} {noun()}</span>
          <span class={styles.count} data-active={selectedCount() > 0 || undefined} aria-hidden="true">
            <CountSwap class={styles.number} value={String(shownCount())} />
            <CountSwap value={noun()} />
          </span>
          <Presence
            when={selectedCount() > 0}
            enter={el => (prefersReducedMotion() ? animate(el, { opacity: [0, 1] }, tween(motionTokens.duration.instant)) : animate(el, { opacity: [0, 1], scale: [0.96, 1], filter: [`blur(${motionTokens.blur.soft}px)`, "blur(0px)"] }, tween(motionTokens.duration.standard, motionTokens.ease.enter)))}
            exit={el => animate(el, { opacity: 0 }, tween(prefersReducedMotion() ? motionTokens.duration.instant : motionTokens.duration.fast))}
          >
            {ref => <button ref={ref} type="button" class={styles.clear} data-clear="" onClick={clearSelection}>Clear selection</button>}
          </Presence>
        </div>
      </Show>
      <p id={`${uid}-status`} class="sr-only" role="status">{announcement()}</p>
    </div>
  );
}

export default SortableDataTable;
