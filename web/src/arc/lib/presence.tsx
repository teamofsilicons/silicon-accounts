/**
 * Solid replacements for the AnimatePresence patterns Arc uses: animate a child in when it mounts and out before it
 * unmounts (<Presence>), crossfade keyed content where the outgoing copy pops out of flow (<Swap>, Arc's
 * mode="popLayout"), morph text letter by letter or word by word (<MorphText>), springs that follow content width
 * (createMorphWidth), and height reveals for messages (<Reveal>).
 */
import {
  For,
  Show,
  createEffect,
  createSignal,
  on,
  onCleanup,
  onMount,
  untrack,
  type Accessor,
  type JSX,
  type Setter,
} from "solid-js";
import { animate, instant, motionTokens, prefersReducedMotion, presets, spring, tween, type AnimationControls } from "./motion";

type Animator = (el: HTMLElement) => AnimationControls | void;

/* ------------------------------------------------------------------------------------------------------------------ */
/* Presence                                                                                                            */
/* ------------------------------------------------------------------------------------------------------------------ */

export interface PresenceProps {
  when: boolean;
  /** Runs when the child mounts (skipped for the first render when `initial` is false). */
  enter?: Animator;
  /** Runs before the child unmounts; the child stays mounted until it finishes. */
  exit?: Animator;
  /** Animate the very first mount. Defaults to false, like Arc's `initial={false}`. */
  initial?: boolean;
  children: (ref: (el: HTMLElement) => void) => JSX.Element;
}

