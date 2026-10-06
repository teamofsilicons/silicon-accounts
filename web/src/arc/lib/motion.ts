/**
 * Motion for the Solid port of Arc. Arc uses `motion/react`; here the same engine runs through Motion's vanilla
 * `animate()` with Arc's tokens, plus a few small helpers that replace the React-only pieces (whileTap, presence,
 * layout glides). Every helper honours prefers-reduced-motion.
 */
import { animate } from "motion";
import { createSignal, onCleanup, type Accessor } from "solid-js";
import { motionTokens } from "./motion-tokens";

export { animate, motionTokens };

type Controls = ReturnType<typeof animate>;
export type AnimationControls = Controls;
export type AnimateOptions = NonNullable<Parameters<typeof animate>[2]>;

const query = typeof window !== "undefined" && typeof window.matchMedia === "function"
  ? window.matchMedia("(prefers-reduced-motion: reduce)")
  : undefined;
const [reduced, setReduced] = createSignal(query?.matches ?? false);
query?.addEventListener("change", event => setReduced(event.matches));

/** Live `prefers-reduced-motion` value. Read it inside effects so components react when the setting changes. */
export const prefersReducedMotion: Accessor<boolean> = reduced;

const e = motionTokens.ease;
type Bezier = [number, number, number, number];
const bezier = (value: readonly number[]) => [...value] as Bezier;

/** Tween options from Arc tokens. */
export function tween(duration: number, ease: readonly number[] = e.standard): { duration: number; ease: Bezier } {
  return { duration, ease: bezier(ease) };
}

export const spring = {
  snappy: { ...motionTokens.spring.snappy },
  smooth: { ...motionTokens.spring.smooth },
  morph: { ...motionTokens.spring.morph },
} as const;

/** Instant transition used by reduced-motion branches. */
export const instant = { duration: 0 } as const;

const blur = (px: number) => `blur(${px}px)`;

/** Shared keyframe presets: text that rises in from a soft blur and lifts away, icons that pop, plain fades. */
export const presets = {
  textIn(el: Element, distance = "0.3em"): Controls {
    if (reduced()) return animate(el, { opacity: [0, 1] }, tween(motionTokens.duration.instant));
    return animate(
      el,
      { opacity: [0, 1], y: [distance, "0em"], filter: [blur(motionTokens.blur.soft), blur(0)] },
      tween(motionTokens.duration.standard, e.enter),
    );
  },
  textOut(el: Element, distance = "-0.3em"): Controls {
    if (reduced()) return animate(el, { opacity: 0 }, instant);
    return animate(
      el,
      { opacity: 0, y: distance, filter: blur(motionTokens.blur.subtle) },
      tween(motionTokens.duration.fast, e.standard),
    );
  },
  iconIn(el: Element): Controls {
    if (reduced()) return animate(el, { opacity: [0, 1] }, tween(motionTokens.duration.instant));
    return animate(
      el,
      { opacity: [0, 1], scale: [0.6, 1], filter: [blur(motionTokens.blur.subtle), blur(0)] },
      { ...spring.snappy, opacity: tween(motionTokens.duration.fast, e.enter), filter: tween(motionTokens.duration.fast, e.enter) },
    );
  },
  iconOut(el: Element): Controls {
    if (reduced()) return animate(el, { opacity: 0 }, instant);
    return animate(el, { opacity: 0, scale: 0.6, filter: blur(motionTokens.blur.subtle) }, tween(motionTokens.duration.fast, e.standard));
  },
  fadeIn(el: Element): Controls {
    return animate(el, { opacity: [0, 1] }, tween(reduced() ? motionTokens.duration.instant : motionTokens.duration.fast, e.enter));
  },
  fadeOut(el: Element): Controls {
    return animate(el, { opacity: 0 }, reduced() ? instant : tween(motionTokens.duration.fast, e.standard));
  },
};

/** Presses scale to about 0.97: icon buttons a little deeper, wide buttons a little less (Arc button). */
export function pressScale(el: HTMLElement): number {
  const width = el.offsetWidth;
  return width > 220 ? 0.985 : width && width <= 48 ? 0.96 : 0.97;
}

/** Elements that anchor a floating layer answer presses with colour only: the layer measures the anchor on open. */
export function anchorsLayer(el: HTMLElement): boolean {
  const popup = el.getAttribute("aria-haspopup");
  return (popup !== null && popup !== "false") || el.getAttribute("role") === "combobox" || el.hasAttribute("aria-expanded");
}

export interface PressOptions {
  scale?: number | ((el: HTMLElement) => number);
  disabled?: () => boolean;
}

/**
 * Arc's whileTap: a quick press on pointer down, a snappy spring back on release. Returns a disposer and also
 * registers cleanup with the current Solid owner.
 */
export function pressable(el: HTMLElement, options: PressOptions = {}): () => void {
  let pressed = false;
  const release = () => {
    if (!pressed) return;
    pressed = false;
    window.removeEventListener("pointerup", release);
    window.removeEventListener("pointercancel", release);
    animate(el, { scale: 1 }, reduced() ? instant : spring.snappy);
  };
  const down = (event: PointerEvent) => {
    if (event.button !== 0 || reduced() || options.disabled?.() || anchorsLayer(el)) return;
    if (el.matches(":disabled, [aria-disabled='true'], [aria-busy='true']")) return;
    const scale = typeof options.scale === "function" ? options.scale(el) : options.scale ?? pressScale(el);
    pressed = true;
    animate(el, { scale }, tween(motionTokens.duration.instant, e.standard));
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
  };
  el.addEventListener("pointerdown", down);
  const dispose = () => {
    el.removeEventListener("pointerdown", down);
    window.removeEventListener("pointerup", release);
    window.removeEventListener("pointercancel", release);
  };
  onCleanup(dispose);
  return dispose;
}

/**
 * A highlight that glides between items (menus, segmented controls, tabs, the dock): one element animated to the
 * target's box. The pointer glides on a spring; the keyboard jumps, so the position always tracks focus at once.
 */
export function createGlide(getHighlight: () => HTMLElement | undefined, transition: AnimateOptions = spring.morph) {
  let shown = false;
  let current: Controls | undefined;
  function moveTo(target: HTMLElement | null | undefined, glide = true) {
    const highlight = getHighlight();
    if (!highlight) return;
    if (!target) {
      shown = false;
      current?.stop();
      current = animate(highlight, { opacity: 0 }, reduced() ? instant : tween(0.08));
      return;
    }
    const x = target.offsetLeft;
    const y = target.offsetTop;
    const width = target.offsetWidth;
    const height = target.offsetHeight;
    current?.stop();
    if (!shown || !glide || reduced()) {
      current = animate(highlight, { x, y, width, height, opacity: 1 }, { ...instant, opacity: reduced() ? instant : tween(0.08) });
    } else {
      current = animate(highlight, { x, y, width, height, opacity: 1 }, { ...transition, opacity: tween(0.08) });
    }
    shown = true;
  }
  return { moveTo, hide: () => moveTo(null) };
}
