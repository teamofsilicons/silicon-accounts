import { For, Show, createEffect, createSignal, on, onCleanup, onMount, untrack } from "solid-js";
import { HeightFrame } from "../lib/HeightFrame";
import { createFlip } from "../lib/flip";
import { createPresenceList, type PresenceEntry } from "../lib/presence-list";
import { SwapText } from "../lib/presence";
import { animate, motionTokens, prefersReducedMotion, spring, tween } from "../lib/motion";
import { useSquircle } from "../lib/squircle";
import styles from "./chip-group.module.css";

export interface ChipOption {
  value: string;
  label: string;
}

export interface ChipGroupProps {
  options: ChipOption[];
  value: string[];
  onValueChange: (value: string[]) => void;
  /** Accessible name of the group, such as "Shared details". */
  label: string;
  /** Allow several chips at once. In single mode the selected chip can still be cleared. */
  multiple?: boolean;
  /** Chips shown before the rest fold behind a "+N more" chip. Selected chips stay in view. */
  maxVisible?: number;
  /** Values that cannot be toggled (for example a scope that is always shared). */
  locked?: string[];
  class?: string;
}

/** The width the check takes from the label: a 14px glyph and the space after it. */
const SLOT = 18;
const MORE = "\u0000more";

function Chip(props: { entry: PresenceEntry<ChipOption>; selected: boolean; locked: boolean; tabbable: boolean; delay: number; onToggle: (value: string) => void; onFocusChip: (value: string) => void; onGone: () => void }) {
  let button: HTMLButtonElement | undefined;
  let body: HTMLSpanElement | undefined;
  let surface: HTMLSpanElement | undefined;
  let check: HTMLSpanElement | undefined;
  let label: HTMLSpanElement | undefined;
  let path: SVGPathElement | undefined;
  let lag = 0;
  let width = 0;
  const paint = () => {
    const slot = props.selected ? SLOT : 0;
    const grown = Math.max(0, (slot + lag) / SLOT);
    if (surface) surface.style.right = `${-lag}px`;
    if (label) label.style.transform = lag ? `translateX(${lag}px)` : "";
    if (check) {
      check.style.transform = `scale(${Math.min(grown, 1.1)})`;
      check.style.opacity = String(Math.min(1, grown * 1.4));
      check.style.filter = grown >= 1 ? "none" : `blur(${((1 - grown) * motionTokens.blur.subtle).toFixed(2)}px)`;
    }
    if (path) path.style.strokeDashoffset = String(1 - Math.min(1, Math.max(0.001, grown)));
  };
  onMount(() => {
    width = body?.offsetWidth ?? 0;
    paint();
    if (props.entry.entering && button && !prefersReducedMotion()) {
      animate(button, { opacity: [0, 1], scale: [0.9, 1] }, { ...spring.snappy, delay: props.delay, opacity: { ...tween(motionTokens.duration.fast), delay: props.delay } });
    }
    const observer = new ResizeObserver(() => { if (!lag && body) width = body.offsetWidth; });
    if (body) observer.observe(body);
    onCleanup(() => observer.disconnect());
  });
  createEffect(on(() => props.selected, () => {
    if (!body) return;
    const previous = width;
    const next = body.offsetWidth;
    width = next;
    if (prefersReducedMotion() || previous === next) { lag = 0; paint(); return; }
    // The layout width changes in one frame; the visible edge trails it and springs back (Arc useWidthLag).
    lag = lag + previous - next;
    paint();
    animate(lag, 0, { ...spring.morph, onUpdate: value => { lag = value; paint(); } });
  }, { defer: true }));
  createEffect(on(props.entry.leaving, leaving => {
    if (!leaving || !button) return;
    if (prefersReducedMotion()) return props.onGone();
    animate(button, { opacity: 0, scale: 0.9 }, tween(motionTokens.duration.instant)).then(props.onGone);
  }, { defer: true }));
  return (
    <button
      ref={button}
      type="button"
      class={styles.chip}
      data-chip={props.entry.key}
      aria-pressed={props.selected}
      aria-disabled={props.locked || undefined}
      aria-hidden={props.entry.leaving() || undefined}
      tabIndex={!props.entry.leaving() && props.tabbable ? 0 : -1}
      onClick={() => { if (!props.locked) props.onToggle(props.entry.key); }}
      onFocus={() => props.onFocusChip(props.entry.key)}
    >
      <span ref={body} class={styles.body} data-selected={props.selected}>
        <span ref={el => { surface = el; useSquircle(el); }} class={styles.surface} aria-hidden="true" />
        <span ref={check} class={styles.check} aria-hidden="true">
          <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={2.5} stroke-linecap="round" stroke-linejoin="round">
            <path ref={path} d="M4 12.5 9.5 18 20 6.5" pathLength="1" style={{ "stroke-dasharray": "1" }} />
          </svg>
        </span>
        <span class={styles.slot} aria-hidden="true" />
        <span ref={label} class={styles.label}>{props.entry.item().label}</span>
      </span>
    </button>
  );
}

