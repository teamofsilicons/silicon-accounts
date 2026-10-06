import { For, Show, createEffect, createMemo, createSignal, createUniqueId, on, onCleanup, onMount, untrack } from "solid-js";
import { Check, Pipette, Plus } from "lucide-solid";
import { TextMorph } from "../text-morph/text-morph";
import { SwapText } from "../lib/presence";
import { animate, motionTokens, prefersReducedMotion, type AnimationControls } from "../lib/motion";
import { useSquircle } from "../lib/squircle";
import { byte, clamp, contrast, contrastLevel, formatColor, hsvToRgb, parseColor, toHex, type ColorFormat, type Hsva } from "./color";
import styles from "./color-picker.module.css";

export * from "./color";

export interface ColorSwatch {
  id: string;
  color: string;
}

export interface ColorPickerProps {
  /** Any colour the picker can read: hex, rgb(), hsl() or oklch(). */
  value?: string;
  defaultValue?: string;
  /** Receives the colour as hex (#RRGGBB, plus alpha digits only when `alpha` is on and it is not opaque). */
  onValueChange?: (hex: string) => void;
  /** The background the colour will sit on, for the contrast readout. */
  background?: string;
  /** What the contrast is measured against, in words ("against the background"). */
  backgroundLabel?: string;
  /** Name shown on the swatch, such as "Primary". */
  label?: string;
  /** Show the opacity slider. Off by default: branding colours are opaque #RRGGBB. */
  alpha?: boolean;
  swatches?: ColorSwatch[];
  defaultSwatches?: ColorSwatch[];
  onSwatchesChange?: (swatches: ColorSwatch[]) => void;
  maxSwatches?: number;
  defaultFormat?: ColorFormat;
  class?: string;
}

const physical = (visualDuration: number, bounce: number) => {
  const root = (2 * Math.PI) / (visualDuration * 1.2);
  return { type: "spring" as const, stiffness: root * root, damping: 2 * (1 - bounce) * root, mass: 1, restDelta: 0.0005, restSpeed: 0.005 };
};
/** Thumbs chase the pointer on a quick spring with a little life; under a drag they stay glued to it. */
const thumbSpring = physical(0.26, 0.22);
const dragSpring = physical(0.1, 0);
const openSpring = physical(motionTokens.spring.morph.visualDuration, 0.1);
const closeSpring = physical(0.3, 0);
const formats: ColorFormat[] = ["hex", "rgb", "hsl", "oklch"];
const formatNames: Record<ColorFormat, string> = { hex: "Hex", rgb: "RGB", hsl: "HSL", oklch: "OKLCH" };
let swatchCount = 0;
const newId = () => `swatch-${Date.now().toString(36)}-${swatchCount++}`;
type EyeDropperCtor = new () => { open: () => Promise<{ sRGBHex: string }> };

/** A value that springs to its target (or jumps under reduced motion) and writes itself through `paint`. */
function createFollow(initial: number, paint: (value: number) => void) {
  let value = initial;
  let controls: AnimationControls | undefined;
  return {
    to(target: number, dragging = false) {
      controls?.stop();
      if (prefersReducedMotion()) { value = target; paint(value); return; }
      controls = animate(value, target, { ...(dragging ? dragSpring : thumbSpring), onUpdate: next => { value = next; paint(next); } });
    },
    jump(target: number) { controls?.stop(); value = target; paint(value); },
  };
}

/** Tracks a pointer drag over an element and reports its position as fractions of the element's box. */
function pad(onMove: (x: number, y: number) => void, onActive: (active: boolean) => void) {
  let pointer: number | null = null;
  const read = (event: PointerEvent) => {
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    onMove(clamp((event.clientX - box.left) / box.width), clamp((event.clientY - box.top) / box.height));
  };
  return {
    onPointerDown(event: PointerEvent) {
      if (event.button !== 0 || pointer !== null) return;
      pointer = event.pointerId;
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
      onActive(true);
      read(event);
    },
    onPointerMove(event: PointerEvent) { if (event.pointerId === pointer) read(event); },
    onPointerUp(event: PointerEvent) { if (event.pointerId !== pointer) return; pointer = null; onActive(false); },
    onPointerCancel(event: PointerEvent) { if (event.pointerId !== pointer) return; pointer = null; onActive(false); },
  };
}

