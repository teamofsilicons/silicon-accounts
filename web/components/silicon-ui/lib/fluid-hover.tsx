"use client";

/**
 * Fluid hover: in a set of items (a menu, a list, tabs, a grid), the item nearest the pointer is lit, even while the
 * pointer is in a gap, the padding or past the last item, and one highlight springs between items. A click in a gap goes
 * to the lit item, so what is lit is what a click hits. A new pointer entry fades the highlight in where it lands instead
 * of sliding it over from the last item. The keyboard moves it without travel, and reduced motion keeps the fade but
 * drops the travel.
 *
 *   const list = useRef<HTMLUListElement>(null);
 *   const hover = useFluidHover(list, { items: "[data-item]" });
 *   <ul ref={list} className={styles.list} {...hover.handlers}>      // .list { position: relative }
 *     <FluidHoverHighlight hover={hover} className={styles.highlight} />
 *     …items…
 *   </ul>
 *
 * Adapted from Fluid Functionalism's use-fluid-hover and fluid-hover-highlight by Micka Touillaud (MIT),
 * https://github.com/mickadesign/fluid-functionalism. Items are found by a selector instead of registering themselves,
 * so a component adopts it without changing its items.
 */
import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { FocusEvent, MouseEvent, PointerEvent, RefObject } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { motionTokens } from "./motion-tokens";

/** An item's box in the container's own layout space (unaffected by transforms or scrolling). */
export interface FluidRect { top: number; left: number; width: number; height: number }

export interface FluidHoverState {
  /** Where the highlight sits, or null when nothing is lit. */
  rect: FluidRect | null;
  /** The lit item. */
  item: HTMLElement | null;
  /** False when the highlight should jump (keyboard, a resize) rather than travel. */
  glide: boolean;
  /** Steps on each new pointer entry, so the highlight fades in where it lands. */
  session: number;
}

export interface FluidHoverOptions {
  /** Selector for the items inside the container. */
  items: string;
  /** "y" for lists (default), "x" for a row of tabs, "xy" for grids. */
  axis?: "x" | "y" | "xy";
  /** Items the highlight skips (and a gap click never activates). Defaults to disabled or aria-disabled items. */
  isItemDisabled?: (item: HTMLElement) => boolean;
  /** "skip" (default) lights the nearest enabled item even over a disabled one; "clear" lights nothing over a disabled item (a calendar's unavailable days). */
  disabled?: "skip" | "clear";
  /** Route a click in a gap to the lit item. On by default; turn it off where empty space should stay inert. */
  gapClick?: boolean;
  /** Light the item that receives keyboard focus. On by default. */
  followFocus?: boolean;
}

const defaultDisabled = (item: HTMLElement) =>
  item.matches(":disabled, [aria-disabled='true'], [data-disabled]");

/** Controls that sit between items keep their own clicks. */
const CONTROL = "input, textarea, select, button, a, summary, [contenteditable], [role='textbox'], [role='searchbox'], [role='button']";

/** The item's box relative to the container, summing offsets through positioned ancestors in between. */
export function rectOf(item: HTMLElement, container: HTMLElement): FluidRect {
  let top = item.offsetTop, left = item.offsetLeft;
  let parent = item.offsetParent as HTMLElement | null;
  while (parent && parent !== container && container.contains(parent)) {
    top += parent.offsetTop + parent.clientTop;
    left += parent.offsetLeft + parent.clientLeft;
    parent = parent.offsetParent as HTMLElement | null;
  }
  return { top, left, width: item.offsetWidth, height: item.offsetHeight };
}

/**
 * The item the pointer is inside, or else the one whose edge is nearest along the axis (both axes for a grid). Edges, not
 * centres, so a gap next to a wide item still lights the item the pointer is closer to.
 */
export function pickNearest(items: HTMLElement[], x: number, y: number, axis: "x" | "y" | "xy"): HTMLElement | null {
  let nearest: HTMLElement | null = null, best = Infinity;
  for (const item of items) {
    const r = item.getBoundingClientRect();
    if (!r.width && !r.height) continue;
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return item;
    const dx = Math.max(r.left - x, 0, x - r.right), dy = Math.max(r.top - y, 0, y - r.bottom);
    const distance = axis === "x" ? dx : axis === "y" ? dy : Math.hypot(dx, dy);
    if (distance < best) { best = distance; nearest = item; }
  }
  return nearest;
}

/** Hands a gap click to the item as a real mouse click (detail, modifiers and coordinates kept), so the item reads it as a pointer press, not a keyboard one. */
function forwardClick(item: HTMLElement, event: MouseEvent<HTMLElement>) {
  const { detail, clientX, clientY, screenX, screenY, ctrlKey, shiftKey, altKey, metaKey, button, buttons } = event;
  item.dispatchEvent(new globalThis.MouseEvent("click", { bubbles: true, cancelable: true, composed: true, view: window, detail, clientX, clientY, screenX, screenY, ctrlKey, shiftKey, altKey, metaKey, button, buttons }));
}

/** Whether an event happened inside the element whose handler hears it, not in a portalled child (a submenu, a tooltip). */
const isOwn = (event: { currentTarget: EventTarget; target: EventTarget }) =>
  !(event.currentTarget instanceof Node) || !(event.target instanceof Node) || event.currentTarget.contains(event.target);

