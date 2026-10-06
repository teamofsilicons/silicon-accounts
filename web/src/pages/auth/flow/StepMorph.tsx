/**
 * The sign-in card's morph (the Arc sign-in block, without its chrome: BrandPanel is the card here). A new step slides
 * in from the side it comes from and unblurs while the old one leaves the other way; the card's height springs between
 * them. Reduced motion crossfades in place.
 */
import { createMemo, createSignal, on, createEffect, type JSX } from "solid-js";
import { HeightFrame } from "../../../arc/lib/HeightFrame";
import { Swap } from "../../../arc/lib/presence";
import { animate, motionTokens, prefersReducedMotion, spring, tween } from "../../../arc/lib/motion";
import styles from "./flow.module.css";

const enterEase = [...motionTokens.ease.enter] as [number, number, number, number];
const standardEase = [...motionTokens.ease.standard] as [number, number, number, number];

export interface StepMorphProps {
  /** The view to show; a new key morphs the card. */
  view: string;
  /** Keys in their usual order, to tell forward (from the right) from back (from the left). */
  order: readonly string[];
  children: (view: string) => JSX.Element;
}

export function StepMorph(props: StepMorphProps) {
  const [direction, setDirection] = createSignal(1);
  const rank = (view: string) => {
    const base = view.split(":")[0] ?? view;
    const index = props.order.indexOf(base);
    return index < 0 ? props.order.length : index + (view.includes(":") ? 0.5 : 0);
  };
  createEffect(on(() => props.view, (next, previous) => {
    if (previous !== undefined) setDirection(Math.sign(rank(next) - rank(previous)) || 1);
  }));
  const key = createMemo(() => props.view);
  return (
    <HeightFrame morphKey={key()} class={styles.morph} contentClass={styles.track}>
      <Swap
        value={key()}
        as="div"
        class={styles.step}
        enter={el => {
          if (prefersReducedMotion()) return animate(el, { opacity: [0, 1] }, tween(motionTokens.duration.instant));
          return animate(
            el,
            { opacity: [0, 1], x: [direction() * 28, 0], filter: [`blur(${motionTokens.blur.soft}px)`, "blur(0px)"] },
            { x: spring.smooth, opacity: { duration: motionTokens.duration.standard, ease: enterEase, delay: 0.05 }, filter: { duration: motionTokens.duration.standard, ease: enterEase } },
          );
        }}
        exit={el => {
          el.setAttribute("inert", "");
          if (prefersReducedMotion()) return animate(el, { opacity: 0 }, { duration: 0 });
          return animate(
            el,
            { opacity: 0, x: direction() * -20, filter: `blur(${motionTokens.blur.soft}px)` },
            { x: spring.smooth, opacity: { duration: motionTokens.duration.exit, ease: standardEase }, filter: { duration: motionTokens.duration.exit } },
          );
        }}
      >
        {view => props.children(view)}
      </Swap>
    </HeightFrame>
  );
}
