import { For, Show, createSignal, onCleanup, type JSX } from "solid-js";
import { DropdownMenu as K } from "@kobalte/core/dropdown-menu";
import { ChevronDown } from "lucide-solid";
import { SwapText } from "../lib/presence";
import { animate, prefersReducedMotion, spring } from "../lib/motion";
import { useSquircle } from "../lib/squircle";
import styles from "./dropdown-menu.module.css";

export interface DropdownItem {
  label: string;
  onSelect?: () => void;
  disabled?: boolean;
  icon?: JSX.Element;
  /** A keyboard hint such as ["⌘", "K"]. */
  keys?: string[];
  destructive?: boolean;
  separatorBefore?: boolean;
}

export interface DropdownMenuProps {
  /** Trigger label. Changing it rises the new label in. */
  label: string;
  items: DropdownItem[];
  icon?: JSX.Element;
  /** Render only an icon trigger (label becomes the accessible name). */
  iconOnly?: boolean;
  placement?: "bottom-end" | "bottom-start" | "top-end" | "top-start";
  class?: string;
}

/**
 * Arc DropdownMenu (Kobalte): a list of actions behind a trigger. One highlight glides between items for the pointer
 * and jumps for the keyboard; the menu grows from the trigger edge. The trigger anchors the menu, so a press answers
 * with colour only.
 */
export function DropdownMenu(props: DropdownMenuProps) {
  let highlight: HTMLSpanElement | undefined;
  let pointer = false;
  let shown = false;
  let clearTimer = 0;
  const [tone, setTone] = createSignal<string | undefined>();
  onCleanup(() => window.clearTimeout(clearTimer));
  const onMenuFocus = (event: FocusEvent) => {
    const item = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('[role="menuitem"]') : null;
    window.clearTimeout(clearTimer);
    if (!highlight) return;
    if (!item) {
      clearTimer = window.setTimeout(() => { if (highlight) animate(highlight, { opacity: 0 }, { duration: prefersReducedMotion() ? 0 : 0.08 }); shown = false; }, pointer ? 70 : 0);
      return;
    }
    setTone(item.dataset.tone);
    const target = { y: item.offsetTop, height: `${item.offsetHeight}px` };
    if (shown && pointer && !prefersReducedMotion()) animate(highlight, { ...target, opacity: 1 }, { ...spring.snappy, opacity: { duration: 0.08 } });
    else animate(highlight, { ...target, opacity: 1 }, { duration: 0, opacity: { duration: prefersReducedMotion() ? 0 : 0.08 } });
    shown = true;
  };
  return (
    <K placement={props.placement ?? "bottom-end"} gutter={6} overflowPadding={12} onOpenChange={open => { if (open) { shown = false; window.clearTimeout(clearTimer); } }}>
      <K.Trigger ref={(el: HTMLButtonElement) => useSquircle(el)} class={props.iconOnly ? `${styles.trigger} ${styles.iconOnly}` : styles.trigger} aria-label={props.iconOnly ? props.label : undefined}>
        <Show when={props.icon}><span class={styles.triggerIcon} aria-hidden="true">{props.icon}</span></Show>
        <Show when={!props.iconOnly}>
          <span class={styles.label}><SwapText text={props.label} class={styles.labelText} /></span>
          <ChevronDown class={styles.chevron} size={15} stroke-width={1.8} aria-hidden="true" />
        </Show>
      </K.Trigger>
      <K.Portal>
        <K.Content
          ref={(el: HTMLDivElement) => useSquircle(el)}
          class={styles.menu}
          onFocusIn={onMenuFocus}
          onPointerMove={() => { pointer = true; }}
          onKeyDown={() => { pointer = false; }}
        >
          <span ref={highlight} class={styles.highlight} data-tone={tone()} aria-hidden="true" />
          <For each={props.items}>
            {(item, index) => (
              <>
                <Show when={item.separatorBefore}><K.Separator class={styles.separator} /></Show>
                <K.Item class={item.destructive ? `${styles.item} ${styles.destructive}` : styles.item} data-tone={item.destructive ? "danger" : undefined} style={{ "--i": String(index()) }} disabled={item.disabled} onSelect={() => item.onSelect?.()}>
                  <Show when={item.icon}><span class={styles.icon} aria-hidden="true">{item.icon}</span></Show>
                  <K.ItemLabel class={styles.itemLabel}>{item.label}</K.ItemLabel>
                  <Show when={item.keys}><kbd class={styles.keys} aria-hidden="true">{item.keys?.join("")}</kbd></Show>
                </K.Item>
              </>
            )}
          </For>
        </K.Content>
      </K.Portal>
    </K>
  );
}

export default DropdownMenu;