/** Mounts `children` while `when` is true and keeps it mounted until its exit animation completes. */
export function Presence(props: PresenceProps) {
  const [mounted, setMounted] = createSignal(untrack(() => props.when));
  let el: HTMLElement | undefined;
  let exiting: AnimationControls | undefined;
  let first = true;
  const ref = (node: HTMLElement) => {
    el = node;
    const animateIn = !first || props.initial;
    first = false;
    if (animateIn && props.enter) queueMicrotask(() => node.isConnected && props.enter?.(node));
  };
  createEffect(on(() => props.when, when => {
    if (when) {
      if (exiting) {
        exiting.stop();
        exiting = undefined;
        if (el) props.enter?.(el);
      }
      setMounted(true);
      return;
    }
    if (!untrack(mounted)) return;
    const node = el;
    const controls = node && props.exit ? props.exit(node) : undefined;
    if (!controls) {
      setMounted(false);
      return;
    }
    exiting = controls;
    controls.then(() => {
      if (exiting !== controls) return;
      exiting = undefined;
      if (!props.when) setMounted(false);
    });
  }, { defer: true }));
  return <Show when={mounted()}>{props.children(ref)}</Show>;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Swap: keyed crossfade with pop layout                                                                               */
/* ------------------------------------------------------------------------------------------------------------------ */

interface SwapItem<T> {
  id: number;
  value: Accessor<T>;
  setValue: Setter<T>;
  el?: HTMLElement;
  leaving: Accessor<boolean>;
  setLeaving: Setter<boolean>;
}

export interface SwapProps<T> {
  value: T;
  /** Optional key; defaults to the value itself. A new key swaps the content. */
  keyOf?: (value: T) => unknown;
  enter?: (el: HTMLElement, value: T) => AnimationControls | void;
  exit?: (el: HTMLElement, value: T) => AnimationControls | void;
  /** Wrapper element for each phase. Defaults to span. */
  as?: "span" | "div";
  class?: string;
  /** Pop the outgoing element out of flow so the incoming one takes its place at once. Default true. */
  popLayout?: boolean;
  children: (value: T) => JSX.Element;
}

let swapSeq = 0;

/**
 * Crossfades content when its key changes. The outgoing copy is popped out of flow (absolutely positioned where it
 * stood) and animates out while the incoming copy animates in. The parent should be `position: relative`.
 */
export function Swap<T>(props: SwapProps<T>) {
  const keyOf = (value: T) => (props.keyOf ? props.keyOf(value) : value);
  const make = (initial: T): SwapItem<T> => {
    const [leaving, setLeaving] = createSignal(false);
    const [value, setValue] = createSignal<T>(initial);
    return { id: ++swapSeq, value, setValue, leaving, setLeaving };
  };
  const [items, setItems] = createSignal<SwapItem<T>[]>([make(untrack(() => props.value))]);
  let mountedOnce = false;
  onMount(() => { mountedOnce = true; });

  createEffect(on(() => keyOf(props.value), (key, previous) => {
    if (key === previous) {
      // Same key, new value: update in place without animating.
      const value = props.value;
      for (const item of untrack(items)) if (!item.leaving()) item.setValue(() => value);
      return;
    }
    const current = untrack(items).filter(item => !item.leaving());
    for (const item of current) {
      const node = item.el;
      if (node && props.popLayout !== false) {
        const left = node.offsetLeft;
        const top = node.offsetTop;
        const width = node.offsetWidth;
        Object.assign(node.style, { position: "absolute", left: `${left}px`, top: `${top}px`, width: `${width}px`, pointerEvents: "none" });
        node.setAttribute("aria-hidden", "true");
      }
      item.setLeaving(true);
      const controls = node ? props.exit?.(node, item.value()) : undefined;
      const remove = () => setItems(list => list.filter(entry => entry !== item));
      if (controls) controls.then(remove);
      else remove();
    }
    setItems(list => [...list, make(props.value)]);
  }, { defer: true }));

  const Tag = () => props.as ?? "span";
  return (
    <For each={items()}>
      {item => {
        const ref = (node: HTMLElement) => {
          item.el = node;
          if (mountedOnce) queueMicrotask(() => node.isConnected && !item.leaving() && props.enter?.(node, item.value()));
        };
        return Tag() === "div"
          ? <div ref={ref} class={props.class} data-swap-phase="">{props.children(item.value())}</div>
          : <span ref={ref} class={props.class} data-swap-phase="">{props.children(item.value())}</span>;
      }}
    </For>
  );
}

/** Text that rises in from a soft blur and lifts away (dialog titles, select values, tooltips, trigger labels). */
export function SwapText(props: { text: string; class?: string; as?: "span" | "div" }) {
  return (
    <Swap value={props.text} class={props.class} as={props.as} enter={el => presets.textIn(el)} exit={el => presets.textOut(el)}>
      {text => text}
    </Swap>
  );
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* MorphText: letters (or words) that keep their identity                                                              */
/* ------------------------------------------------------------------------------------------------------------------ */

interface Token {
  id: string;
  text: string;
  order: number;
  leaving: boolean;
}

function tokenize(text: string, by: "char" | "word"): string[] {
  if (by === "char") return [...text];
  const parts = text.split(" ");
  return parts.map((part, index) => (index < parts.length - 1 ? `${part} ` : part));
}

/** Shared leading and trailing tokens keep their identity, so only the changed run is replaced (Arc useGlyphs). */
function diffEdges(previous: Token[], prevText: string[], next: string[], seq: number, minRun: number): Token[] {
  let start = 0;
  let end = 0;
  while (start < prevText.length && start < next.length && prevText[start] === next[start]) start++;
  while (end < prevText.length - start && end < next.length - start && prevText[prevText.length - 1 - end] === next[next.length - 1 - end]) end++;
  if (start < minRun) start = 0;
  if (end < minRun) end = 0;
  const middle = next.slice(start, next.length - end).map((text, index) => ({ id: `${seq}:${index}`, text, order: index, leaving: false }));
  return [...previous.slice(0, start), ...middle, ...previous.slice(previous.length - end)];
}

/** Letters match by character and occurrence, so the second "i" pairs with the second "i" (Arc TextMorph). */
function diffOccurrence(previous: Token[], next: string[]): Token[] {
  const byId = new Map(previous.map(token => [token.id, token]));
  const seen = new Map<string, number>();
  let entering = 0;
  return next.map(text => {
    const count = seen.get(text) ?? 0;
    seen.set(text, count + 1);
    const id = `${text}-${count}`;
    return byId.get(id) ?? { id, text, order: entering++, leaving: false };
  });
}

export interface MorphTextProps {
  text: string;
  /** Morph letter by letter (labels) or word by word (sentences). Default "char". */
  by?: "char" | "word";
  /** "edges" keeps the shared start and end (labels like Copy/Copied); "occurrence" pairs letters by character. */
  keys?: "edges" | "occurrence";
  /** "label": letters rise from a soft blur. "morph": letters also scale up a touch (Arc TextMorph). */
  variant?: "label" | "morph";
  class?: string;
  /** Per-token class. */
  tokenClass?: string;
}

const EASE_ENTER = [...motionTokens.ease.enter] as [number, number, number, number];
const EASE_STANDARD = [...motionTokens.ease.standard] as [number, number, number, number];

/**
 * Morphs one label into the next: kept letters glide into place, new ones rise in from a soft blur, removed ones pop
 * out of flow and lift away. The element is aria-hidden: render the plain text in a visually hidden sibling.
 */
export function MorphText(props: MorphTextProps) {
  const by = () => props.by ?? "char";
  let seq = 0;
  const initialText = tokenize(untrack(() => props.text), untrack(by));
  const seed = untrack(() => props.keys) === "occurrence"
    ? diffOccurrence([], initialText)
    : initialText.map((text, index) => ({ id: `0:${index}`, text, order: index, leaving: false }));
  const [tokens, setTokens] = createSignal<Token[]>(seed);
  let previousText = initialText;
  const nodes = new Map<Token, HTMLSpanElement>();

  createEffect(on(() => props.text, text => {
    const next = tokenize(text, by());
    const all = untrack(tokens);
    const live = all.filter(token => !token.leaving);
    const before = new Map<Token, number>();
    for (const token of live) {
      const node = nodes.get(token);
      if (node) before.set(token, node.offsetLeft);
    }
    const updated = props.keys === "occurrence"
      ? diffOccurrence(live, next)
      : diffEdges(live, previousText, next, ++seq, by() === "char" ? 2 : 1);
    previousText = next;
    const keep = new Set(updated);
    const gone = live.filter(token => !keep.has(token));
    // Pop removed tokens out of flow where they stood; they leave once the new layout is in place.
    for (const token of gone) {
      const node = nodes.get(token);
      token.leaving = true;
      if (!node) continue;
      Object.assign(node.style, { position: "absolute", left: `${node.offsetLeft}px`, top: `${node.offsetTop}px` });
    }
    setTokens([...updated, ...all.filter(token => token.leaving)]);
    const morph = props.variant === "morph";
    queueMicrotask(() => {
      const reduce = prefersReducedMotion();
      for (const token of gone) {
        const node = nodes.get(token);
        const done = () => {
          nodes.delete(token);
          setTokens(list => list.filter(entry => entry !== token));
        };
        if (!node) { done(); continue; }
        const controls = reduce
          ? animate(node, { opacity: 0 }, instant)
          : animate(
            node,
            morph
              ? { opacity: 0, scale: 0.86, y: "-0.1em", filter: `blur(${motionTokens.blur.soft}px)` }
              : { opacity: 0, y: "-0.25em", filter: `blur(${motionTokens.blur.soft}px)` },
            { duration: morph ? motionTokens.duration.exit : 0.2, ease: EASE_STANDARD },
          );
        controls.then(done);
      }
      let entering = 0;
      for (const token of updated) {
        const node = nodes.get(token);
        if (!node) continue;
        const old = before.get(token);
        if (old === undefined) {
          const order = entering++;
          if (reduce) animate(node, { opacity: [0, 1] }, tween(motionTokens.duration.instant));
          else if (morph) animate(
            node,
            { opacity: [0, 1], scale: [0.8, 1], y: ["0.14em", "0em"], filter: [`blur(${motionTokens.blur.soft}px)`, "blur(0px)"] },
            { duration: motionTokens.duration.standard + 0.04, ease: EASE_ENTER, delay: 0.05 + Math.min(order, 8) * motionTokens.stagger.char * 2 },
          );
          else animate(
            node,
            { opacity: [0, 1], y: ["0.25em", "0em"], filter: [`blur(${motionTokens.blur.soft}px)`, "blur(0px)"] },
            { duration: 0.36, ease: EASE_ENTER, delay: Math.min(order * 0.02, 0.12) },
          );
        } else if (!reduce) {
          const delta = old - node.offsetLeft;
          if (Math.abs(delta) > 0.5) animate(node, { x: [delta, 0] }, morph ? spring.morph : { type: "spring", visualDuration: 0.5, bounce: 0.06 });
        }
      }
    });
  }, { defer: true }));

  onCleanup(() => nodes.clear());

  return (
    <span class={props.class} style={{ position: "relative", display: "inline-flex", "white-space": "pre" }} aria-hidden="true">
      <For each={tokens()}>
        {token => (
          <span ref={node => nodes.set(token, node)} class={props.tokenClass} style={{ display: "inline-block", "white-space": "pre", "transform-origin": "50% 60%" }}>
            {token.text === " " ? "\u00a0" : token.text}
          </span>
        )}
      </For>
    </span>
  );
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Width that follows content                                                                                          */
/* ------------------------------------------------------------------------------------------------------------------ */

/**
 * Springs `slot`'s width to the natural width of `content` for 700ms after `key` changes, so a new label never
 * snaps the layout. Other resizes (a late web font, a parent reflow) jump, so nothing wobbles on first paint.
 */
export function createMorphWidth(slot: () => HTMLElement | undefined, content: () => HTMLElement | undefined, key: Accessor<string>) {
  let armedUntil = 0;
  let measured = false;
  createEffect(on(key, () => { armedUntil = performance.now() + 700; }, { defer: true }));
  onMount(() => {
    const node = content();
    const target = slot();
    if (!node || !target || typeof ResizeObserver === "undefined") return;
    let controls: AnimationControls | undefined;
    const observer = new ResizeObserver(([entry]) => {
      const next = entry?.contentRect.width ?? 0;
      if (!next || !measured || prefersReducedMotion() || performance.now() > armedUntil) {
        measured = next > 0;
        controls?.stop();
        target.style.width = next ? `${next}px` : "";
        delete target.dataset.morphing;
        return;
      }
      target.dataset.morphing = "";
      controls?.stop();
      controls = animate(target, { width: `${next}px` }, spring.morph);
      controls.then(() => { delete target.dataset.morphing; });
    });
    observer.observe(node);
    onCleanup(() => observer.disconnect());
  });
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Reveal: height + opacity for messages that come and go                                                              */
/* ------------------------------------------------------------------------------------------------------------------ */

/** Opens a row's height on a spring (no overshoot) and fades it in; closes faster. Arc's FieldMessage motion. */
export function Reveal(props: { when: boolean; class?: string; children: JSX.Element; initial?: boolean }) {
  return (
    <Presence
      when={props.when}
      initial={props.initial}
      enter={el => {
        if (prefersReducedMotion()) return;
        const height = el.scrollHeight;
        const controls = animate(el, { height: [0, height], opacity: [0, 1] }, { ...spring.smooth, opacity: tween(motionTokens.duration.fast) });
        controls.then(() => { el.style.height = ""; });
        return controls;
      }}
      exit={el => {
        if (prefersReducedMotion()) return;
        return animate(el, { height: [el.offsetHeight, 0], opacity: 0 }, { ...spring.smooth, opacity: tween(motionTokens.duration.instant) });
      }}
    >
      {ref => <div ref={ref} class={props.class} style={{ overflow: "hidden" }}>{props.children}</div>}
    </Presence>
  );
}
