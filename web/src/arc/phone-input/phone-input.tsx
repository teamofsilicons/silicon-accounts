import { For, Show, createEffect, createMemo, createSignal, createUniqueId, on, onCleanup, onMount, untrack } from "solid-js";
import { Check, ChevronDown, Search, X } from "lucide-solid";
import { cx } from "../lib/cx";
import { FieldMessage } from "../lib/FieldMessage";
import { Presence, Swap } from "../lib/presence";
import { animate, motionTokens, prefersReducedMotion, spring, tween, type AnimationControls } from "../lib/motion";
import { useSquircle } from "../lib/squircle";
import {
  COUNTRY_BY_ISO,
  PHONE_COUNTRIES,
  capDigits,
  caretAfterDigits,
  flagOf,
  formatNational,
  lengthsOf,
  matchesQuery,
  onlyDigits,
  parsePhoneNumber,
  splitTrunk,
  statusOf,
  toE164,
  type PhoneCountry,
  type PhoneStatus,
} from "./countries";
import styles from "./phone-input.module.css";

export * from "./countries";

export interface PhoneInputDetails {
  country: PhoneCountry;
  /** The number as shown in the field, without the calling code. */
  formatted: string;
  status: PhoneStatus;
  valid: boolean;
}

export interface PhoneInputProps {
  label: string;
  hideLabel?: boolean;
  /** The number in E.164, such as "+14155550132". An empty string clears the field. */
  value?: string;
  defaultValue?: string;
  /** Fires on every edit with the E.164 number (empty when there are no digits) and its parsed details. */
  onValueChange?: (value: string, details: PhoneInputDetails) => void;
  /** ISO code of the selected country. */
  country?: string;
  /** ISO code used until someone picks a country or enters an international number. */
  defaultCountry?: string;
  onCountryChange?: (iso: string) => void;
  /** Limit the picker to these ISO codes. */
  countries?: string[];
  /** Pinned at the top of the picker under "Suggested". */
  preferredCountries?: string[];
  description?: string;
  /** Replaces the built-in validation message (for example a server error). */
  error?: string | null;
  /** Show a message after blur when the number is incomplete. On by default. */
  validate?: boolean;
  disabled?: boolean;
  required?: boolean;
  /** Adds a hidden input carrying the E.164 value for native form submission. */
  name?: string;
  id?: string;
  class?: string;
  onBlur?: (event: FocusEvent) => void;
  ref?: (el: HTMLInputElement) => void;
}

/** Duration springs restated as stiffness and damping, so a retarget mid flight keeps its velocity (Arc). */
const physical = (visualDuration: number, bounce: number) => {
  const root = (2 * Math.PI) / (visualDuration * 1.2);
  return { type: "spring" as const, stiffness: root * root, damping: 2 * (1 - bounce) * root, mass: 1 };
};
const GROW = physical(0.4, 0.12);
const SHRINK = physical(0.32, 0);
const GLIDE = physical(0.28, 0.08);
const WIDTH = physical(0.42, 0.16);
const PANEL_MAX = 340;
const CLOSED_RADIUS = 17;
const OPEN_RADIUS = 22;
const PAGE = 8;

type Row = { key: string; entry: PhoneCountry };
type Section = { key: string; label?: string; rows: Row[] };

/**
 * Arc PhoneInput: a phone number field with a country picker. The country button grows into a searchable list, the
 * number formats as it is typed with a faint guide showing the rest of the expected shape, pasted or autofilled
 * international numbers pick their own country, and the value comes out in E.164. Typing "+" jumps into the picker.
 */
