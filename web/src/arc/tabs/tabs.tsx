import { Tabs as KTabs } from "@kobalte/core/tabs";
import { ChevronLeft, ChevronRight } from "lucide-solid";
import { Show, createContext, createEffect, createSignal, on, onCleanup, onMount, splitProps, untrack, useContext, type JSX } from "solid-js";
import { animate, createGlide, motionTokens, prefersReducedMotion, spring, tween } from "../lib/motion";
import { cx } from "../lib/cx";
import { useSquircle } from "../lib/squircle";
import styles from "./tabs.module.css";

interface TabsContextValue {
  active: () => string;
  /** +1 when the new tab sits after the old one. */
  direction: () => number;
  /** Height of the visible panel, so the next panel can morph from it. */
  panelHeight: { current: number | null };
}

const TabsContext = createContext<TabsContextValue>();
const useTabs = () => {
  const context = useContext(TabsContext);
  if (!context) throw new Error("Tabs parts must be rendered inside <Tabs>.");
  return context;
};

export interface TabsProps {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  /** "automatic" (default) activates a tab on focus; "manual" waits for Enter or Space. */
  activationMode?: "automatic" | "manual";
  class?: string;
  children: JSX.Element;
}

/**
 * Arc Tabs on Kobalte: one highlight glides between triggers on the morph spring; the next panel slides in from the
 * side the tab sits on while the outgoing one fades where it stood, and the panel height morphs between the two.
 */
export function Tabs(props: TabsProps) {
  const [internal, setInternal] = createSignal(untrack(() => props.defaultValue ?? ""));
  const [direction, setDirection] = createSignal(1);
  const active = () => props.value ?? internal();
  const panelHeight = { current: null as number | null };
  let root: HTMLDivElement | undefined;

  const handleChange = (next: string) => {
    const current = active();
    if (next === current) return;
    const triggers = root ? Array.from(root.querySelectorAll<HTMLElement>('[role="tab"][data-value]')).filter(tab => tab.closest("[data-arc-tabs]") === root) : [];
    const order = triggers.map(tab => tab.dataset.value);
    const from = order.indexOf(current);
    const to = order.indexOf(next);
    const dir = from >= 0 && to >= 0 && from !== to ? (to > from ? 1 : -1) : 1;
    setDirection(dir);
    // The outgoing panel pops out of flow where it stood and fades, while the next one takes its place.
    const leaving = root?.querySelector<HTMLElement>(':scope > [role="tabpanel"]');
    if (leaving && root && !prefersReducedMotion()) {
      const ghost = leaving.cloneNode(true) as HTMLElement;
      ghost.removeAttribute("id");
      ghost.setAttribute("aria-hidden", "true");
      ghost.setAttribute("inert", "");
      Object.assign(ghost.style, { position: "absolute", left: `${leaving.offsetLeft}px`, top: `${leaving.offsetTop}px`, width: `${leaving.offsetWidth}px`, margin: "0", pointerEvents: "none" });
      root.appendChild(ghost);
      animate(ghost, { opacity: 0, x: dir * -6 }, tween(motionTokens.duration.instant)).then(() => ghost.remove());
    }
    if (props.value === undefined) setInternal(next);
    props.onValueChange?.(next);
  };

  return (
    <TabsContext.Provider value={{ active, direction, panelHeight }}>
      <KTabs ref={root} data-arc-tabs="" class={cx(styles.root, props.class)} value={active()} onChange={handleChange} activationMode={props.activationMode}>
        {props.children}
      </KTabs>
    </TabsContext.Provider>
  );
}

export interface TabsListProps {
  "aria-label"?: string;
  class?: string;
  children: JSX.Element;
}