export function useFluidHover<T extends HTMLElement>(container: RefObject<T | null>, options: FluidHoverOptions) {
  const { items: selector, axis = "y", isItemDisabled = defaultDisabled, disabled = "skip", gapClick = true, followFocus = true } = options;
  const [state, setState] = useState<FluidHoverState>({ rect: null, item: null, glide: false, session: 0 });
  const current = useRef(state);
  const pointer = useRef(false);
  const entering = useRef(false);
  const frame = useRef(0);

  function commit(next: FluidHoverState) {
    const prev = current.current;
    if (prev.item === next.item && prev.session === next.session && sameRect(prev.rect, next.rect)) return;
    current.current = next;
    setState(next);
  }

  function light(item: HTMLElement | null, glide: boolean) {
    const root = container.current;
    if (!root || !item) return commit({ ...current.current, rect: null, item: null, glide });
    let session = current.current.session;
    if (entering.current) { entering.current = false; session += 1; }
    commit({ rect: rectOf(item, root), item, glide: glide && session === current.current.session, session });
  }

  const enabledItems = () => {
    const root = container.current;
    return root ? [...root.querySelectorAll<HTMLElement>(selector)].filter(item => !isItemDisabled(item)) : [];
  };

  // The lit item can move under a still highlight (a resize, content above it changing): follow it without travel.
  const follow = useEffectEvent(() => { const { item } = current.current; if (item?.isConnected) light(item, false); });
  useEffect(() => {
    const root = container.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => follow());
    observer.observe(root);
    return () => observer.disconnect();
  }, [container]);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const handlers = {
    onMouseEnter: () => { entering.current = true; },
    onMouseMove: (event: MouseEvent<T>) => {
      if (!isOwn(event)) return;
      pointer.current = true;
      const { clientX, clientY } = event;
      cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(() => {
        const over = disabled === "clear" ? document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>(selector) : null;
        light(over && isItemDisabled(over) ? null : pickNearest(enabledItems(), clientX, clientY, axis), true);
      });
    },
    onMouseLeave: () => { cancelAnimationFrame(frame.current); entering.current = false; light(null, false); },
    onKeyDownCapture: () => { pointer.current = false; },
    onFocus: (event: FocusEvent<T>) => {
      if (!followFocus || pointer.current || !isOwn(event)) return;
      const item = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>(selector) : null;
      if (item && container.current?.contains(item) && !isItemDisabled(item)) light(item, false);
    },
    onBlur: (event: FocusEvent<T>) => {
      if (!pointer.current && !event.currentTarget.contains(event.relatedTarget as Node | null)) light(null, false);
    },
    onClick: (event: MouseEvent<T>) => {
      if (!gapClick || !isOwn(event)) return;
      const target = event.target as Element;
      if (!target.isConnected || target.closest(selector) || target.closest(CONTROL)) return;
      const { item } = current.current;
      if (item?.isConnected && !isItemDisabled(item)) forwardClick(item, event);
    },
  };

  /** Clears the highlight at once, such as when a menu opens again. */
  const reset = () => { cancelAnimationFrame(frame.current); entering.current = true; light(null, false); };

  return { ...state, handlers, reset, light };
}

export interface NearestItemOptions extends Omit<FluidHoverOptions, "followFocus"> {
  /** Called with the nearest enabled item as the mouse moves over the container. */
  onPick: (item: HTMLElement) => void;
}

/**
 * Fluid hover's picking without its highlight, for a list that already keeps its own active item and highlight (a listbox
 * with aria-activedescendant, a roving list): the mouse picks the nearest enabled item, gaps and padding included, and a
 * click in a gap goes to that item. Spread the result on the container.
 */
// A hook only so callbacks that touch refs can be passed during render; it keeps no state.
export function useNearestItem<T extends HTMLElement>({ items: selector, axis = "y", isItemDisabled = defaultDisabled, gapClick = true, onPick }: NearestItemOptions) {
  const nearest = (event: MouseEvent<T>) => {
    if (!isOwn(event)) return null;
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>(selector)].filter(item => !isItemDisabled(item));
    return pickNearest(items, event.clientX, event.clientY, axis);
  };
  return {
    onPointerMove: (event: PointerEvent<T>) => { if (event.pointerType !== "mouse") return; const item = nearest(event); if (item) onPick(item); },
    onClick: (event: MouseEvent<T>) => {
      if (!gapClick) return;
      const target = event.target as Element;
      if (!target.isConnected || target.closest(selector) || target.closest(CONTROL)) return;
      const item = nearest(event);
      if (item) forwardClick(item, event);
    },
  };
}

const sameRect = (a: FluidRect | null, b: FluidRect | null) =>
  a === b || (!!a && !!b && a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height);

export interface FluidHoverHighlightProps {
  /** The state from useFluidHover (or any { rect, glide, session }). */
  hover: Pick<FluidHoverState, "rect" | "glide" | "session">;
  /** Radius, fill, z-index. The container must be position: relative; the highlight is placed at its top-left corner. */
  className?: string;
  /** Extra attributes for styling, such as data-tone. */
  tone?: string;
}

/** The one highlight a fluid hover set renders: it springs between items on transforms, and fades in and out. */
export function FluidHoverHighlight({ hover, className, tone }: FluidHoverHighlightProps) {
  const reduced = useReducedMotion() ?? false;
  const { rect, glide, session } = hover;
  const place = rect ? { x: rect.left, y: rect.top, width: rect.width, height: rect.height } : undefined;
  return (
    <AnimatePresence initial={false}>
      {place ? (
        <motion.span key={session} className={className} data-tone={tone} aria-hidden="true"
          style={{ position: "absolute", top: 0, left: 0, pointerEvents: "none" }}
          initial={{ opacity: 0, ...place }}
          animate={{ opacity: 1, ...place }}
          exit={{ opacity: 0, transition: motionTokens.spring.fast.exit }}
          transition={{ default: glide && !reduced ? motionTokens.spring.fast : { duration: 0 }, opacity: { duration: motionTokens.duration.fast } }} />
      ) : null}
    </AnimatePresence>
  );
}
