import { Show, createSignal, splitProps, type JSX, type ParentProps } from "solid-js";
import { Dialog as K, useDialogContext } from "@kobalte/core/dialog";
import { Button, type ButtonProps } from "../button/button";
import { X } from "lucide-solid";
import { cx } from "../lib/cx";
import { SwapText } from "../lib/presence";
import { animate, prefersReducedMotion, spring, motionTokens } from "../lib/motion";
import { useSquircle } from "../lib/squircle";
import styles from "./drawer.module.css";

export interface DrawerProps extends ParentProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/** Arc Drawer root (Kobalte dialog): a long form, filters, or a record's details beside the page. */
export function Drawer(props: DrawerProps) {
  return <K open={props.open} defaultOpen={props.defaultOpen} onOpenChange={props.onOpenChange} modal preventScroll>{props.children}</K>;
}

export const DrawerTrigger = K.Trigger;
/** An Arc Button that closes the drawer; its visible label stays its accessible name. */
export function DrawerClose(props: ButtonProps) {
  const context = useDialogContext();
  const [local, rest] = splitProps(props, ["onClick", "variant"]);
  return (
    <Button
      {...rest}
      variant={local.variant ?? "ghost"}
      onClick={event => {
        const handler = local.onClick;
        if (typeof handler === "function") handler(event);
        context.close();
      }}
    />
  );
}

export interface DrawerContentProps {
  title: string;
  description?: string;
  children?: JSX.Element;
  footer?: JSX.Element;
  side?: "left" | "right" | "top" | "bottom";
  class?: string;
  /** Wider panel for tables and payloads. */
  size?: "md" | "lg";
}

/**
 * Arc DrawerContent: the panel springs from its edge and returns there faster. The header is a drag handle: past a
 * third of the panel, or on a quick flick toward the edge, it closes keeping its velocity; otherwise it springs back.
 */
export function DrawerContent(props: DrawerContentProps) {
  const [local] = splitProps(props, ["title", "description", "children", "footer", "side", "class", "size"]);
  const side = () => local.side ?? "right";
  const axis = () => (side() === "left" || side() === "right" ? "x" : "y");
  const sign = () => (side() === "right" || side() === "bottom" ? 1 : -1);
  let panel: HTMLDivElement | undefined;
  let closer: HTMLButtonElement | undefined;
  let offset = 0;
  let pan: { start: number; origin: number; samples: { t: number; v: number }[] } | null = null;
  const [flung, setFlung] = createSignal(false);
  const size = () => (axis() === "x" ? panel?.offsetWidth : panel?.offsetHeight) ?? 480;
  const paint = () => {
    if (!panel) return;
    panel.style.translate = offset ? (axis() === "x" ? `${offset}px 0` : `0 ${offset}px`) : "";
  };
  const onPointerDown = (event: PointerEvent) => {
    const target = event.target instanceof Element ? event.target : null;
    if (prefersReducedMotion() || event.button !== 0 || target?.closest("button, a, input, select, textarea, [role='button']")) return;
    const point = axis() === "x" ? event.clientX : event.clientY;
    pan = { start: point, origin: offset, samples: [{ t: event.timeStamp, v: point }] };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent) => {
    if (!pan) return;
    const point = axis() === "x" ? event.clientX : event.clientY;
    const toward = (pan.origin + point - pan.start) * sign();
    // Toward the edge follows the pointer; the other way rubber-bands.
    offset = sign() * (toward >= 0 ? toward : -Math.sqrt(-toward));
    pan.samples.push({ t: event.timeStamp, v: point });
    if (pan.samples.length > 8) pan.samples.shift();
    paint();
  };
  const onPointerUp = (event: PointerEvent) => {
    if (!pan) return;
    const samples = pan.samples;
    pan = null;
    const first = samples[0];
    const last = samples[samples.length - 1];
    const velocity = first && last && last.t > first.t ? ((last.v - first.v) / (last.t - first.t)) * 1000 : 0;
    const toward = offset * sign();
    if (toward > size() / 3 || (toward > 0 && velocity * sign() > 500)) {
      // The flick carries its velocity off the edge; the dialog closes once it is gone.
      setFlung(true);
      const from = offset;
      const to = sign() * (size() + 24);
      animate(from, to, { ...motionTokens.spring.smooth, visualDuration: motionTokens.duration.standard, velocity, onUpdate: value => { offset = value; paint(); } }).then(() => closer?.click());
      return;
    }
    const from = offset;
    animate(from, 0, { ...spring.snappy, onUpdate: value => { offset = value; paint(); } });
    void event;
  };
  return (
    <K.Portal>
      <K.Overlay class={styles.overlay} />
      <K.Content
        ref={(el: HTMLDivElement) => { panel = el; useSquircle(el); }}
        class={cx(styles.content, local.size === "lg" && styles.lg, local.class)}
        data-side={side()}
        data-flung={flung() || undefined}
      >
        <div class={styles.header} classList={{ [styles.handle!]: !prefersReducedMotion() }} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
          <div class={styles.heading}>
            <K.Title class={styles.title}><SwapText text={local.title} /></K.Title>
            <Show when={local.description}><K.Description class={styles.description}><SwapText text={local.description ?? ""} /></K.Description></Show>
          </div>
          <K.CloseButton ref={(el: HTMLButtonElement) => { closer = el; useSquircle(el); }} class={styles.close} aria-label="Close drawer"><X size={16} stroke-width={1.75} aria-hidden="true" /></K.CloseButton>
        </div>
        <div class={styles.body}>{local.children}</div>
        <Show when={local.footer}><div class={styles.footer}>{local.footer}</div></Show>
      </K.Content>
    </K.Portal>
  );
}

export default Drawer;
