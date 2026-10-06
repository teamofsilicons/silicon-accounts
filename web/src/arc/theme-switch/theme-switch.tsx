import { Show, onCleanup, onMount } from "solid-js";
import { Moon, Sun } from "lucide-solid";
import { Button, type ButtonSize } from "../button/button";
import { Swap } from "../lib/presence";
import { animate, motionTokens, prefersReducedMotion, spring, tween } from "../lib/motion";
import { cx } from "../lib/cx";
import { changeTheme } from "../../theme/theme-transition";
import type { Theme } from "../../theme/theme";
import styles from "./theme-switch.module.css";

/** "eclipse" (the account site's choice) sweeps the next theme across the page as a disc travelling from the switch. */
export type ThemeSwitchVariant = "eclipse" | "instant";

export interface ThemeSwitchProps {
  theme: Theme;
  variant?: ThemeSwitchVariant;
  /** Defaults to the site theme manager: changeTheme(next, trigger) with the eclipse sweep. */
  onThemeChange?: (next: Theme, trigger: HTMLElement) => void;
  label?: string;
  iconOnly?: boolean;
  size?: ButtonSize;
  class?: string;
}

const blur = `blur(${motionTokens.blur.subtle}px)`;

/**
 * Arc ThemeSwitch (eclipse variant). Both icons turn the same way (clockwise into dark, back out of it), so the swap
 * reads as one rotation rather than two fades. A theme that arrives in the first painted frames swaps in place.
 */
export function ThemeSwitch(props: ThemeSwitchProps) {
  let settled = false;
  onMount(() => {
    let second = 0;
    const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => { settled = true; }); });
    onCleanup(() => { cancelAnimationFrame(first); cancelAnimationFrame(second); });
  });
  const next = (): Theme => (props.theme === "light" ? "dark" : "light");
  const angle = (value: Theme) => (value === "light" ? 30 : -30);
  const variant = () => props.variant ?? "eclipse";

  return (
    <Button
      type="button"
      size={props.size ?? "sm"}
      variant="secondary"
      class={cx(styles.themeSwitch, styles[variant()], props.iconOnly && styles.iconOnly, props.class)}
      data-theme-state={props.theme}
      aria-label={props.label ?? `Switch to ${next()} mode`}
      aria-pressed={props.theme === "dark"}
      onClick={event => {
        const trigger = event.currentTarget;
        if (props.onThemeChange) props.onThemeChange(next(), trigger);
        else if (variant() === "eclipse") changeTheme(next(), trigger);
        else changeTheme(next(), null);
      }}
    >
      <span class={styles.iconWrap} aria-hidden="true">
        <Swap
          value={props.theme}
          class={styles.icon}
          enter={(el, value) => {
            if (!settled) return;
            if (prefersReducedMotion()) return animate(el, { opacity: [0, 1] }, tween(motionTokens.duration.instant));
            return animate(
              el,
              { opacity: [0, 1], scale: [0.7, 1], rotate: [angle(value), 0], filter: [blur, "blur(0px)"] },
              { ...spring.snappy, opacity: tween(motionTokens.duration.fast, motionTokens.ease.enter), filter: tween(motionTokens.duration.fast, motionTokens.ease.enter) },
            );
          }}
          exit={(el, value) => {
            if (!settled) return animate(el, { opacity: 0 }, { duration: 0 });
            if (prefersReducedMotion()) return animate(el, { opacity: 0 }, tween(motionTokens.duration.instant));
            return animate(el, { opacity: 0, scale: 0.7, rotate: angle(value), filter: blur }, tween(motionTokens.duration.fast));
          }}
        >
          {value => (value === "light" ? <Sun width={16} height={16} stroke-width={1.75} /> : <Moon width={16} height={16} stroke-width={1.75} />)}
        </Swap>
      </span>
      <Show when={!props.iconOnly}><span class={styles.label}>Switch theme</span></Show>
    </Button>
  );
}

export default ThemeSwitch;