/**
 * Arc ChipGroup: selectable chips for facets people toggle often. Selecting morphs the chip (a check grows in, the label
 * slides over, the edge follows on a spring) while neighbours glide to their places, even across lines. Long sets fold
 * behind "+N more". Arrow keys move between chips; Space or Enter toggles.
 */
export function ChipGroup(props: ChipGroupProps) {
  let group: HTMLDivElement | undefined;
  const [expanded, setExpanded] = createSignal(false);
  const [pinned, setPinned] = createSignal<string[]>(untrack(() => props.value));
  const [active, setActive] = createSignal<string | null>(null);
  const max = () => props.maxVisible ?? Infinity;
  const foldable = () => props.options.length > max();
  const visible = () => (!foldable() || expanded()
    ? props.options
    : props.options.filter((option, index) => index < max() || pinned().includes(option.value) || props.value.includes(option.value)));
  const hidden = () => props.options.length - visible().length;
  const showMore = () => foldable() && (expanded() || hidden() > 0);
  const keys = () => [...visible().map(option => option.value), ...(showMore() ? [MORE] : [])];
  const tabStop = () => {
    const current = active();
    return current !== null && keys().includes(current) ? current : visible().find(option => props.value.includes(option.value))?.value ?? keys()[0];
  };
  const { entries, release } = createPresenceList(visible, option => option.value);
  const flip = createFlip(() => group, "[data-chip], [data-more]", el => el.getAttribute("data-chip") ?? (el.hasAttribute("data-more") ? MORE : null));
  createEffect(on(() => [props.value.join(","), expanded(), entries().length], () => flip.play(), { defer: true }));

  const toggle = (next: string) => {
    flip.capture();
    const on_ = props.value.includes(next);
    if (!(props.multiple ?? true)) return props.onValueChange(on_ ? [] : [next]);
    props.onValueChange(props.options.filter(option => (option.value === next ? !on_ : props.value.includes(option.value))).map(option => option.value));
  };
  const toggleMore = () => {
    flip.capture();
    if (expanded()) setPinned(props.value);
    setExpanded(!expanded());
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const buttons = Array.from(group?.querySelectorAll<HTMLButtonElement>(":is(button[data-chip], button[data-more]):not([aria-hidden='true'])") ?? []);
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    const last = buttons.length - 1;
    const moves: Record<string, number> = { ArrowRight: index === last ? 0 : index + 1, ArrowDown: index === last ? 0 : index + 1, ArrowLeft: index === 0 ? last : index - 1, ArrowUp: index === 0 ? last : index - 1, Home: 0, End: last };
    const target = moves[event.key];
    if (target === undefined) return;
    event.preventDefault();
    buttons[target]?.focus();
  };

  return (
    <HeightFrame morphKey={`${expanded()}|${props.value.join(",")}`} class={styles.frame}>
      <div ref={group} class={[styles.group, props.class ?? ""].join(" ")} role="group" aria-label={props.label} onKeyDown={onKeyDown}>
        <For each={entries()}>
          {(entry, index) => (
            <Chip
              entry={entry}
              selected={props.value.includes(entry.key)}
              locked={props.locked?.includes(entry.key) ?? false}
              tabbable={tabStop() === entry.key}
              delay={expanded() ? Math.min(Math.max(0, index() - max()) * motionTokens.stagger.item, 0.3) : 0}
              onToggle={toggle}
              onFocusChip={setActive}
              onGone={() => release(entry)}
            />
          )}
        </For>
        <Show when={showMore()}>
          <button type="button" class={`${styles.chip} ${styles.more}`} data-more="" aria-expanded={expanded()} tabIndex={tabStop() === MORE ? 0 : -1} onClick={toggleMore} onFocus={() => setActive(MORE)}>
            <span class={styles.body}>
              <span ref={el => useSquircle(el)} class={styles.surface} aria-hidden="true" />
              <span class={styles.moreText}><SwapText text={expanded() ? "Show less" : `+${hidden()} more`} class={styles.moreLine} /></span>
            </span>
          </button>
        </Show>
      </div>
    </HeightFrame>
  );
}

export default ChipGroup;
