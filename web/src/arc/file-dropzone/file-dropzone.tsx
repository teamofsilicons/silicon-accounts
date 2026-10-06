import { For, Match, Show, Switch, createEffect, createSignal, createUniqueId, on, onCleanup, onMount } from "solid-js";
import { ArrowUp, CircleAlert, File as FileIcon, FileArchive, FileImage, FileJson, FileSpreadsheet, FileText, RotateCw, X } from "lucide-solid";
import { FieldMessage } from "../lib/FieldMessage";
import { Presence, SwapText } from "../lib/presence";
import { createPresenceList, type PresenceEntry } from "../lib/presence-list";
import { animate, motionTokens, prefersReducedMotion, spring, tween, type AnimationControls } from "../lib/motion";
import { squirclePath, useSquircle } from "../lib/squircle";
import styles from "./file-dropzone.module.css";

export type FileDropzoneStatus = "uploading" | "uploaded" | "failed";
/** One row in the file list. A row without a status is a plain selection. `preview` is a thumbnail URL. */
export type FileDropzoneItem = { id: string; name: string; size: number; status?: FileDropzoneStatus; progress?: number; error?: string; retryable?: boolean; file?: File; preview?: string };
/** Report 0 to 100 through onProgress, resolve when the file lands, or reject with an Error whose message becomes the row's reason. Removing the row aborts the signal. */
export type FileDropzoneUpload = (item: FileDropzoneItem, options: { onProgress: (percent: number) => void; signal: AbortSignal }) => Promise<void>;

export interface FileDropzoneProps {
  accept?: string;
  multiple?: boolean;
  maxFiles?: number;
  onFilesChange?: (files: File[]) => void;
  label?: string;
  description?: string;
  defaultItems?: FileDropzoneItem[];
  /** Uploads each added file. Without it the list shows plain selections. */
  onUpload?: FileDropzoneUpload;
  /** Files above this many bytes fail with a size reason and never upload. */
  maxSize?: number;
  /** Replaces the small line under the description. */
  note?: string;
  /** Label while files hover over the target. */
  dropLabel?: string;
  /** Once the list holds this many files, the prompt folds to a slim bar so the list has room. */
  compactAt?: number;
  class?: string;
}

const MB = 1024 * 1024;
const PERIOD = 7;
const clamp = (value: number) => Math.min(Math.max(value, 0), 100);
const SHAKE = { x: [0, -7, 6, -4, 3, -1.5, 0] };
const land = { type: "spring", visualDuration: 0.42, bounce: 0.14 } as const;

export function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MB) return `${Math.round(bytes / 1024)} KB`;
  const mb = bytes / MB;
  return `${mb >= 10 ? Math.round(mb) : Number(mb.toFixed(1))} MB`;
}

