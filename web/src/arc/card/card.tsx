import { For, Show, createSignal, splitProps, type JSX } from "solid-js";
import { Dialog as K } from "@kobalte/core/dialog";
import { X } from "lucide-solid";
import { cx } from "../lib/cx";
import { Presence, Swap } from "../lib/presence";
import { animate, instant, motionTokens, prefersReducedMotion, spring, tween } from "../lib/motion";
import { useSquircle } from "../lib/squircle";
import styles from "./card.module.css";

export interface CardProps extends Omit<JSX.HTMLAttributes<HTMLElement>, "title"> {
  title: string;
  description?: string;
  media?: JSX.Element;
  action?: JSX.Element;
  /** A small leading visual for the footer, such as an app icon or the owner's avatar. */
  avatar?: JSX.Element;
  /** Who or what the card belongs to. */
  meta?: JSX.Element;
  /** A short status under the meta, such as "Updated 2 hours ago". Changed words rise in and are announced politely. */
  status?: string;
  /** Content for a quick look. When set, the whole card opens and grows into a larger view. */
  details?: JSX.Element;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Headline level for the title. Defaults to h3. */
  headingLevel?: 2 | 3 | 4;
}

function Status(props: { text: string }) {
  return (
    <span class={styles.status} role="status">
      <span class="sr-only">{props.text}</span>
      <span class={styles.roll} aria-hidden="true">
        <Swap
          value={props.text}
          class={styles.line}
          enter={el => {
            if (prefersReducedMotion()) return;
            el.querySelectorAll<HTMLElement>("[data-word]").forEach((word, index) => {
              animate(word, { opacity: [0, 1], y: ["0.3em", "0em"], filter: ["blur(4px)", "blur(0px)"] }, { ...tween(motionTokens.duration.standard, motionTokens.ease.enter), delay: index * motionTokens.stagger.word });
            });
          }}
          exit={el => (prefersReducedMotion() ? animate(el, { opacity: 0 }, instant) : animate(el, { opacity: 0, y: "-0.3em", filter: "blur(2px)" }, tween(motionTokens.duration.fast)))}
        >
          {text => <For each={text.split(/(\s+)/)}>{part => <span data-word class={styles.word}>{part}</span>}</For>}
        </Swap>
      </span>
    </span>
  );
}

/**
 * Arc Card: a bordered surface for one object. A pointed-at card lifts a little; with `details`, pressing anywhere on it
 * grows it into a quick look (the panel travels from the card's box and back).
 */