function stepFor(event: KeyboardEvent, axis: "x" | "both"): [number, number] | null {
  const big = event.shiftKey || event.key.startsWith("Page");
  const size = big ? 10 : 1;
  const map: Record<string, [number, number]> = {
    ArrowRight: [size, 0], ArrowLeft: [-size, 0],
    ArrowUp: axis === "both" ? [0, size] : [size, 0], ArrowDown: axis === "both" ? [0, -size] : [-size, 0],
    PageUp: [10, 0], PageDown: [-10, 0],
  };
  return map[event.key] ?? null;
}

function Chip(props: { color: string; class?: string }) {
  return <span ref={el => useSquircle(el, { mode: "clip" })} class={`${styles.chip} ${props.class ?? ""}`}><span style={{ background: props.color }} /></span>;
}

function Slider(props: { label: string; value: () => number; valueText: () => string; max: number; class: string; fill: () => string; onChange: (value: number) => void; active: () => boolean; onActive: (active: boolean) => void }) {
  let thumb: HTMLDivElement | undefined;
  const follow = createFollow(untrack(props.value) / props.max, value => { if (thumb) thumb.style.left = `${value * 100}%`; });
  createEffect(on(props.value, value => follow.to(value / props.max, props.active())));
  onMount(() => follow.jump(untrack(props.value) / props.max));
  const handlers = pad(fx => props.onChange(fx * props.max), props.onActive);
  return (
    <div class={`${styles.slider} ${props.class}`} onPointerDown={handlers.onPointerDown} onPointerMove={handlers.onPointerMove} onPointerUp={handlers.onPointerUp} onPointerCancel={handlers.onPointerCancel}>
      <div
        ref={thumb}
        class={styles.sliderThumb}
        role="slider"
        tabIndex={0}
        aria-label={props.label}
        aria-valuemin={0}
        aria-valuemax={props.max}
        aria-valuenow={Math.round(props.value())}
        aria-valuetext={props.valueText()}
        style={{ "--thumb-fill": props.fill() }}
        data-active={props.active() || undefined}
        onKeyDown={event => {
          if (event.key === "Home" || event.key === "End") { event.preventDefault(); props.onChange(event.key === "Home" ? 0 : props.max); return; }
          const step = stepFor(event, "x");
          if (!step) return;
          event.preventDefault();
          props.onChange(clamp(props.value() + step[0], 0, props.max));
        }}
      />
    </div>
  );
}

/**
 * Arc ColorPicker: a colour field whose swatch grows into a full picker. Saturation and brightness on the area, hue
 * (and optionally opacity) on sliders, or type hex, RGB, HSL or OKLCH; the format button morphs the text. A contrast
 * readout compares the colour with the background it will sit on. Arrow keys move every thumb; Escape closes.
 */
