import { Show, onCleanup, onMount, splitProps, type JSX } from "solid-js";
import { cx } from "../lib/cx";
import { prefersReducedMotion } from "../lib/motion";
import styles from "./scroll-area.module.css";

type Axis = "y" | "x";

/** Which edges still have content beyond them. */
export interface ScrollAreaEdges { top: boolean; bottom: boolean; left: boolean; right: boolean }

export interface ScrollAreaProps extends Omit<JSX.HTMLAttributes<HTMLDivElement>, "onScroll" | "ref"> {
  children?: JSX.Element;
  /** Axes that scroll. Defaults to vertical. */
  orientation?: "vertical" | "horizontal" | "both";
  /** Length of the edge fade in px. 0 turns the fades off. */
  fade?: number;
  /** "auto" shows scrollbars while scrolling or hovering; "always" keeps them visible when content overflows. */
  scrollbars?: "auto" | "always";
  /** How long scrollbars linger after scrolling stops, in ms. */
  hideDelay?: number;
  /** Maximum height of the viewport, for vertical areas that grow with their content. */
  maxHeight?: string;
  /** Passed to the viewport's scroll-snap-type, for example "x mandatory". */
  snap?: string;
  /** Accessible name. The viewport becomes a labelled, focusable region that arrow and page keys scroll. */
  label?: string;
  /** Turns vertical wheel movement into horizontal scrolling for horizontal areas. Defaults to true. */
  wheelToHorizontal?: boolean;
  viewportClass?: string;
  viewportStyle?: JSX.CSSProperties;
  ref?: (el: HTMLDivElement) => void;
  viewportRef?: (el: HTMLDivElement) => void;
  onScroll?: (event: Event) => void;
  /** Called when content starts or stops extending past an edge. */
  onEdgeChange?: (edges: ScrollAreaEdges) => void;
}

const MIN_THUMB = 28;

/**
 * Arc ScrollArea: a native scroll container with thin overlay scrollbars that appear while scrolling or on hover and
 * fade away at rest. Each edge fades only when there is more content beyond it, in proportion to how much. Scrolling
 * stays native, so keyboard, touch momentum and scroll snap behave as the platform expects.
 */