export function Card(props: CardProps) {
  const [local, rest] = splitProps(props, ["title", "description", "media", "action", "avatar", "meta", "status", "details", "open", "defaultOpen", "onOpenChange", "headingLevel", "children", "class"]);
  let card: HTMLElement | undefined;
  const [uncontrolled, setUncontrolled] = createSignal(!!local.defaultOpen);
  const open = () => (local.details ? local.open ?? uncontrolled() : false);
  const setOpen = (next: boolean) => {
    if (local.open === undefined) setUncontrolled(next);
    local.onOpenChange?.(next);
  };
  const Heading = (p: { children: JSX.Element; class: string }) => {
    const level = local.headingLevel ?? 3;
    return level === 2 ? <h2 class={p.class}>{p.children}</h2> : level === 4 ? <h4 class={p.class}>{p.children}</h4> : <h3 class={p.class}>{p.children}</h3>;
  };
  const lift = (to: number) => {
    if (!card || prefersReducedMotion()) return;
    animate(card, { y: to }, spring.snappy);
  };

  const footer = () => (
    <Show when={local.avatar || local.meta || local.status || local.action}>
      <div class={styles.footer}>
        <Show when={local.avatar || local.meta || local.status}>
          <div class={styles.byline}>
            <Show when={local.avatar}><span class={styles.avatar}>{local.avatar}</span></Show>
            <span class={styles.bylineText}>
              <Show when={local.meta}><span class={styles.meta}>{local.meta}</span></Show>
              <Show when={local.status}><Status text={local.status ?? ""} /></Show>
            </span>
          </div>
        </Show>
        <Show when={local.action}><div class={styles.action}>{local.action}</div></Show>
      </div>
    </Show>
  );

  /** The quick look grows out of the card's box and travels back to it when it closes. */
  const fromCard = (el: HTMLElement) => {
    if (!card) return undefined;
    const a = card.getBoundingClientRect();
    const b = el.getBoundingClientRect();
    if (!b.width || !b.height) return undefined;
    return { x: a.left + a.width / 2 - (b.left + b.width / 2), y: a.top + a.height / 2 - (b.top + b.height / 2), sx: a.width / b.width, sy: a.height / b.height };
  };

  return (
    <>
      <article
        {...rest}
        ref={el => { card = el; useSquircle(el); }}
        class={cx(styles.card, local.details ? styles.interactive : undefined, local.class)}
        onPointerEnter={event => { if (event.pointerType === "mouse") lift(-2); }}
        onPointerLeave={() => lift(0)}
      >
        <Show when={local.media}><div class={styles.media}><div class={styles.zoom}>{local.media}</div></div></Show>
        <div class={styles.content}>
          <Heading class={styles.title}>
            <Show when={local.details} fallback={local.title}>
              <button type="button" class={styles.trigger} aria-haspopup="dialog" aria-expanded={open()} onClick={() => setOpen(true)}>{local.title}</button>
            </Show>
          </Heading>
          <Show when={local.description}><p class={styles.description}>{local.description}</p></Show>
          {local.children}
          {footer()}
        </div>
      </article>
      <Show when={local.details}>
        <K open={open()} onOpenChange={setOpen} forceMount>
          <Presence
            when={open()}
            initial
            enter={el => {
              const panel = el.querySelector<HTMLElement>(`.${styles.panel}`);
              const overlay = el.querySelector<HTMLElement>(`.${styles.overlay}`);
              if (overlay) animate(overlay, { opacity: [0, 1] }, tween(prefersReducedMotion() ? motionTokens.duration.instant : motionTokens.duration.standard, motionTokens.ease.enter));
              if (!panel) return;
              const delta = fromCard(panel);
              if (prefersReducedMotion() || !delta) return animate(panel, { opacity: [0, 1] }, tween(motionTokens.duration.instant));
              return animate(panel, { x: [delta.x, 0], y: [delta.y, 0], scaleX: [delta.sx, 1], scaleY: [delta.sy, 1], opacity: [0.4, 1] }, { ...motionTokens.spring.smooth, visualDuration: 0.3, opacity: tween(motionTokens.duration.fast) });
            }}
            exit={el => {
              const panel = el.querySelector<HTMLElement>(`.${styles.panel}`);
              const overlay = el.querySelector<HTMLElement>(`.${styles.overlay}`);
              if (overlay) animate(overlay, { opacity: 0 }, tween(prefersReducedMotion() ? 0 : motionTokens.duration.exit));
              if (!panel) return;
              const delta = fromCard(panel);
              if (prefersReducedMotion() || !delta) return animate(panel, { opacity: 0 }, tween(motionTokens.duration.instant));
              return animate(panel, { x: delta.x, y: delta.y, scaleX: delta.sx, scaleY: delta.sy, opacity: 0 }, { ...motionTokens.spring.smooth, visualDuration: 0.26, opacity: { duration: 0.26, ease: [0.7, 0, 0.84, 0] } });
            }}
          >
            {ref => (
              <K.Portal>
                <div ref={ref} class={styles.layer}>
                  <K.Overlay class={styles.overlay} />
                  <K.Content ref={el => useSquircle(el)} class={styles.panel}>
                    <Show when={local.media}><div class={styles.media}><div class={styles.zoom}>{local.media}</div></div></Show>
                    <span class={styles.closeSlot}>
                      <K.CloseButton class={styles.close} aria-label="Close quick look"><X width={16} height={16} stroke-width={1.75} aria-hidden="true" /></K.CloseButton>
                    </span>
                    <div class={styles.content}>
                      <K.Title class={styles.title}>{local.title}</K.Title>
                      <Show when={local.description}><K.Description class={styles.description}>{local.description}</K.Description></Show>
                      {footer()}
                      <div class={styles.details}>{local.details}</div>
                    </div>
                  </K.Content>
                </div>
              </K.Portal>
            )}
          </Presence>
        </K>
      </Show>
    </>
  );
}

export default Card;
