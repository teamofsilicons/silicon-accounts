import { createSignal, type JSX } from "solid-js";
import { Tooltip as K } from "@kobalte/core/tooltip";
import { SwapText } from "../lib/presence";
import { useSquircle } from "../lib/squircle";
import styles from "./tooltip.module.css";

/** Props the trigger must spread onto the real control: `{p => <Button {...p}>…</Button>}`. */
export type TooltipTriggerProps = JSX.HTMLAttributes<HTMLElement> & { ref?: (el: HTMLElement) => void };

export interface TooltipProps {
  content: JSX.Element | string;
  /** Renders the trigger: spread the given props (aria wiring, handlers, ref) onto the real control. */
  children: (props: TooltipTriggerProps) => JSX.Element;
  placement?: "top" | "bottom" | "left" | "right";
  /** Open only on keyboard focus (useful next to text). */
  triggerOnFocusOnly?: boolean;
  disabled?: boolean;
}

const DELAY = 250;
const SKIP_WINDOW = 300;
/* While any tooltip is open, and briefly after the last one closes, the next opens without delay or travel (Arc). */
let openCount = 0;
let coolTimer = 0;
const [warm, setWarm] = createSignal(false);

/**
 * Arc Tooltip (Kobalte): a one-line hint for an unfamiliar control. The first one waits, then rises a few pixels;
 * within the skip window the next one only fades. String content crossfades when it changes while open.
 */
export function Tooltip(props: TooltipProps) {
  const [instant, setInstant] = createSignal(false);
  return (
    <K
      openDelay={warm() ? 0 : DELAY}
      closeDelay={0}
      skipDelayDuration={SKIP_WINDOW}
      placement={props.placement ?? "top"}
      gutter={8}
      overflowPadding={12}
      triggerOnFocusOnly={props.triggerOnFocusOnly}
      disabled={props.disabled}
      onOpenChange={open => {
        if (open) {
          setInstant(warm());
          openCount += 1;
          window.clearTimeout(coolTimer);
          setWarm(true);
        } else {
          openCount = Math.max(0, openCount - 1);
          if (openCount) return;
          window.clearTimeout(coolTimer);
          coolTimer = window.setTimeout(() => setWarm(false), SKIP_WINDOW);
        }
      }}
    >
      <K.Trigger as={(triggerProps: TooltipTriggerProps) => props.children(triggerProps)} />
      <K.Portal>
        <K.Content ref={(el: HTMLDivElement) => useSquircle(el)} class={styles.tooltip} data-instant={instant() || undefined} data-side={props.placement ?? "top"}>
          {typeof props.content === "string" ? <span class={styles.text}><SwapText text={props.content} class={styles.line} /></span> : props.content}
        </K.Content>
      </K.Portal>
    </K>
  );
}

export default Tooltip;
