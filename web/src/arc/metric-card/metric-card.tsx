import { Show } from "solid-js";
import { AnimatedCounter } from "../animated-counter/animated-counter";
import { SwapText } from "../lib/presence";
import { useSquircle } from "../lib/squircle";
import styles from "./metric-card.module.css";

export interface MetricCardProps {
  label: string;
  value: number;
  suffix?: string;
  prefix?: string;
  decimals?: number;
  /** One line of context under the number, for example "Signed in during the last 30 days". */
  context: string;
  /** A signed change such as "+12%" or "-3". Its sign decides the colour. */
  change?: string;
}

/** Arc MetricCard: a headline number that counts when it changes, a label, a context line and an optional change chip. */
export function MetricCard(props: MetricCardProps) {
  const trend = () => (props.change ? (/^[+]/.test(props.change) ? "up" : /^[-−]/.test(props.change) ? "down" : undefined) : undefined);
  return (
    <article ref={el => useSquircle(el)} class={styles.card}>
      <div class={styles.top}>
        <span class={styles.label}><SwapText text={props.label} as="span" class={styles.swapLine} /></span>
        <Show when={props.change}>
          <small ref={el => useSquircle(el)} class={styles.change} data-trend={trend()}><SwapText text={props.change ?? ""} /></small>
        </Show>
      </div>
      <AnimatedCounter value={props.value} suffix={props.suffix} prefix={props.prefix} decimals={props.decimals} animateOnView />
      <p class={styles.context}><SwapText text={props.context} class={styles.swapLine} /></p>
    </article>
  );
}

export default MetricCard;