/** The trigger row. Scrolls sideways (with fading edges and arrow buttons) when the tabs outgrow the space. */
export function TabsList(props: TabsListProps) {
  const { active } = useTabs();
  let shell: HTMLDivElement | undefined;
  let viewport: HTMLDivElement | undefined;
  let list: HTMLDivElement | undefined;
  let highlight: HTMLSpanElement | undefined;
  const [edges, setEdges] = createSignal({ overflow: false, left: false, right: false });
  const glide = createGlide(() => highlight, spring.morph);
  const update = () => {
    if (!shell || !viewport) return;
    const max = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
    const next = { overflow: viewport.scrollWidth > shell.clientWidth + 1, left: viewport.scrollLeft > 1, right: viewport.scrollLeft < max - 1 };
    const previous = edges();
    if (previous.overflow !== next.overflow || previous.left !== next.left || previous.right !== next.right) setEdges(next);
  };
  const reveal = (tab: HTMLElement | null) => {
    if (!viewport || !tab) return;
    const frame = viewport.getBoundingClientRect();
    const item = tab.getBoundingClientRect();
    const max = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
    const left = frame.left + (viewport.scrollLeft > 1 ? 34 : 0);
    const right = frame.right - (viewport.scrollLeft < max - 1 ? 34 : 0);
    const delta = item.left < left ? item.left - left : item.right > right ? item.right - right : 0;
    if (delta) viewport.scrollBy({ left: delta, behavior: prefersReducedMotion() ? "instant" : "smooth" });
  };
  const activeTab = () => list?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') ?? null;
  let placed = false;
  createEffect(on(active, () => queueMicrotask(() => {
    const tab = activeTab();
    glide.moveTo(tab, placed);
    placed = !!tab;
    reveal(tab);
  })));
  onMount(() => {
    if (!shell || !viewport || !list) return;
    const observer = new ResizeObserver(() => { update(); glide.moveTo(activeTab(), false); });
    observer.observe(shell);
    observer.observe(list);
    viewport.addEventListener("scroll", update, { passive: true });
    update();
    onCleanup(() => { observer.disconnect(); viewport?.removeEventListener("scroll", update); });
  });
  const scrollTabs = (direction: number) => viewport?.scrollBy({ left: direction * (viewport.clientWidth * 0.75), behavior: prefersReducedMotion() ? "instant" : "smooth" });
  return (
    <div ref={el => { shell = el; useSquircle(el); }} class={styles.listShell} data-overflow={edges().overflow} data-left={edges().left} data-right={edges().right}>
      <Show when={edges().overflow}>
        <button type="button" class={cx(styles.scrollButton, styles.scrollLeft)} aria-label="Scroll tabs left" disabled={!edges().left} tabIndex={-1} onClick={() => scrollTabs(-1)}><ChevronLeft width={17} height={17} aria-hidden="true" /></button>
      </Show>
      <div ref={viewport} class={styles.viewport} onFocusIn={event => { const target = event.target as HTMLElement; if (target.getAttribute("role") === "tab") reveal(target); }}>
        <KTabs.List ref={list} class={cx(styles.list, props.class)} aria-label={props["aria-label"]}>
          <span ref={el => { highlight = el; useSquircle(el); }} class={styles.selection} aria-hidden="true" />
          {props.children}
        </KTabs.List>
      </div>
      <Show when={edges().overflow}>
        <button type="button" class={cx(styles.scrollButton, styles.scrollRight)} aria-label="Scroll tabs right" disabled={!edges().right} tabIndex={-1} onClick={() => scrollTabs(1)}><ChevronRight width={17} height={17} aria-hidden="true" /></button>
      </Show>
    </div>
  );
}

export interface TabsTriggerProps {
  value: string;
  disabled?: boolean;
  class?: string;
  children: JSX.Element;
}

export function TabsTrigger(props: TabsTriggerProps) {
  return (
    <KTabs.Trigger value={props.value} data-value={props.value} disabled={props.disabled} class={cx(styles.trigger, props.class)}>
      <span class={styles.triggerLabel}>{props.children}</span>
    </KTabs.Trigger>
  );
}

export interface TabsContentProps extends Omit<JSX.HTMLAttributes<HTMLDivElement>, "ref"> {
  value: string;
  /** Keep the panel mounted while hidden (no slide animation). */
  forceMount?: boolean;
  class?: string;
  children: JSX.Element;
}

/** A panel. It slides in from the side its tab sits on, and its height morphs from the previous panel's. */
export function TabsContent(props: TabsContentProps) {
  const [local, rest] = splitProps(props, ["value", "forceMount", "class", "children"]);
  const { direction, panelHeight } = useTabs();
  let mountedOnce = false;
  onMount(() => { mountedOnce = true; });
  const onPanel = (node: HTMLDivElement) => {
    if (local.forceMount) return;
    // Captured now: the first panel renders in place, later ones animate in.
    const animateIn = mountedOnce;
    const observer = new ResizeObserver(() => { if (!node.style.height) panelHeight.current = node.offsetHeight; });
    onCleanup(() => observer.disconnect());
    queueMicrotask(() => {
      if (!node.isConnected) return;
      const from = panelHeight.current;
      const to = node.offsetHeight;
      const release = () => { node.style.height = ""; node.style.overflow = ""; };
      if (animateIn && !prefersReducedMotion()) {
        animate(node, { opacity: [0, 1], x: [direction() * 8, 0] }, { x: spring.smooth, opacity: tween(motionTokens.duration.standard, motionTokens.ease.enter) });
        if (from !== null && Math.abs(from - to) > 1) {
          if (to > from) node.style.overflow = "clip";
          animate(node, { height: [`${from}px`, `${to}px`] }, { ...spring.smooth, onComplete: release });
        }
      } else if (animateIn) animate(node, { opacity: [0, 1] }, tween(motionTokens.duration.instant));
      panelHeight.current = to;
      observer.observe(node);
    });
  };
  return (
    <KTabs.Content {...rest} ref={onPanel} value={local.value} forceMount={local.forceMount} class={cx(styles.content, local.class)}>
      {local.children}
    </KTabs.Content>
  );
}

export default Tabs;
