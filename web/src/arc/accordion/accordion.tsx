import { Accordion as KAccordion } from "@kobalte/core/accordion";
import { ChevronDown } from "lucide-solid";
import { For, createEffect, createSignal, on, untrack, type JSX } from "solid-js";
import { animate, instant, motionTokens, prefersReducedMotion, spring, tween, type AnimationControls } from "../lib/motion";
import { cx } from "../lib/cx";
import styles from "./accordion.module.css";

export interface AccordionItem {
  /** Stable key; defaults to the index. */
  id?: string;
  title: JSX.Element;
  content: JSX.Element;
}

export interface AccordionProps {
  items: AccordionItem[];
  /** Index of the item open at first; -1 for none. Default 0. */
  defaultOpen?: number;
  /** Let several items stay open at once. */
  multiple?: boolean;
  /** "lg" suits page-level questions: titles at the large text size, answers at body size. */
  size?: "md" | "lg";
  class?: string;
}

/**
 * Arc Accordion on Kobalte. Height follows the content on a spring that never overshoots; the answer settles into
 * place with a brief focus pull; closed panels leave the accessibility tree once they finish collapsing.
 */
export function Accordion(props: AccordionProps) {
  const keyOf = (item: AccordionItem, index: number) => item.id ?? String(index);
  const first = untrack(() => {
    const index = props.defaultOpen ?? 0;
    const item = props.items[index];
    return item && index >= 0 ? [keyOf(item, index)] : [];
  });
  const [open, setOpen] = createSignal<string[]>(first);
  return (
    <KAccordion class={cx(styles.accordion, props.size === "lg" && styles.lg, props.class)} value={open()} onChange={setOpen} multiple={props.multiple} collapsible>
      <For each={props.items}>
        {(item, index) => {
          const key = () => keyOf(item, index());
          const isOpen = () => open().includes(key());
          let panel: HTMLDivElement | undefined;
          let inner: HTMLDivElement | undefined;
          let icon: HTMLSpanElement | undefined;
          let running: AnimationControls[] = [];
          const stop = () => { for (const controls of running) controls.stop(); running = []; };
          createEffect(on(isOpen, (now, before) => {
            if (!panel || !inner) return;
            const reduce = prefersReducedMotion() || before === undefined;
            stop();
            if (icon) running.push(animate(icon, { rotate: now ? 180 : 0 }, reduce ? instant : spring.snappy));
            if (now) {
              panel.style.visibility = "visible";
              const target = inner.offsetHeight;
              if (reduce) { Object.assign(panel.style, { height: "auto", opacity: "1" }); inner.style.transform = ""; inner.style.filter = ""; return; }
              const height = animate(panel, { height: [`${panel.offsetHeight}px`, `${target}px`], opacity: 1 }, { height: spring.smooth, opacity: tween(motionTokens.duration.standard, motionTokens.ease.enter) });
              height.then(() => { if (isOpen() && panel) panel.style.height = "auto"; });
              running.push(height, animate(inner, { y: [-6, 0], filter: [`blur(${motionTokens.blur.subtle}px)`, "blur(0px)"] }, { y: spring.smooth, filter: tween(motionTokens.duration.standard, motionTokens.ease.enter) }));
              return;
            }
            const hide = () => { if (!isOpen() && panel) panel.style.visibility = "hidden"; };
            if (reduce) { Object.assign(panel.style, { height: "0px", opacity: "0" }); hide(); return; }
            const height = animate(panel, { height: [`${panel.offsetHeight}px`, "0px"], opacity: 0 }, { height: spring.smooth, opacity: tween(motionTokens.duration.fast) });
            height.then(hide);
            running.push(height, animate(inner, { y: -6, filter: `blur(${motionTokens.blur.subtle}px)` }, tween(motionTokens.duration.fast)));
          }));
          return (
            <KAccordion.Item value={key()} class={styles.item} forceMount>
              <KAccordion.Header class={styles.header}>
                <KAccordion.Trigger class={styles.trigger}>
                  <span>{item.title}</span>
                  <span ref={icon} class={styles.icon}><ChevronDown width={17} height={17} aria-hidden="true" /></span>
                </KAccordion.Trigger>
              </KAccordion.Header>
              <KAccordion.Content
                ref={panel}
                class={styles.panel}
                style={untrack(() => (isOpen() ? { height: "auto", opacity: 1 } : { height: "0px", opacity: 0, visibility: "hidden" }))}
              >
                <div ref={inner} class={styles.panelInner}>{item.content}</div>
              </KAccordion.Content>
            </KAccordion.Item>
          );
        }}
      </For>
    </KAccordion>
  );
}

export default Accordion;