export function ScrollArea(props: ScrollAreaProps) {
  const [local, rest] = splitProps(props, [
    "children", "orientation", "fade", "scrollbars", "hideDelay", "maxHeight", "snap", "label", "wheelToHorizontal",
    "viewportClass", "viewportStyle", "ref", "viewportRef", "onScroll", "onEdgeChange", "class",
  ]);
  const orientation = () => local.orientation ?? "vertical";
  const fade = () => local.fade ?? 28;
  const vertical = () => orientation() !== "horizontal";
  const horizontal = () => orientation() !== "vertical";
  let root: HTMLDivElement | undefined;
  let viewport: HTMLDivElement | undefined;
  const tracks: Record<Axis, HTMLDivElement | undefined> = { x: undefined, y: undefined };
  const thumbs: Record<Axis, HTMLDivElement | undefined> = { x: undefined, y: undefined };
  let hideTimer: number | undefined;
  let lastEdges = "";

  // Everything visual is written straight to the DOM on each scroll frame, so scrolling never re-renders.
  const sync = () => {
    const node = viewport;
    if (!node || !root) return;
    const { scrollTop, scrollLeft, scrollHeight, scrollWidth, clientHeight, clientWidth } = node;
    const maxY = Math.max(0, scrollHeight - clientHeight);
    const maxX = Math.max(0, scrollWidth - clientWidth);
    const left = Math.abs(scrollLeft);
    const edges: ScrollAreaEdges = { top: vertical() && scrollTop > 0.5, bottom: vertical() && maxY - scrollTop > 0.5, left: horizontal() && left > 0.5, right: horizontal() && maxX - left > 0.5 };
    if (fade() > 0) {
      node.style.setProperty("--fade-top", `${vertical() ? Math.min(fade(), scrollTop) : 0}px`);
      node.style.setProperty("--fade-bottom", `${vertical() ? Math.min(fade(), maxY - scrollTop) : 0}px`);
      node.style.setProperty("--fade-left", `${horizontal() ? Math.min(fade(), left) : 0}px`);
      node.style.setProperty("--fade-right", `${horizontal() ? Math.min(fade(), maxX - left) : 0}px`);
    }
    const place = (axis: Axis, scroll: number, max: number, client: number, total: number) => {
      const track = tracks[axis];
      const thumb = thumbs[axis];
      if (!track || !thumb) return;
      const overflowing = max > 0.5;
      track.toggleAttribute("data-hidden", !overflowing);
      if (!overflowing) return;
      const length = axis === "y" ? track.clientHeight : track.clientWidth;
      const size = Math.max(MIN_THUMB, (length * client) / total);
      const offset = (length - size) * (scroll / max);
      thumb.style[axis === "y" ? "height" : "width"] = `${size}px`;
      thumb.style.transform = axis === "y" ? `translate3d(0, ${offset}px, 0)` : `translate3d(${offset}px, 0, 0)`;
    };
    if (vertical()) place("y", scrollTop, maxY, clientHeight, scrollHeight);
    if (horizontal()) place("x", left, maxX, clientWidth, scrollWidth);
    root.toggleAttribute("data-overflow", maxY > 0.5 || maxX > 0.5);
    const key = `${edges.top}${edges.bottom}${edges.left}${edges.right}`;
    if (key !== lastEdges) { lastEdges = key; local.onEdgeChange?.(edges); }
  };

  onMount(() => {
    const node = viewport;
    if (!node) return;
    sync();
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(() => sync());
      const watch = () => { observer.disconnect(); observer.observe(node); Array.from(node.children).forEach(child => observer.observe(child)); };
      watch();
      const mutations = new MutationObserver(() => { watch(); sync(); });
      mutations.observe(node, { childList: true });
      onCleanup(() => { observer.disconnect(); mutations.disconnect(); });
    }
    // A mouse wheel over a horizontal strip moves it sideways while there is room, so the page still scrolls at the ends.
    if (orientation() === "horizontal" && local.wheelToHorizontal !== false) {
      const wheel = (event: WheelEvent) => {
        if (event.ctrlKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
        const max = node.scrollWidth - node.clientWidth;
        const at = Math.abs(node.scrollLeft);
        if (max <= 0 || (event.deltaY < 0 && at <= 0) || (event.deltaY > 0 && at >= max - 0.5)) return;
        event.preventDefault();
        node.scrollLeft += event.deltaY * (getComputedStyle(node).direction === "rtl" ? -1 : 1);
      };
      node.addEventListener("wheel", wheel, { passive: false });
      onCleanup(() => node.removeEventListener("wheel", wheel));
    }
  });
  onCleanup(() => window.clearTimeout(hideTimer));

  const wake = () => {
    if (!root) return;
    root.setAttribute("data-scrolling", "");
    window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => root?.removeAttribute("data-scrolling"), local.hideDelay ?? 900);
  };

  // Dragging a thumb maps pointer travel to scroll distance; pressing the track pages toward the pointer.
  let drag: { axis: Axis; start: number; scroll: number; ratio: number } | null = null;
  const onThumbDown = (event: PointerEvent, axis: Axis) => {
    const node = viewport;
    const track = tracks[axis];
    const thumb = thumbs[axis];
    if (!node || !track || !thumb || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    const length = axis === "y" ? track.clientHeight : track.clientWidth;
    const size = axis === "y" ? thumb.offsetHeight : thumb.offsetWidth;
    const max = axis === "y" ? node.scrollHeight - node.clientHeight : node.scrollWidth - node.clientWidth;
    drag = { axis, start: axis === "y" ? event.clientY : event.clientX, scroll: axis === "y" ? node.scrollTop : node.scrollLeft, ratio: max / Math.max(1, length - size) };
    root?.setAttribute("data-dragging", axis);
    node.style.scrollSnapType = "none";
  };
  const onThumbMove = (event: PointerEvent) => {
    const state = drag;
    const node = viewport;
    if (!state || !node) return;
    const delta = ((state.axis === "y" ? event.clientY : event.clientX) - state.start) * state.ratio;
    if (state.axis === "y") node.scrollTop = state.scroll + delta;
    else node.scrollLeft = state.scroll + delta;
  };
  const onThumbUp = (event: PointerEvent) => {
    if (!drag) return;
    drag = null;
    const target = event.currentTarget as HTMLElement;
    if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
    root?.removeAttribute("data-dragging");
    if (viewport) viewport.style.scrollSnapType = "";
    wake();
  };
  const onTrackDown = (event: PointerEvent, axis: Axis) => {
    const node = viewport;
    const thumb = thumbs[axis];
    if (!node || !thumb || event.button !== 0 || event.target !== event.currentTarget) return;
    const rect = thumb.getBoundingClientRect();
    const before = axis === "y" ? event.clientY < rect.top : event.clientX < rect.left;
    const page = (axis === "y" ? node.clientHeight : node.clientWidth) * 0.9 * (before ? -1 : 1);
    node.scrollBy({ [axis === "y" ? "top" : "left"]: page, behavior: prefersReducedMotion() ? "auto" : "smooth" });
  };

  const bar = (axis: Axis) => (
    <div ref={node => { tracks[axis] = node; }} class={styles.track} data-axis={axis} data-hidden="" aria-hidden="true" onPointerDown={event => onTrackDown(event, axis)}>
      <div ref={node => { thumbs[axis] = node; }} class={styles.thumb} onPointerDown={event => onThumbDown(event, axis)} onPointerMove={onThumbMove} onPointerUp={onThumbUp} onPointerCancel={onThumbUp} />
    </div>
  );

  return (
    <div {...rest} ref={el => { root = el; local.ref?.(el); }} class={cx(styles.root, local.class)} data-orientation={orientation()} data-scrollbars={local.scrollbars ?? "auto"}>
      <div
        ref={el => { viewport = el; local.viewportRef?.(el); }}
        class={cx(styles.viewport, local.viewportClass)}
        data-fade={fade() > 0 ? orientation() : undefined}
        style={{ "max-height": local.maxHeight, "scroll-snap-type": local.snap, ...local.viewportStyle }}
        tabIndex={0}
        role={local.label ? "region" : undefined}
        aria-label={local.label}
        onScroll={event => { sync(); wake(); local.onScroll?.(event); }}
      >
        {local.children}
      </div>
      <Show when={vertical()}>{bar("y")}</Show>
      <Show when={horizontal()}>{bar("x")}</Show>
    </div>
  );
}

export default ScrollArea;