export function ColorPicker(props: ColorPickerProps) {
  const uid = createUniqueId();
  const canPick = typeof window !== "undefined" && "EyeDropper" in window;
  const [hsva, setHsva] = createSignal<Hsva>(parseColor(untrack(() => props.value ?? props.defaultValue ?? "#1F5FB8")) ?? { h: 215, s: 0.83, v: 0.72, a: 1 });
  createEffect(on(() => props.value, value => {
    if (value === undefined || value.toUpperCase() === toHex(untrack(hsva))) return;
    const next = parseColor(value, untrack(hsva).h);
    if (next) setHsva(next);
  }, { defer: true }));
  const [ownSwatches, setOwnSwatches] = createSignal<ColorSwatch[]>(props.defaultSwatches ?? []);
  const swatches = () => props.swatches ?? ownSwatches();
  const [open, setOpen] = createSignal(false);
  const [shown, setShown] = createSignal(false);
  const [kind, setKind] = createSignal<ColorFormat>(props.defaultFormat ?? "hex");
  const [draft, setDraft] = createSignal<string | null>(null);
  const [invalid, setInvalid] = createSignal(false);
  const [morph, setMorph] = createSignal<string | null>(null);
  const [active, setActive] = createSignal<"area" | "hue" | "alpha" | null>(null);
  const [focusSwatch, setFocusSwatch] = createSignal<string | null>(null);
  let rootEl: HTMLDivElement | undefined;
  let trigger: HTMLButtonElement | undefined;
  let panel: HTMLDivElement | undefined;
  let body: HTMLDivElement | undefined;
  let headActions: HTMLSpanElement | undefined;
  let areaThumb: HTMLDivElement | undefined;
  let field: HTMLDivElement | undefined;
  let input: HTMLInputElement | undefined;
  let openNow = false;

  const hex = createMemo(() => toHex(props.alpha ? hsva() : { ...hsva(), a: 1 }));
  const rgb = () => hsvToRgb(hsva());
  const css = () => `rgb(${byte(rgb().r)} ${byte(rgb().g)} ${byte(rgb().b)} / ${Math.round(hsva().a * 1000) / 1000})`;
  const opaque = () => `rgb(${byte(rgb().r)} ${byte(rgb().g)} ${byte(rgb().b)})`;
  const pure = () => `hsl(${hsva().h} 100% 50%)`;
  const ratio = createMemo(() => {
    const bg = parseColor(props.background ?? "#FFFFFF");
    return contrast(hsva(), bg ? hsvToRgb(bg) : { r: 1, g: 1, b: 1, a: 1 });
  });
  const grade = () => contrastLevel(ratio());
  const text = () => formatColor(props.alpha ? hsva() : { ...hsva(), a: 1 }, kind());

  const commit = (next: Hsva) => {
    const value = props.alpha ? next : { ...next, a: 1 };
    const before = hex();
    setHsva(value);
    const after = toHex(value);
    if (after !== before) props.onValueChange?.(after);
  };
  const setSwatches = (next: ColorSwatch[]) => {
    if (!props.swatches) setOwnSwatches(next);
    props.onSwatchesChange?.(next);
  };

  /* The surface: one progress value grows the swatch's box into the panel's box; the content fades in behind the leading edge. */
  let progress = 0;
  let surface: AnimationControls | undefined;
  const paintPanel = () => {
    if (!panel || !trigger) return;
    const q = clamp(progress);
    const W = panel.offsetWidth, H = panel.offsetHeight, w = trigger.offsetWidth, h = trigger.offsetHeight;
    // Fully open, the panel's own squircle is the shape: drop the reveal clip so it never trims the corners.
    panel.style.clipPath = q >= 0.999 ? "none" : `inset(0px ${Math.round((W - w) * (1 - q) * 100) / 100}px ${Math.round((H - h) * (1 - q) * 100) / 100}px 0px round ${22 + 4 * q}px)`;
    const content = clamp((q - 0.35) / 0.55);
    if (body) { body.style.opacity = String(content); body.style.transform = `translateY(${-10 * (1 - q)}px)`; }
    if (headActions) headActions.style.opacity = String(content);
  };
  createEffect(on(open, isOpen => {
    if (!shown()) return;
    surface?.stop();
    queueMicrotask(() => {
      if (prefersReducedMotion()) {
        progress = isOpen ? 1 : 0;
        paintPanel();
        if (panel) animate(panel, { opacity: isOpen ? [0, 1] : 0 }, { duration: motionTokens.duration.fast }).then(() => { if (!openNow) setShown(false); });
        return;
      }
      if (panel) panel.style.opacity = "1";
      surface = animate(progress, isOpen ? 1 : 0, { ...(isOpen ? openSpring : closeSpring), onUpdate: value => { progress = value; paintPanel(); } });
      if (!isOpen) surface.then(() => { if (!openNow) setShown(false); });
      else requestAnimationFrame(() => areaThumb?.focus({ preventScroll: true }));
    });
  }, { defer: true }));

  const show = () => { openNow = true; setShown(true); setOpen(true); };
  const hide = (returnFocus = true) => {
    openNow = false;
    setOpen(false);
    setDraft(null);
    setInvalid(false);
    if (returnFocus) trigger?.focus({ preventScroll: true });
  };
  createEffect(() => {
    if (!open()) return;
    const listener = (event: Event) => {
      if (event instanceof KeyboardEvent) {
        if (event.key === "Escape") hide(!!rootEl?.contains(document.activeElement));
        return;
      }
      if (!rootEl?.contains(event.target as Node)) hide(false);
    };
    document.addEventListener("pointerdown", listener, true);
    document.addEventListener("keydown", listener);
    onCleanup(() => { document.removeEventListener("pointerdown", listener, true); document.removeEventListener("keydown", listener); });
  });

  /* The saturation and brightness area. */
  const areaX = createFollow(untrack(hsva).s, value => { if (areaThumb) areaThumb.style.left = `${value * 100}%`; });
  const areaY = createFollow(1 - untrack(hsva).v, value => { if (areaThumb) areaThumb.style.top = `${value * 100}%`; });
  createEffect(on(hsva, value => { areaX.to(value.s, active() === "area"); areaY.to(1 - value.v, active() === "area"); }, { defer: true }));
  const areaPad = pad((x, y) => commit({ ...hsva(), s: x, v: 1 - y }), on_ => setActive(on_ ? "area" : null));

  const cycleFormat = () => {
    const from = text();
    const next = formats[(formats.indexOf(kind()) + 1) % formats.length] ?? "hex";
    setKind(next);
    setDraft(null);
    setInvalid(false);
    if (prefersReducedMotion()) return;
    setMorph(from);
    requestAnimationFrame(() => setMorph(text()));
    setTimeout(() => setMorph(null), 620);
  };
  const submitDraft = () => {
    const value = draft();
    if (value === null) return true;
    const next = parseColor(value, hsva().h);
    if (!next) {
      setInvalid(true);
      if (!prefersReducedMotion() && field) animate(field, { x: [0, -5, 4, -2, 0] }, { duration: 0.32, ease: [...motionTokens.ease.standard] as [number, number, number, number] });
      return false;
    }
    commit(next);
    setDraft(null);
    setInvalid(false);
    return true;
  };
  const pickFromScreen = () => {
    if (!canPick) return;
    const Ctor = (window as unknown as { EyeDropper: EyeDropperCtor }).EyeDropper;
    new Ctor().open().then(result => { const next = parseColor(result.sRGBHex, hsva().h); if (next) commit({ ...next, a: hsva().a }); }).catch(() => undefined);
  };
  const saveSwatch = () => {
    const entry = { id: newId(), color: hex() };
    setSwatches([entry, ...swatches()].slice(0, props.maxSwatches ?? 7));
    setFocusSwatch(entry.id);
  };
  const swatchEls = new Map<string, HTMLButtonElement>();
  const onSwatchKey = (event: KeyboardEvent, index: number) => {
    const list = swatches();
    const item = list[index];
    if (!item) return;
    const move = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      const next = list.filter(entry => entry.id !== item.id);
      setSwatches(next);
      const neighbor = next[Math.min(index, next.length - 1)];
      setFocusSwatch(neighbor?.id ?? null);
      requestAnimationFrame(() => (neighbor ? swatchEls.get(neighbor.id)?.focus({ preventScroll: true }) : input?.focus({ preventScroll: true })));
      return;
    }
    if (!move && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    if (move && event.altKey) {
      const to = index + move;
      if (to < 0 || to >= list.length) return;
      const next = [...list];
      next.splice(index, 1);
      next.splice(to, 0, item);
      setSwatches(next);
      requestAnimationFrame(() => swatchEls.get(item.id)?.focus({ preventScroll: true }));
      return;
    }
    const target = event.key === "Home" ? 0 : event.key === "End" ? list.length - 1 : (index + move + list.length) % list.length;
    const entry = list[target];
    if (!entry) return;
    setFocusSwatch(entry.id);
    swatchEls.get(entry.id)?.focus({ preventScroll: true });
  };
  const swatchTab = () => (swatches().some(entry => entry.id === focusSwatch()) ? focusSwatch() : swatches()[0]?.id);

  return (
    <div ref={rootEl} class={[styles.root, props.class ?? ""].join(" ")} style={{ "--picker-color": css(), "--picker-opaque": opaque(), "--picker-hue": pure(), "--picker-bg": props.background ?? "#FFFFFF" }}>
      <button ref={el => { trigger = el; useSquircle(el); }} type="button" class={styles.trigger} aria-haspopup="dialog" aria-expanded={open()} aria-controls={open() ? `cp-${uid}-panel` : undefined} onClick={() => (open() ? hide() : show())}>
        <Chip color={css()} />
        <span class={styles.triggerText}><span class={styles.name}>{props.label ?? "Colour"}</span><span class={styles.hex}>{hex()}</span></span>
      </button>
      <Show when={shown()}>
        <div class={styles.float} data-open={open() || undefined}>
          <div ref={el => { panel = el; useSquircle(el); requestAnimationFrame(paintPanel); }} id={`cp-${uid}-panel`} role="dialog" aria-label={`${props.label ?? "Colour"} picker`} class={styles.panel} inert={!open()}>
            <div class={styles.head}>
              <Chip color={css()} />
              <span class={styles.triggerText}><span class={styles.name}>{props.label ?? "Colour"}</span><span class={styles.hex}>{hex()}</span></span>
              <span ref={headActions} class={styles.headActions}>
                <Show when={canPick}><button type="button" class={styles.iconButton} aria-label="Pick a colour from the screen" onClick={pickFromScreen}><Pipette size={18} stroke-width={1.75} aria-hidden="true" /></button></Show>
                <button type="button" class={styles.iconButton} aria-label="Done" onClick={() => hide()}><Check size={18} stroke-width={1.75} aria-hidden="true" /></button>
              </span>
            </div>
            <div ref={body} class={styles.body}>
              <div
                ref={el => useSquircle(el, { mode: "clip" })}
                class={styles.area}
                data-active={active() === "area" || undefined}
                onPointerDown={areaPad.onPointerDown}
                onPointerMove={areaPad.onPointerMove}
                onPointerUp={areaPad.onPointerUp}
                onPointerCancel={areaPad.onPointerCancel}
              >
                <div
                  ref={el => { areaThumb = el; queueMicrotask(() => { areaX.jump(hsva().s); areaY.jump(1 - hsva().v); }); }}
                  class={styles.areaThumb}
                  role="slider"
                  tabIndex={0}
                  aria-roledescription="2D slider"
                  aria-label="Saturation and brightness"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(hsva().s * 100)}
                  aria-valuetext={`Saturation ${Math.round(hsva().s * 100)}%, brightness ${Math.round(hsva().v * 100)}%`}
                  onKeyDown={event => {
                    const step = stepFor(event, "both");
                    if (!step) return;
                    event.preventDefault();
                    commit({ ...hsva(), s: clamp(hsva().s + step[0] / 100), v: clamp(hsva().v + step[1] / 100) });
                  }}
                />
              </div>
              <Slider label="Hue" value={() => hsva().h} valueText={() => `${Math.round(hsva().h)} degrees`} max={360} class={styles.hue} fill={pure} onChange={h => commit({ ...hsva(), h: clamp(h, 0, 359.9) })} active={() => active() === "hue"} onActive={on_ => setActive(on_ ? "hue" : null)} />
              <Show when={props.alpha}>
                <Slider label="Opacity" value={() => hsva().a * 100} valueText={() => `${Math.round(hsva().a * 100)}%`} max={100} class={styles.alpha} fill={css} onChange={a => commit({ ...hsva(), a: clamp(a / 100) })} active={() => active() === "alpha"} onActive={on_ => setActive(on_ ? "alpha" : null)} />
              </Show>
              <div ref={el => { field = el; useSquircle(el); }} class={styles.field} data-invalid={invalid() || undefined}>
                <button type="button" class={styles.format} onClick={cycleFormat} aria-label={`Format: ${formatNames[kind()]}. Switch format`}>
                  <TextMorph>{formatNames[kind()]}</TextMorph>
                </button>
                <span class={styles.inputWrap}>
                  <input
                    ref={input}
                    class={styles.input}
                    value={draft() ?? text()}
                    spellcheck={false}
                    autocomplete="off"
                    aria-label={`${props.label ?? "Colour"} in ${formatNames[kind()]}`}
                    aria-invalid={invalid() || undefined}
                    aria-describedby={invalid() ? `cp-${uid}-error` : undefined}
                    data-morphing={morph() !== null ? "" : undefined}
                    onInput={event => { setDraft(event.currentTarget.value); setInvalid(false); }}
                    onKeyDown={event => {
                      if (event.key === "Enter") { event.preventDefault(); if (submitDraft()) event.currentTarget.select(); }
                      if (event.key === "Escape" && draft() !== null) { event.stopPropagation(); event.stopImmediatePropagation(); setDraft(null); setInvalid(false); }
                    }}
                    onBlur={() => { if (!submitDraft()) { setDraft(null); setInvalid(false); } }}
                  />
                  <Show when={morph() !== null}><span class={styles.morph} aria-hidden="true"><TextMorph>{morph() ?? ""}</TextMorph></span></Show>
                </span>
              </div>
              <p id={`cp-${uid}-error`} class={styles.error} aria-live="polite">{invalid() ? "Enter a hex, RGB, HSL or OKLCH colour" : ""}</p>
              <div class={styles.contrast}>
                <span ref={el => useSquircle(el)} class={styles.sample} aria-hidden="true">Aa</span>
                <span class={styles.ratio}>{ratio().toFixed(2)}:1</span>
                <span class={styles.against}>{props.backgroundLabel ?? "against the background"}</span>
                <span ref={el => useSquircle(el)} class={styles.grade} data-grade={grade() === "Fails" ? "fail" : grade() === "AA large" ? "large" : "pass"}><SwapText text={grade()} /></span>
                <span class="sr-only">{`Contrast ${ratio().toFixed(2)} to 1, ${grade() === "Fails" ? "fails" : `passes ${grade()}`}`}</span>
              </div>
              <div class={styles.swatches}>
                <button type="button" class={styles.add} onClick={saveSwatch} aria-label={`Save ${hex()}`}><Plus size={16} stroke-width={1.75} aria-hidden="true" /></button>
                <div class={styles.swatchList} role="listbox" aria-label="Saved colours" aria-orientation="horizontal">
                  <For each={swatches()}>
                    {(entry, index) => (
                      <button
                        ref={el => { swatchEls.set(entry.id, el); onCleanup(() => swatchEls.delete(entry.id)); }}
                        type="button"
                        role="option"
                        aria-selected={entry.color.toUpperCase() === hex()}
                        class={styles.swatch}
                        data-current={entry.color.toUpperCase() === hex() || undefined}
                        aria-label={`${entry.color}. Alt and arrow keys to move, Delete to remove`}
                        tabIndex={entry.id === swatchTab() ? 0 : -1}
                        onFocus={() => setFocusSwatch(entry.id)}
                        onKeyDown={event => onSwatchKey(event, index())}
                        onClick={() => { const next = parseColor(entry.color, hsva().h); if (next) commit(next); }}
                      >
                        <Chip color={entry.color} class={styles.swatchChip} />
                      </button>
                    )}
                  </For>
                </div>
              </div>
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
}

export default ColorPicker;