function TypeIcon(props: { name: string }) {
  const extension = () => props.name.toLowerCase().split(".").pop() ?? "";
  return (
    <Switch fallback={<FileIcon size={20} stroke-width={1.75} aria-hidden="true" />}>
      <Match when={["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "heic"].includes(extension())}><FileImage size={20} stroke-width={1.75} aria-hidden="true" /></Match>
      <Match when={["csv", "tsv", "xlsx"].includes(extension())}><FileSpreadsheet size={20} stroke-width={1.75} aria-hidden="true" /></Match>
      <Match when={["json", "ndjson"].includes(extension())}><FileJson size={20} stroke-width={1.75} aria-hidden="true" /></Match>
      <Match when={["zip", "gz", "tar", "rar", "7z"].includes(extension())}><FileArchive size={20} stroke-width={1.75} aria-hidden="true" /></Match>
      <Match when={["pdf", "md", "txt", "doc", "docx", "rtf"].includes(extension())}><FileText size={20} stroke-width={1.75} aria-hidden="true" /></Match>
    </Switch>
  );
}

/** The circle closes, then the tick draws through it. */
function CircleCheck() {
  return (
    <svg class={`${styles.stateIcon} ${styles.circleCheck}`} width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={2.25} stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M12 2.5a9.5 9.5 0 1 1 0 19a9.5 9.5 0 1 1 0-19" pathLength="1" />
      <path d="m8.2 12.4 2.6 2.6 5-5.2" pathLength="1" />
    </svg>
  );
}

function FileRow(props: { entry: PresenceEntry<FileDropzoneItem>; delay: number; fresh: boolean; canRetry: boolean; onRemove: () => void; onRetry: () => void; removeRef: (el: HTMLButtonElement) => void; onGone: () => void }) {
  const item = () => props.entry.item();
  let li: HTMLLIElement | undefined;
  let row: HTMLDivElement | undefined;
  let fill: HTMLSpanElement | undefined;
  let percent: HTMLSpanElement | undefined;
  let progress = item().status === "uploaded" ? 100 : item().progress ?? 0;
  let controls: AnimationControls | undefined;
  const [filled, setFilled] = createSignal(item().status !== "uploading");
  const paint = (value: number) => {
    progress = value;
    if (fill) fill.style.transform = `translateX(${clamp(value) - 100}%)`;
    if (percent) percent.textContent = `${Math.round(clamp(value))}%`;
    if (item().status === "uploaded" && value >= 99.5) setFilled(true);
  };
  const phase = () => (item().status === "uploaded" && !filled() && !prefersReducedMotion() ? "uploading" : item().status);
  const target = () => (item().status === "uploaded" ? 100 : item().progress ?? 0);
  createEffect(on(() => item().status, status => { if (status === "uploading") setFilled(false); }, { defer: true }));
  createEffect(on([() => item().status, target], ([status, goal]) => {
    if (status !== "uploading" && status !== "uploaded") return;
    controls?.stop();
    if (prefersReducedMotion() || (status === "uploading" && goal === 0)) { paint(goal); if (status === "uploaded") setFilled(true); return; }
    controls = animate(progress, goal, { ...spring.smooth, onUpdate: paint, onComplete: status === "uploaded" ? () => setFilled(true) : undefined });
  }));
  // A failure shakes the row once: a file refused on arrival after it lands, an upload that fails when it fails.
  createEffect(on(() => item().status, (status, previous) => {
    if (status !== "failed" || prefersReducedMotion() || !row) return;
    animate(row, SHAKE, { duration: 0.42, delay: previous === undefined && props.fresh ? props.delay + 0.3 : 0 });
  }));
  onMount(() => {
    if (!li || !row || !props.entry.entering) return;
    if (prefersReducedMotion()) { animate(li, { opacity: [0, 1] }, tween(motionTokens.duration.instant)); return; }
    const height = li.scrollHeight;
    animate(li, { height: [0, height] }, { ...spring.smooth, delay: props.delay }).then(() => { if (li) li.style.height = ""; });
    animate(row, { opacity: [0, 1], y: [-22, 0], scale: [0.94, 1], filter: ["blur(4px)", "blur(0px)"] }, { y: { ...land, delay: props.delay }, scale: { ...land, delay: props.delay }, opacity: { ...tween(motionTokens.duration.standard, motionTokens.ease.enter), delay: props.delay }, filter: { ...tween(motionTokens.duration.standard, motionTokens.ease.enter), delay: props.delay } });
  });
  createEffect(on(props.entry.leaving, leaving => {
    if (!leaving || !li) return;
    if (prefersReducedMotion()) return props.onGone();
    if (row) animate(row, { scale: 0.97, filter: "blur(2px)" }, tween(motionTokens.duration.fast));
    animate(li, { height: 0, opacity: 0 }, { height: { ...motionTokens.spring.smooth, visualDuration: 0.3 }, opacity: { ...tween(motionTokens.duration.fast), delay: 0.04 } }).then(props.onGone);
  }, { defer: true }));
  onCleanup(() => controls?.stop());
  const failed = () => item().status === "failed";
  const retry = () => failed() && props.canRetry && item().retryable !== false;
  const [broken, setBroken] = createSignal(false);
  return (
    <li ref={li} class={styles.item} aria-hidden={props.entry.leaving() || undefined}>
      <div ref={el => { row = el; useSquircle(el); }} class={`${styles.row} ${failed() ? styles.isFailed : ""}`}>
        <Show when={item().preview && !broken()} fallback={<span class={styles.fileIcon}><TypeIcon name={item().name} /></span>}>
          <span ref={el => useSquircle(el, { mode: "clip" })} class={styles.thumb}><img src={item().preview} alt="" width={40} height={40} decoding="async" onError={() => setBroken(true)} /></span>
        </Show>
        <span class={styles.copy}>
          <span class={styles.name} title={item().name}>{item().name}</span>
          <span class={styles.meta}>
            <span>{formatFileSize(item().size)}</span>
            <Show when={phase()}>
              <span class={styles.dot} aria-hidden="true">·</span>
              <span class={styles.phase}>
                <Switch>
                  <Match when={phase() === "uploading"}><span class={styles.state}>Uploading <span ref={el => { percent = el; paint(progress); }} class={styles.percent}>0%</span></span></Match>
                  <Match when={phase() === "uploaded"}><span class={`${styles.state} ${styles.uploaded}`}><CircleCheck /><span>Uploaded</span></span></Match>
                  <Match when={phase() === "failed"}><span class={`${styles.state} ${styles.failed}`}><CircleAlert class={styles.stateIcon} size={14} stroke-width={2.25} aria-hidden="true" /><span class={styles.reason} title={item().error}><span class="sr-only">Failed: </span>{item().error || "Upload failed"}</span></span></Match>
                </Switch>
              </span>
            </Show>
          </span>
          <Presence when={phase() === "uploading"} enter={el => animate(el, { opacity: [0, 1] }, tween(motionTokens.duration.standard))} exit={el => animate(el, { opacity: 0 }, { ...tween(motionTokens.duration.fast), delay: 0.16 })}>
            {ref => (
              <span ref={ref} class={styles.barFrame}>
                <span class={styles.bar} role="progressbar" aria-label={`Uploading ${item().name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(clamp(target()))}>
                  <span ref={el => { fill = el; paint(progress); }} class={styles.barFill} />
                </span>
              </span>
            )}
          </Presence>
        </span>
        <span class={styles.actions}>
          <Show when={retry()}>
            <button type="button" class={styles.retry} onClick={props.onRetry} aria-label={`Retry ${item().name}`} title="Retry"><RotateCw size={14} stroke-width={2} aria-hidden="true" /><span class={styles.retryLabel}>Retry</span></button>
          </Show>
          <button ref={props.removeRef} type="button" class={styles.remove} onClick={props.onRemove} aria-label={`Remove ${item().name}`} title="Remove"><X size={16} stroke-width={1.75} aria-hidden="true" /></button>
        </span>
      </div>
    </li>
  );
}

/**
 * Arc FileDropzone (CSV import, photo upload): a squircle target with a dashed edge that closes into a solid line under
 * a file, light that follows the pointer, and three sheets that fan open. Rows drop out of the target into the list,
 * uploads fill on a spring, failures shake once and offer a retry. Paste works while the pointer or focus is inside.
 */
export function FileDropzone(props: FileDropzoneProps) {
  const [items, setItems] = createSignal<FileDropzoneItem[]>(props.defaultItems ?? []);
  const [dragging, setDragging] = createSignal(false);
  const [error, setError] = createSignal("");
  const [announcement, setAnnouncement] = createSignal("");
  const [batchStart, setBatchStart] = createSignal(0);
  const [freshIds, setFreshIds] = createSignal<ReadonlySet<string>>(new Set());
  const [hovered, setHovered] = createSignal(false);
  const [focusWithin, setFocusWithin] = createSignal(false);
  const descriptionId = `fd-${createUniqueId()}`;
  const noteId = `fd-${createUniqueId()}`;
  let input: HTMLInputElement | undefined;
  let drop: HTMLButtonElement | undefined;
  let zone: HTMLDivElement | undefined;
  let edge: SVGPathElement | undefined;
  let wash: HTMLSpanElement | undefined;
  let glow: HTMLSpanElement | undefined;
  let dragDepth = 0;
  let nextId = 0;
  const controllers = new Map<string, AbortController>();
  const removeEls = new Map<string, HTMLButtonElement>();
  const ownedPreviews = new Map<string, string>();
  const multiple = () => props.multiple ?? true;
  const maxFiles = () => props.maxFiles ?? 5;
  const compact = () => props.compactAt !== undefined && items().length >= props.compactAt;
  const { entries, release } = createPresenceList(items, item => item.id);
  onCleanup(() => { controllers.forEach(controller => controller.abort()); ownedPreviews.forEach(url => URL.revokeObjectURL(url)); });

  /* The drag glow follows the pointer on a spring, so the edge leans toward the file. */
  const glowAt = { x: 50, y: 50 };
  let glowControls: AnimationControls[] = [];
  const paintGlow = () => {
    const edgeLight = `radial-gradient(180px circle at ${glowAt.x}% ${glowAt.y}%, var(--accent), transparent 70%)`;
    const washLight = `radial-gradient(260px circle at ${glowAt.x}% ${glowAt.y}%, color-mix(in oklab, var(--accent) 7%, transparent), transparent 70%)`;
    if (glow) glow.style.backgroundImage = edgeLight;
    if (wash) wash.style.backgroundImage = washLight;
  };
  const track = (event: DragEvent) => {
    if (!zone) return;
    const box = zone.getBoundingClientRect();
    const x = ((event.clientX - box.left) / Math.max(1, box.width)) * 100;
    const y = ((event.clientY - box.top) / Math.max(1, box.height)) * 100;
    glowControls.forEach(controls => controls.stop());
    if (prefersReducedMotion() || !dragging()) { glowAt.x = x; glowAt.y = y; paintGlow(); return; }
    const glowSpring = { type: "spring" as const, stiffness: 260, damping: 32, mass: 0.8 };
    glowControls = [
      animate(glowAt.x, x, { ...glowSpring, onUpdate: value => { glowAt.x = value; paintGlow(); } }),
      animate(glowAt.y, y, { ...glowSpring, onUpdate: value => { glowAt.y = value; paintGlow(); } }),
    ];
  };
  const shakeZone = () => { if (!prefersReducedMotion() && zone) animate(zone, SHAKE, { duration: 0.42 }); };

  // The dashed edge is drawn along the squircle, so its dashes can close into a solid line. Its length is fitted to the
  // measured perimeter, so every dash is the same size and the seam never shows.
  onMount(() => {
    if (!zone || !edge) return;
    const fit = () => {
      if (!zone || !edge) return;
      const width = zone.offsetWidth - 1;
      const height = zone.offsetHeight - 1;
      const radius = parseFloat(getComputedStyle(zone).getPropertyValue("--edge-r")) || 34;
      edge.setAttribute("d", squirclePath({ width, height, radius: Math.min(radius, width / 2, height / 2), x: 0.5, y: 0.5 }));
      const perimeter = edge.getTotalLength?.() ?? 2 * (width + height);
      edge.setAttribute("pathLength", String(Math.max(8, Math.round(perimeter / PERIOD)) * PERIOD));
    };
    fit();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(fit);
    observer?.observe(zone);
    onCleanup(() => observer?.disconnect());
  });

  const filesOf = (list: FileDropzoneItem[]) => list.flatMap(item => (item.file ? [item.file] : []));
  const patch = (id: string, next: (item: FileDropzoneItem) => FileDropzoneItem) => setItems(current => current.map(item => (item.id === id ? next(item) : item)));

  function startUpload(item: FileDropzoneItem) {
    const upload = props.onUpload;
    if (!upload) return;
    controllers.get(item.id)?.abort();
    const controller = new AbortController();
    controllers.set(item.id, controller);
    patch(item.id, current => ({ ...current, status: "uploading", progress: 0, error: undefined }));
    upload({ ...item, status: "uploading", progress: 0, error: undefined }, {
      signal: controller.signal,
      onProgress: value => { if (!controller.signal.aborted) patch(item.id, current => (current.status === "uploading" ? { ...current, progress: Math.max(current.progress ?? 0, clamp(value)) } : current)); },
    }).then(() => {
      if (controller.signal.aborted) return;
      patch(item.id, current => ({ ...current, status: "uploaded", progress: 100 }));
      setAnnouncement(`${item.name} uploaded`);
    }, (reason: unknown) => {
      if (controller.signal.aborted) return;
      const message = reason instanceof Error && reason.message ? reason.message : "Upload failed";
      patch(item.id, current => ({ ...current, status: "failed", error: message, retryable: true }));
      setAnnouncement(`${item.name} failed. ${message}`);
    }).finally(() => { if (controllers.get(item.id) === controller) controllers.delete(item.id); });
  }

  function addFiles(incoming: FileList | File[]) {
    const list = Array.from(incoming);
    const accepted = props.accept?.split(",").map(value => value.trim().toLowerCase()).filter(Boolean) ?? [];
    const matching = list.filter(file => accepted.length === 0 || accepted.some(type => (type.startsWith(".") ? file.name.toLowerCase().endsWith(type) : type.endsWith("/*") ? file.type.startsWith(type.slice(0, -1)) : file.type === type)));
    const kept = multiple() ? items() : [];
    const same = (a: File, b: File) => a.name === b.name && a.size === b.size && a.lastModified === b.lastModified;
    const fresh = matching.filter((file, index) => matching.findIndex(other => same(other, file)) === index && !kept.some(item => item.file && same(item.file, file)));
    const room = multiple() ? Math.max(0, maxFiles() - kept.length) : 1;
    const added = fresh.slice(0, room).map((file): FileDropzoneItem => {
      const tooLarge = props.maxSize !== undefined && file.size > props.maxSize;
      const id = `${file.name}-${file.size}-${file.lastModified}-${nextId++}`;
      const preview = file.type.startsWith("image/") && typeof URL.createObjectURL === "function" ? URL.createObjectURL(file) : undefined;
      if (preview) ownedPreviews.set(id, preview);
      return { id, name: file.name, size: file.size, file, preview, status: tooLarge ? "failed" : props.onUpload ? "uploading" : undefined, progress: 0, error: tooLarge ? `File is larger than ${formatFileSize(props.maxSize ?? 0)}` : undefined, retryable: !tooLarge };
    });
    const rejected = matching.length !== list.length;
    const overflow = fresh.length > added.length;
    setError(rejected ? (list.length === 1 ? `${list[0]?.name ?? "That file"} is not an accepted file type.${props.accept ? ` Use ${props.accept}.` : ""}` : "Some files were not added because their type is not accepted.") : overflow ? `You can add up to ${maxFiles()} ${maxFiles() === 1 ? "file" : "files"}.` : "");
    if (rejected || overflow) shakeZone();
    if (!added.length) return;
    if (!multiple()) { controllers.forEach(controller => controller.abort()); controllers.clear(); }
    const next = [...kept, ...added];
    setFreshIds(current => new Set([...current, ...added.map(item => item.id)]));
    setBatchStart(kept.length);
    setItems(next);
    props.onFilesChange?.(filesOf(next));
    const failed = added.filter(item => item.status === "failed");
    setAnnouncement(`${added.length} ${added.length === 1 ? "file" : "files"} added.${failed.length ? ` ${failed.map(item => `${item.name}: ${item.error}`).join(". ")}.` : ""}`);
    added.filter(item => item.status === "uploading").forEach(startUpload);
  }

  function removeItem(target: FileDropzoneItem) {
    controllers.get(target.id)?.abort();
    controllers.delete(target.id);
    const list = items();
    const index = list.findIndex(item => item.id === target.id);
    const neighbor = list[index + 1] ?? list[index - 1];
    const next = list.filter(item => item.id !== target.id);
    const preview = ownedPreviews.get(target.id);
    if (preview) { ownedPreviews.delete(target.id); window.setTimeout(() => URL.revokeObjectURL(preview), 600); }
    setItems(next);
    setError("");
    setAnnouncement(`${target.name} removed`);
    if (target.file) props.onFilesChange?.(filesOf(next));
    requestAnimationFrame(() => (neighbor ? removeEls.get(neighbor.id) : drop)?.focus());
  }

  const retryItem = (item: FileDropzoneItem) => {
    setAnnouncement(`Retrying ${item.name}`);
    startUpload(item);
    requestAnimationFrame(() => removeEls.get(item.id)?.focus());
  };

  const onListKeyDown = (event: KeyboardEvent & { currentTarget: HTMLUListElement }) => {
    if (event.key === "Delete" || event.key === "Backspace") {
      const row = (event.target as HTMLElement).closest<HTMLElement>(`.${styles.row}`);
      const remove = row?.querySelector<HTMLButtonElement>(`.${styles.remove}`);
      if (remove) { event.preventDefault(); remove.click(); }
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const button = (event.target as HTMLElement).closest("button");
    const rows = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(`.${styles.row}`));
    const row = button?.closest<HTMLElement>(`.${styles.row}`);
    if (!button || !row) return;
    const nextRow = rows[rows.indexOf(row) + (event.key === "ArrowDown" ? 1 : -1)];
    if (!nextRow) return;
    event.preventDefault();
    (nextRow.querySelector<HTMLButtonElement>(`.${button.classList.contains(styles.retry ?? "") ? styles.retry : styles.remove}`) ?? nextRow.querySelector<HTMLButtonElement>(`.${styles.remove}`))?.focus();
  };

  createEffect(() => {
    if (!(hovered() || focusWithin())) return;
    const onPaste = (event: ClipboardEvent) => {
      const files = event.clipboardData?.files;
      if (!files?.length) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input:not([type=file]), textarea, [contenteditable='true']")) return;
      event.preventDefault();
      addFiles(files);
    };
    document.addEventListener("paste", onPaste);
    onCleanup(() => document.removeEventListener("paste", onPaste));
  });

  const carriesFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes("Files");
  const dropCopy = () => props.dropLabel ?? (props.onUpload ? "Drop to upload" : multiple() ? "Drop to add files" : "Drop to add the file");
  const noteCopy = () => props.note ?? (props.accept ? `Accepted: ${props.accept}` : `Up to ${maxFiles()} ${maxFiles() === 1 ? "file" : "files"}`);
  const fold = {
    enter: (el: HTMLElement) => {
      if (prefersReducedMotion()) return animate(el, { opacity: [0, 1] }, tween(motionTokens.duration.instant));
      const height = el.scrollHeight;
      return animate(el, { height: [0, height], opacity: [0, 1] }, { height: spring.smooth, opacity: tween(motionTokens.duration.standard) });
    },
    exit: (el: HTMLElement) => (prefersReducedMotion() ? animate(el, { opacity: 0 }, { duration: 0 }) : animate(el, { height: 0, opacity: 0 }, { height: { ...motionTokens.spring.smooth, visualDuration: 0.3 }, opacity: tween(motionTokens.duration.fast) })),
  };

  return (
    <div class={[styles.wrapper, props.class ?? ""].join(" ")} onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)} onFocusIn={() => setFocusWithin(true)} onFocusOut={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusWithin(false); }}>
      <div
        ref={el => { zone = el; useSquircle(el); }}
        class={`${styles.dropzone} ${dragging() ? styles.dragging : ""} ${compact() ? styles.compact : ""}`}
        onDragEnter={event => { if (!carriesFiles(event)) return; event.preventDefault(); if (!dragDepth) track(event); dragDepth += 1; setDragging(true); }}
        onDragOver={event => { if (!carriesFiles(event)) return; event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = "copy"; track(event); }}
        onDragLeave={event => { if (!carriesFiles(event)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) setDragging(false); }}
        onDrop={event => { event.preventDefault(); dragDepth = 0; setDragging(false); if (event.dataTransfer?.files.length) addFiles(event.dataTransfer.files); }}
      >
        <span ref={wash} class={styles.wash} aria-hidden="true" />
        <svg class={styles.edge} aria-hidden="true"><path ref={edge} /></svg>
        <span ref={glow} class={styles.glow} aria-hidden="true" />
        {/* Children ignore pointer events, so the whole target is one hit area for clicks and drags. */}
        <button ref={drop} type="button" class={styles.trigger} onClick={() => input?.click()} aria-describedby={compact() ? descriptionId : `${descriptionId} ${noteId}`}>
          <Presence when={!compact() || dragging()} enter={fold.enter} exit={fold.exit}>
            {ref => (
              <span ref={ref} class={styles.iconSlot}>
                <span class={styles.sheets} aria-hidden="true">
                  <span class={styles.sheet} data-sheet="back" />
                  <span class={styles.sheet} data-sheet="side" />
                  <span class={styles.sheet} data-sheet="front"><ArrowUp size={14} stroke-width={2} /></span>
                </span>
              </span>
            )}
          </Presence>
          <strong class={styles.label}><SwapText text={dragging() ? dropCopy() : props.label ?? "Add files"} class={styles.labelText} /></strong>
          <span id={descriptionId} class={styles.hint}>{props.description ?? "Drop files here or choose from your device"}</span>
          <Presence when={!compact()} enter={fold.enter} exit={fold.exit}>
            {ref => <span ref={ref} class={styles.noteSlot}><small id={noteId} class={styles.note}>{noteCopy()}</small></span>}
          </Presence>
        </button>
      </div>
      <input ref={input} class={styles.input} type="file" accept={props.accept} multiple={multiple()} tabIndex={-1} aria-hidden="true" onChange={event => { if (event.currentTarget.files) addFiles(event.currentTarget.files); event.currentTarget.value = ""; }} />
      <FieldMessage text={error() || null} tone="error" alert />
      <ul class={styles.list} aria-label="Files" aria-hidden={items().length ? undefined : true} onKeyDown={onListKeyDown}>
        <For each={entries()}>
          {(entry, index) => (
            <FileRow
              entry={entry}
              delay={prefersReducedMotion() ? 0 : Math.min(Math.max(0, index() - batchStart()), 7) * motionTokens.stagger.item * 1.6}
              fresh={freshIds().has(entry.key)}
              canRetry={!!props.onUpload}
              onRemove={() => removeItem(entry.item())}
              onRetry={() => retryItem(entry.item())}
              removeRef={el => { removeEls.set(entry.key, el); onCleanup(() => removeEls.delete(entry.key)); }}
              onGone={() => release(entry)}
            />
          )}
        </For>
      </ul>
      <span class="sr-only" role="status" aria-live="polite">{announcement()}</span>
    </div>
  );
}

export default FileDropzone;