export function PhoneInput(props: PhoneInputProps) {
  const uid = createUniqueId();
  const inputId = () => props.id ?? `phone-${uid}`;
  const listId = `phone-${uid}-list`;
  const hintId = () => `${inputId()}-hint`;
  const errorId = () => `${inputId()}-error`;
  const optionId = (key: string) => `phone-${uid}-opt-${key}`;

  const pool = createMemo(() => (props.countries?.length ? PHONE_COUNTRIES.filter(entry => props.countries?.includes(entry.iso)) : PHONE_COUNTRIES));
  const fallback = () => COUNTRY_BY_ISO.get(props.defaultCountry ?? "US") ?? PHONE_COUNTRIES[0]!;
  const initial = untrack(() => parsePhoneNumber(props.value ?? props.defaultValue ?? "", pool()));
  const [isoState, setIsoState] = createSignal(initial ? initial.country.iso : untrack(fallback).iso);
  const [digits, setDigits] = createSignal(initial ? initial.national : "");
  const iso = () => props.country ?? isoState();
  const current = () => COUNTRY_BY_ISO.get(iso()) ?? fallback();
  const e164 = () => toE164(current(), digits());

  // A controlled value that differs from what the field last produced is read back in.
  createEffect(on(() => props.value, value => {
    if (value === undefined || value === untrack(e164)) return;
    const parsed = parsePhoneNumber(value, pool());
    if (parsed) { setIsoState(parsed.country.iso); setDigits(parsed.national); }
    else setDigits("");
  }, { defer: true }));

  const formatted = () => formatNational(current(), digits());
  const status = () => statusOf(current(), digits());
  const [touched, setTouched] = createSignal(false);
  const lengthCopy = () => {
    const lengths = lengthsOf(current());
    return lengths.length === 1 ? `${lengths[0]}` : `${lengths.slice(0, -1).join(", ")} or ${lengths[lengths.length - 1]}`;
  };
  const builtIn = () => ((props.validate ?? true) && touched() && (status() === "incomplete" || status() === "too-long") ? `Numbers in ${current().name} have ${lengthCopy()} digits` : undefined);
  const message = () => props.error ?? builtIn();

  /* The guide: the rest of the example number, in the shape this country expects, drawn faintly after what was typed. */
  const guide = () => {
    const entry = current();
    const [trunk, rest] = splitTrunk(entry, digits());
    if (rest.length >= entry.example.length) return "";
    const full = formatNational(entry, trunk + rest + entry.example.slice(rest.length));
    return full.startsWith(formatted()) ? full.slice(formatted().length) : "";
  };

  let input: HTMLInputElement | undefined;
  const emit = (entry: PhoneCountry, nextDigits: string) => {
    const nextStatus = statusOf(entry, nextDigits);
    props.onValueChange?.(toE164(entry, nextDigits), { country: entry, formatted: formatNational(entry, nextDigits), status: nextStatus, valid: nextStatus === "valid" });
  };
  const placeCaret = (count: number | null) => {
    queueMicrotask(() => {
      if (!input || count === null || document.activeElement !== input) return;
      const position = caretAfterDigits(input.value, count);
      input.setSelectionRange(position, position);
    });
  };
  const setNumber = (nextDigits: string, caretDigits: number | null, entry = current()) => {
    const capped = capDigits(entry, nextDigits);
    const caret = caretDigits === null ? null : Math.min(caretDigits, capped.length);
    if (entry.iso !== current().iso) props.onCountryChange?.(entry.iso);
    if (capped === digits() && entry.iso === current().iso) {
      // Nothing changed (a refused digit): put the formatted text back, since the browser already changed it.
      if (input) input.value = formatted();
      placeCaret(caret);
      return;
    }
    if (props.country === undefined) setIsoState(entry.iso);
    setDigits(capped);
    if (input && input.value !== formatted()) input.value = formatted();
    emit(entry, capped);
    placeCaret(caret);
  };

  const [announcement, setAnnouncement] = createSignal("");

  /* ---------------------------------------------- Number entry ---------------------------------------------- */

  const onNumberInput = (event: InputEvent & { currentTarget: HTMLInputElement }) => {
    const target = event.currentTarget;
    const raw = target.value;
    // Autofill and dropped text arrive as input: an international number chooses its own country.
    if (raw.includes("+") || (/^\s*00/.test(raw) && onlyDigits(raw).length > 6)) {
      const parsed = parsePhoneNumber(raw.slice(Math.max(0, raw.indexOf("+"))), pool());
      if (parsed && parsed.national) {
        if (parsed.country.iso !== current().iso) setAnnouncement(`Country set to ${parsed.country.name}`);
        setNumber(parsed.national, parsed.national.length, parsed.country);
        return;
      }
    }
    const caret = target.selectionStart ?? raw.length;
    setNumber(onlyDigits(raw), onlyDigits(raw.slice(0, caret)).length);
  };

  const onNumberKeyDown = (event: KeyboardEvent & { currentTarget: HTMLInputElement }) => {
    const target = event.currentTarget;
    if (event.key === "+" && !event.metaKey && !event.ctrlKey) { event.preventDefault(); openList("+"); return; }
    const start = target.selectionStart ?? 0;
    const end = target.selectionEnd ?? 0;
    if (start !== end || event.metaKey || event.ctrlKey || event.altKey) return;
    // Deleting a separator deletes the digit beside it instead of doing nothing.
    if (event.key === "Backspace" && start > 0 && !/\d/.test(target.value[start - 1] ?? "")) {
      event.preventDefault();
      const index = onlyDigits(target.value.slice(0, start)).length;
      if (index > 0) setNumber(digits().slice(0, index - 1) + digits().slice(index), index - 1);
    }
    if (event.key === "Delete" && start < target.value.length && !/\d/.test(target.value[start] ?? "")) {
      event.preventDefault();
      const index = onlyDigits(target.value.slice(0, start)).length;
      setNumber(digits().slice(0, index) + digits().slice(index + 1), index);
    }
  };

  const onPaste = (event: ClipboardEvent & { currentTarget: HTMLInputElement }) => {
    const text = event.clipboardData?.getData("text");
    if (!text) return;
    event.preventDefault();
    const target = event.currentTarget;
    const parsed = /^\s*(\+|00)/.test(text) ? parsePhoneNumber(text, pool()) : null;
    if (parsed) {
      if (parsed.country.iso !== current().iso) setAnnouncement(`Country set to ${parsed.country.name}`);
      setNumber(parsed.national, parsed.national.length, parsed.country);
      return;
    }
    let pasted = onlyDigits(text);
    // "1 415 555 0132" pasted into a US field: the leading calling code is dropped when the number would not fit otherwise.
    if (pasted.startsWith(current().dial) && pasted.length > capDigits(current(), pasted).length) pasted = pasted.slice(current().dial.length);
    if (pasted.length >= Math.min(...lengthsOf(current()))) { setNumber(pasted, pasted.length); return; }
    const a = onlyDigits(target.value.slice(0, target.selectionStart ?? 0)).length;
    const b = onlyDigits(target.value.slice(0, target.selectionEnd ?? 0)).length;
    setNumber(digits().slice(0, a) + pasted + digits().slice(b), a + pasted.length);
  };

  /* ---------------------------------------------- Country picker ---------------------------------------------- */

  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [active, setActive] = createSignal<string | null>(null);
  const [roll, setRoll] = createSignal(1);
  const needle = () => query().trim().toLowerCase();
  const sorted = createMemo(() => [...pool()].sort((a, b) => a.name.localeCompare(b.name)));
  const sections = createMemo<Section[]>(() => {
    const text = needle();
    if (text && text !== "+") {
      const hits = sorted().filter(entry => matchesQuery(entry, text));
      const digitsOnly = onlyDigits(text);
      if (digitsOnly) hits.sort((a, b) => Number(b.dial === digitsOnly) - Number(a.dial === digitsOnly) || a.dial.length - b.dial.length);
      return [{ key: "results", rows: hits.map(entry => ({ key: `r-${entry.iso}`, entry })) }];
    }
    const preferred = (props.preferredCountries ?? ["US", "IN", "GB"]).map(code => pool().find(entry => entry.iso === code)).filter((entry): entry is PhoneCountry => !!entry);
    const all = { key: "all", label: preferred.length ? "All countries" : undefined, rows: sorted().map(entry => ({ key: `a-${entry.iso}`, entry })) };
    return preferred.length ? [{ key: "preferred", label: "Suggested", rows: preferred.map(entry => ({ key: `p-${entry.iso}`, entry })) }, all] : [all];
  });
  const rows = createMemo(() => sections().flatMap(section => section.rows));
  const activeKey = () => {
    const key = active();
    return key !== null && rows().some(row => row.key === key) ? key : rows()[0]?.key ?? null;
  };
  const orderOf = createMemo(() => new Map(sorted().map((entry, index) => [entry.iso, index])));

  let rootEl: HTMLDivElement | undefined;
  let control: HTMLDivElement | undefined;
  let measure: HTMLSpanElement | undefined;
  let listFace: HTMLDivElement | undefined;
  let scroller: HTMLDivElement | undefined;
  let trigger: HTMLButtonElement | undefined;
  let search: HTMLInputElement | undefined;
  let anchor: HTMLDivElement | undefined;
  let shape: HTMLDivElement | undefined;
  let highlight: HTMLSpanElement | undefined;
  const rowEls = new Map<string, HTMLElement>();

  /* One surface whose width, height and corners spring between the country button and the open list. */
  const sizes = { trigger: 0, lid: 0, panel: 0, list: 0 };
  const shapeState = { w: 0, h: 0, r: CLOSED_RADIUS, anchor: 0 };
  let measured = false;
  const running: AnimationControls[] = [];
  const applyShape = () => {
    if (anchor) anchor.style.width = `${shapeState.anchor}px`;
    if (shape) {
      shape.style.width = `${shapeState.w}px`;
      shape.style.height = `${shapeState.h}px`;
      shape.style.setProperty("--sq-r", `${shapeState.r}px`);
    }
  };
  const tweenValue = (key: keyof typeof shapeState, to: number, transition: object) => {
    running.push(animate(shapeState[key], to, { ...transition, onUpdate: (value: number) => { shapeState[key] = value; applyShape(); } }));
  };
  const place = (animated: boolean) => {
    const { trigger: triggerWidth, lid, panel, list } = sizes;
    if (!triggerWidth || !lid) return;
    const isOpen = open();
    const next = isOpen ? { w: Math.max(triggerWidth, panel), h: lid + 2 + list, r: OPEN_RADIUS } : { w: triggerWidth, h: lid, r: CLOSED_RADIUS };
    running.splice(0).forEach(controls => controls.stop());
    if (!animated || prefersReducedMotion() || !measured) {
      Object.assign(shapeState, { anchor: triggerWidth, w: next.w, h: next.h, r: next.r });
      applyShape();
      measured = true;
      return;
    }
    tweenValue("anchor", triggerWidth, WIDTH);
    tweenValue("w", next.w, isOpen ? GROW : SHRINK);
    tweenValue("h", next.h, isOpen ? GROW : SHRINK);
    tweenValue("r", next.r, isOpen ? GROW : SHRINK);
  };
  const read = () => {
    if (!measure || !control || !listFace || !rootEl) return false;
    const panel = Math.min(PANEL_MAX, control.offsetWidth);
    rootEl.style.setProperty("--pi-panel-w", `${panel}px`);
    const next = { trigger: measure.offsetWidth, lid: control.clientHeight, panel, list: listFace.offsetHeight };
    const changed = next.trigger !== sizes.trigger || next.lid !== sizes.lid || next.panel !== sizes.panel || (open() && next.list !== sizes.list);
    Object.assign(sizes, next);
    return changed;
  };
  onMount(() => {
    if (read()) place(false);
    if (!measure || !control || !listFace || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => { if (read()) place(measured); });
    observer.observe(measure);
    observer.observe(control);
    observer.observe(listFace);
    onCleanup(() => observer.disconnect());
  });

  let pendingFocus: "trigger" | "search" | "number" | null = null;
  createEffect(on(open, () => {
    read();
    place(true);
    const target = pendingFocus;
    pendingFocus = null;
    queueMicrotask(() => {
      if (target === "search") search?.focus({ preventScroll: true });
      if (target === "trigger") trigger?.focus({ preventScroll: true });
      if (target === "number" && input) { input.focus({ preventScroll: true }); input.setSelectionRange(input.value.length, input.value.length); }
    });
  }, { defer: true }));

  /* The highlight glides between rows on its own spring. */
  let highlightShown = false;
  let scrollIntent = false;
  createEffect(on([activeKey, open, sections], ([key, isOpen]) => {
    queueMicrotask(() => {
      const node = isOpen && key ? rowEls.get(key) : undefined;
      if (!highlight) return;
      if (!node) {
        animate(highlight, { opacity: 0 }, { duration: prefersReducedMotion() || !isOpen ? 0 : 0.12 });
        highlightShown = false;
        return;
      }
      const top = node.offsetTop;
      const height = node.offsetHeight;
      if (!highlightShown || prefersReducedMotion()) animate(highlight, { y: top, height: `${height}px` }, { duration: 0 });
      else animate(highlight, { y: top, height: `${height}px` }, GLIDE);
      animate(highlight, { opacity: 1 }, { duration: prefersReducedMotion() ? 0 : 0.12 });
      highlightShown = true;
      if (scroller && scrollIntent) {
        scrollIntent = false;
        const pad = 6;
        if (top < scroller.scrollTop + pad) scroller.scrollTop = top - pad;
        else if (top + height > scroller.scrollTop + scroller.clientHeight - pad) scroller.scrollTop = top + height - scroller.clientHeight + pad;
      }
    });
  }));

  function openList(seed = "") {
    if (props.disabled || open()) return;
    setQuery(seed);
    const selectedRow = seed ? null : sections().flatMap(section => section.rows).find(row => row.entry.iso === current().iso && !row.key.startsWith("p-")) ?? null;
    setActive(selectedRow?.key ?? null);
    scrollIntent = true;
    pendingFocus = "search";
    setAnnouncement("");
    setOpen(true);
  }
  const close = (focus: "trigger" | "number" | null) => {
    pendingFocus = focus;
    setOpen(false);
  };
  function pick(entry: PhoneCountry | undefined) {
    if (!entry) return;
    if (entry.iso !== current().iso) {
      setRoll(Math.sign((orderOf().get(entry.iso) ?? 0) - (orderOf().get(current().iso) ?? 0)) || 1);
      const nextDigits = capDigits(entry, digits());
      if (props.country === undefined) setIsoState(entry.iso);
      setDigits(nextDigits);
      props.onCountryChange?.(entry.iso);
      emit(entry, nextDigits);
      setAnnouncement(`${entry.name}, +${entry.dial}`);
    }
    close("number");
  }
  const move = (key: string | null | undefined) => {
    if (!key) return;
    scrollIntent = true;
    setActive(key);
  };
  const onSearchKeyDown = (event: KeyboardEvent) => {
    const list = rows();
    const at = list.findIndex(row => row.key === activeKey());
    switch (event.key) {
      case "ArrowDown": event.preventDefault(); move(list[Math.min(list.length - 1, at + 1)]?.key); return;
      case "ArrowUp": event.preventDefault(); move(list[Math.max(0, at - 1)]?.key); return;
      case "PageDown": event.preventDefault(); move(list[Math.min(list.length - 1, at + PAGE)]?.key); return;
      case "PageUp": event.preventDefault(); move(list[Math.max(0, at - PAGE)]?.key); return;
      case "Home": if (query()) return; event.preventDefault(); move(list[0]?.key); return;
      case "End": if (query()) return; event.preventDefault(); move(list[list.length - 1]?.key); return;
      case "Enter": event.preventDefault(); pick(list[at]?.entry); return;
      case "Escape": event.preventDefault(); event.stopPropagation(); close("trigger"); return;
      case "Tab": close(null); return;
    }
  };
  const onTriggerKeyDown = (event: KeyboardEvent) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); openList(); return; }
    if (event.key.length === 1 && event.key !== " " && !event.metaKey && !event.ctrlKey && !event.altKey) { event.preventDefault(); openList(event.key); }
  };
  const onQuery = (next: string) => {
    setQuery(next);
    setActive(null);
    if (scroller) scroller.scrollTop = 0;
    const text = next.trim().toLowerCase();
    const count = text && text !== "+" ? pool().filter(entry => matchesQuery(entry, text)).length : pool().length;
    setAnnouncement(text ? (count ? `${count} ${count === 1 ? "country" : "countries"}` : "No matches") : "");
  };

  createEffect(() => {
    if (!open()) return;
    const down = (event: PointerEvent) => { if (!rootEl?.contains(event.target as Node)) close(null); };
    document.addEventListener("pointerdown", down);
    onCleanup(() => document.removeEventListener("pointerdown", down));
  });

  const onRootFocusOut = (event: FocusEvent) => {
    const next = event.relatedTarget as Node | null;
    if (open() && next && !rootEl?.contains(next)) close(null);
  };

  const showCheck = () => status() === "valid";
  const invalid = () => !!message();
  const describedBy = () => [props.description ? hintId() : null, message() ? errorId() : null].filter(Boolean).join(" ") || undefined;

  const face = (entry: PhoneCountry) => (
    <>
      <span class={styles.flag} aria-hidden="true">{flagOf(entry.iso)}</span>
      <span class={styles.dial}>+{entry.dial}</span>
    </>
  );

  return (
    <div ref={rootEl} class={cx(styles.field, props.class)} data-open={open() || undefined} data-disabled={props.disabled || undefined} onFocusOut={onRootFocusOut}>
      <label for={inputId()} class={props.hideLabel ? "sr-only" : styles.label}>{props.label}</label>
      <div ref={el => { control = el; useSquircle(el); }} class={styles.control} data-invalid={invalid() || undefined}>
        <div ref={anchor} class={styles.anchor}>
          {/* Sizes the closed button: same padding and content, so the width spring has a target before anything moves. */}
          <span ref={measure} class={`${styles.trigger} ${styles.measure}`} aria-hidden="true">{face(current())}</span>
          <div ref={el => { shape = el; useSquircle(el); }} class={styles.shape}>
            <div class={styles.lid}>
              <button
                ref={trigger}
                type="button"
                class={styles.trigger}
                disabled={props.disabled}
                inert={open() || undefined}
                tabIndex={open() ? -1 : 0}
                aria-haspopup="listbox"
                aria-expanded={open()}
                aria-controls={listId}
                aria-label={`Country, ${current().name} +${current().dial}`}
                onClick={() => (open() ? close("trigger") : openList())}
                onKeyDown={onTriggerKeyDown}
              >
                <span class={styles.slot} data-hidden={open() || undefined}>
                  <Swap
                    value={current()}
                    keyOf={entry => entry.iso}
                    class={styles.layer}
                    enter={el => prefersReducedMotion()
                      ? animate(el, { opacity: [0, 1] }, tween(0.12))
                      : animate(el, { opacity: [0, 1], y: [`${roll() * 0.6}em`, "0em"], filter: ["blur(4px)", "blur(0px)"] }, { y: GLIDE, opacity: tween(0.2, motionTokens.ease.enter), filter: tween(0.22, motionTokens.ease.enter) })}
                    exit={el => prefersReducedMotion()
                      ? animate(el, { opacity: 0 }, tween(0.08))
                      : animate(el, { opacity: 0, y: `${roll() * -0.5}em`, filter: "blur(2px)" }, tween(0.12))}
                  >
                    {entry => face(entry)}
                  </Swap>
                </span>
              </button>
              <div class={styles.searchRow} inert={!open() || undefined} data-open={open() || undefined}>
                <Search class={styles.searchIcon} size={16} stroke-width={1.75} aria-hidden="true" />
                <input
                  ref={search}
                  class={styles.search}
                  type="text"
                  role="combobox"
                  aria-label="Search countries or calling codes"
                  aria-expanded={open()}
                  aria-controls={listId}
                  aria-autocomplete="list"
                  aria-activedescendant={open() && activeKey() ? optionId(activeKey() ?? "") : undefined}
                  placeholder="Country or code"
                  value={query()}
                  autocomplete="off"
                  spellcheck={false}
                  onInput={event => onQuery(event.currentTarget.value)}
                  onKeyDown={onSearchKeyDown}
                />
                <Presence when={!!query()} enter={el => animate(el, { opacity: [0, 1], scale: [0.6, 1] }, prefersReducedMotion() ? { duration: 0 } : GLIDE)} exit={el => animate(el, { opacity: 0, scale: 0.6 }, tween(0.1))}>
                  {ref => (
                    <button ref={ref} type="button" class={styles.clear} aria-label="Clear search" onPointerDown={event => event.preventDefault()} onClick={() => { onQuery(""); search?.focus(); }}>
                      <X size={14} stroke-width={1.75} aria-hidden="true" />
                    </button>
                  )}
                </Presence>
                <button type="button" class={styles.closeHit} aria-label="Close country list" onClick={() => close("trigger")} />
              </div>
              <span class={styles.chevron} aria-hidden="true" data-open={open() || undefined}><ChevronDown size={16} stroke-width={1.75} /></span>
            </div>
            <div ref={listFace} class={styles.listFace} inert={!open() || undefined} aria-hidden={!open() || undefined} data-open={open() || undefined}>
              <div ref={scroller} class={styles.scroll}>
                <div id={listId} class={styles.options} role="listbox" aria-label="Countries">
                  <span ref={highlight} class={styles.highlight} aria-hidden="true" />
                  <For each={sections()}>
                    {section => (
                      <div role={section.label ? "group" : "presentation"} aria-labelledby={section.label ? `phone-${uid}-${section.key}` : undefined} class={styles.group}>
                        <Show when={section.label}><div id={`phone-${uid}-${section.key}`} class={styles.groupLabel} role="presentation">{section.label}</div></Show>
                        <For each={section.rows}>
                          {row => (
                            <div
                              id={optionId(row.key)}
                              role="option"
                              aria-selected={row.entry.iso === current().iso}
                              class={styles.option}
                              data-active={row.key === activeKey() || undefined}
                              ref={node => { rowEls.set(row.key, node); onCleanup(() => rowEls.delete(row.key)); }}
                              onPointerMove={event => { if (event.pointerType === "mouse" && row.key !== activeKey()) setActive(row.key); }}
                              onPointerDown={event => event.preventDefault()}
                              onClick={() => pick(row.entry)}
                            >
                              <span class={styles.flag} aria-hidden="true">{flagOf(row.entry.iso)}</span>
                              <span class={styles.name}>{row.entry.name}</span>
                              <span class={styles.meta}>+{row.entry.dial}</span>
                              <span class={styles.check} data-on={row.entry.iso === current().iso || undefined} aria-hidden="true"><Check size={16} stroke-width={1.75} /></span>
                            </div>
                          )}
                        </For>
                      </div>
                    )}
                  </For>
                  <Show when={rows().length === 0}><p class={styles.empty}>No countries match “{query().trim()}”</p></Show>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div class={styles.numberWrap}>
          <span class={styles.guide} aria-hidden="true"><span class={styles.guideTyped}>{formatted()}</span>{guide()}</span>
          <input
            ref={el => { input = el; props.ref?.(el); }}
            id={inputId()}
            class={styles.number}
            type="tel"
            inputmode="tel"
            autocomplete="tel"
            value={formatted()}
            disabled={props.disabled}
            required={props.required}
            aria-invalid={invalid() || undefined}
            aria-describedby={describedBy()}
            onInput={onNumberInput}
            onKeyDown={onNumberKeyDown}
            onPaste={onPaste}
            onBlur={event => { setTouched(digits().length > 0); props.onBlur?.(event); }}
          />
          <Presence
            when={showCheck()}
            enter={el => prefersReducedMotion() ? animate(el, { opacity: [0, 1] }, tween(0.12)) : animate(el, { opacity: [0, 1], scale: [0.6, 1], filter: ["blur(2px)", "blur(0px)"] }, spring.snappy)}
            exit={el => animate(el, { opacity: 0, scale: prefersReducedMotion() ? 1 : 0.8 }, tween(0.1))}
          >
            {ref => <span ref={ref} class={styles.valid} aria-hidden="true"><Check size={16} stroke-width={2} /></span>}
          </Presence>
        </div>
      </div>
      <FieldMessage id={hintId()} text={props.description && !message() ? props.description : null} />
      <FieldMessage id={errorId()} text={message()} tone="error" alert />
      <Show when={props.name}><input type="hidden" name={props.name} value={e164()} /></Show>
      <span class="sr-only" role="status" aria-live="polite">{announcement() || (showCheck() ? `Valid ${current().name} number` : "")}</span>
    </div>
  );
}

export default PhoneInput;
