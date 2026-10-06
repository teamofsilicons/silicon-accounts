/**
 * The identity card shell (the account site's home): a squircle "passport" on warm paper with grain, that tilts very
 * slightly toward the pointer (≤ 3°) and flips in 3D to show its back. Content is the page's: pass `front` and `back`.
 *
 *   <IdentityCard label="Saket's identity card" front={<Front />} back={<Back />} />
 *   // inside either face:
 *   const card = useIdentityCard();  <Button onClick={card.toggle}>Details</Button>
 *
 * Also exported: IdentityField (label, value, copy), Stamp / StampRow (apps you carry), LiveClock (time in a zone).
 */
import { For, Show, createContext, createEffect, createMemo, createSignal, on, onCleanup, onMount, useContext, type Accessor, type JSX } from "solid-js";
import { CopyButton } from "../../arc/copy-button/copy-button";
import { SlotText } from "../../arc/slot-text/slot-text";
import { Tooltip } from "../../arc/tooltip/tooltip";
import { cx } from "../../arc/lib/cx";
import { animate, prefersReducedMotion, type AnimationControls } from "../../arc/lib/motion";
import { useSquircle } from "../../arc/lib/squircle";
import { formatTime } from "../../lib/format";
import { timezoneLabel, utcOffset } from "../../lib/timezones";
import styles from "./identity-card.module.css";

const MAX_TILT = 3;
const FLIP = { type: "spring", visualDuration: 0.62, bounce: 0.12 } as const;

interface IdentityCardContextValue {
  flipped: Accessor<boolean>;
  setFlipped: (next: boolean) => void;
  toggle: () => void;
}

const IdentityCardContext = createContext<IdentityCardContextValue>();

/** Flip controls for buttons inside the card's faces. */
export function useIdentityCard(): IdentityCardContextValue {
  const context = useContext(IdentityCardContext);
  if (!context) throw new Error("useIdentityCard() must be called inside an <IdentityCard> face.");
  return context;
}

export interface IdentityCardProps {
  front: JSX.Element;
  back: JSX.Element;
  /** Accessible name of the card, for example "Identity card of c:saket". */
  label: string;
  flipped?: boolean;
  defaultFlipped?: boolean;
  onFlippedChange?: (flipped: boolean) => void;
  /** Turn the pointer tilt off (for example on the landing illustration while it auto-animates). */
  tilt?: boolean;
  class?: string;
}

export function IdentityCard(props: IdentityCardProps) {
  const [inner, setInner] = createSignal(!!props.defaultFlipped);
  const flipped = () => props.flipped ?? inner();
  const setFlipped = (next: boolean) => {
    if (props.flipped === undefined) setInner(next);
    props.onFlippedChange?.(next);
  };
  let scene: HTMLDivElement | undefined;
  let frontFace: HTMLElement | undefined;
  let backFace: HTMLElement | undefined;
  const [active, setActive] = createSignal(false);

  /* Tilt: an exponentially smoothed follow of the pointer, written to CSS variables (no re-render per frame). */
  const tilt = { x: 0, y: 0, tx: 0, ty: 0, frame: 0 };
  const step = () => {
    tilt.x += (tilt.tx - tilt.x) * 0.14;
    tilt.y += (tilt.ty - tilt.y) * 0.14;
    if (scene) {
      scene.style.setProperty("--id-tilt-x", `${tilt.x.toFixed(3)}deg`);
      scene.style.setProperty("--id-tilt-y", `${tilt.y.toFixed(3)}deg`);
      scene.style.setProperty("--id-light-x", `${(50 + tilt.y * 12).toFixed(1)}%`);
      scene.style.setProperty("--id-light-y", `${(20 - tilt.x * 10).toFixed(1)}%`);
    }
    if (Math.abs(tilt.tx - tilt.x) > 0.005 || Math.abs(tilt.ty - tilt.y) > 0.005) tilt.frame = requestAnimationFrame(step);
    else tilt.frame = 0;
  };
  const kick = () => { if (!tilt.frame) tilt.frame = requestAnimationFrame(step); };
  const onPointerMove = (event: PointerEvent) => {
    if (props.tilt === false || prefersReducedMotion() || event.pointerType !== "mouse" || !scene) return;
    const box = scene.getBoundingClientRect();
    const dx = Math.max(-1, Math.min(1, ((event.clientX - box.left) / box.width) * 2 - 1));
    const dy = Math.max(-1, Math.min(1, ((event.clientY - box.top) / box.height) * 2 - 1));
    tilt.tx = -dy * MAX_TILT;
    tilt.ty = dx * MAX_TILT;
    setActive(true);
    kick();
  };
  const onPointerLeave = () => {
    tilt.tx = 0;
    tilt.ty = 0;
    setActive(false);
    kick();
  };
  onCleanup(() => cancelAnimationFrame(tilt.frame));

  /* Flip: one spring on the Y rotation; the faces swap at 90° by backface visibility. At rest on its back the card
     is laid flat again (data-settled="back"), so its text is not rasterized through two rotations. */
  let flipControls: AnimationControls | undefined;
  let angle = flipped() ? 180 : 0;
  const [settled, setSettled] = createSignal<"front" | "back" | null>(flipped() ? "back" : "front");
  onMount(() => scene?.style.setProperty("--id-flip", `${angle}deg`));
  createEffect(on(flipped, isFlipped => {
    const target = isFlipped ? 180 : 0;
    flipControls?.stop();
    if (!scene) return;
    if (prefersReducedMotion()) {
      angle = target;
      scene.style.setProperty("--id-flip", `${target}deg`);
      setSettled(isFlipped ? "back" : "front");
      const shown = isFlipped ? backFace : frontFace;
      if (shown) animate(shown, { opacity: [0, 1] }, { duration: 0.16 });
      return;
    }
    setSettled(null);
    flipControls = animate(angle, target, {
      ...FLIP,
      onUpdate: value => {
        angle = value;
        scene?.style.setProperty("--id-flip", `${value.toFixed(2)}deg`);
      },
      onComplete: () => setSettled(isFlipped ? "back" : "front"),
    });
    // Focus follows the flip so keyboard users land on the face they asked for.
    queueMicrotask(() => {
      const face = isFlipped ? backFace : frontFace;
      if (face && scene?.contains(document.activeElement)) face.querySelector<HTMLElement>("button, a, [tabindex='0']")?.focus({ preventScroll: true });
    });
  }, { defer: true }));

  const context: IdentityCardContextValue = { flipped, setFlipped, toggle: () => setFlipped(!flipped()) };
  const reduced = createMemo(() => prefersReducedMotion());

  return (
    <IdentityCardContext.Provider value={context}>
      <div
        ref={scene}
        class={cx(styles.scene, props.class)}
        data-active={active() || undefined}
        data-reduced={reduced() || undefined}
        data-settled={settled() ?? undefined}
        data-moving={settled() === null || active() || undefined}
        onPointerMove={onPointerMove}
        onPointerLeave={onPointerLeave}
      >
        <div class={styles.card}>
          <section ref={el => { frontFace = el; useSquircle(el); }} class={styles.face} aria-label={props.label} aria-hidden={flipped() || undefined} inert={flipped() || undefined} data-hidden={flipped() || undefined}>
            <CardDecor />
            {props.front}
          </section>
          <section ref={el => { backFace = el; useSquircle(el); }} class={cx(styles.face, styles.back)} aria-label={`${props.label}, details`} aria-hidden={!flipped() || undefined} inert={!flipped() || undefined} data-hidden={!flipped() || undefined}>
            <CardDecor />
            {props.back}
          </section>
        </div>
      </div>
    </IdentityCardContext.Provider>
  );
}

function CardDecor() {
  return (
    <>
      <span class={styles.grain} aria-hidden="true" />
      <span class={styles.sheen} aria-hidden="true" />
      <span ref={el => useSquircle(el)} class={styles.inset} aria-hidden="true" />
      <svg class={styles.seal} viewBox="0 0 200 200" fill="none" stroke="currentColor" aria-hidden="true">
        <circle cx="100" cy="100" r="96" stroke-width="1.5" />
        <circle cx="100" cy="100" r="84" stroke-width="1" stroke-dasharray="2 5" />
        <circle cx="100" cy="100" r="70" stroke-width="1" />
        <circle cx="100" cy="100" r="44" stroke-width="1" stroke-dasharray="1 4" />
        <path d="M100 30v140M30 100h140M50.5 50.5l99 99M149.5 50.5l-99 99" stroke-width=".75" stroke-dasharray="1 6" />
      </svg>
    </>
  );
}

export interface IdentityFieldProps {
  label: string;
  value: string | null | undefined;
  /** Render the value in the mono face (ids, uuids). */
  mono?: boolean;
  /** Adds a copy button with this accessible label, for example "Copy uuid". */
  copyLabel?: string;
  /** Replaces the plain value (for example an inline editor). */
  children?: JSX.Element;
  class?: string;
}

/** A label and its value on the card, optionally copyable. */
export function IdentityField(props: IdentityFieldProps) {
  return (
    <div class={cx(styles.field, props.class)}>
      <span class={styles.fieldLabel}>{props.label}</span>
      <span class={styles.fieldValue}>
        <Show when={props.children} fallback={<span class={cx(styles.fieldText, props.mono && styles.mono)} title={props.value ?? undefined}>{props.value || "–"}</span>}>
          {props.children}
        </Show>
        <Show when={props.copyLabel && props.value}>
          <CopyButton value={props.value ?? ""} label={props.copyLabel} iconOnly variant="plain" size="xs" />
        </Show>
      </span>
    </div>
  );
}

export interface StampProps {
  /** The app's name (tooltip and accessible name). */
  name: string;
  logoUrl?: string | null;
  /** A stable key (the app id) decides the angle, so a stamp always lands the same way. */
  seed: string;
  href?: string;
  size?: number;
}

function angleFor(seed: string): number {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return ((Math.abs(hash) % 13) - 6) * 1.1;
}

/** One app the account carries, pressed onto the card at a slight angle that straightens on hover. */
export function Stamp(props: StampProps) {
  const initials = () => props.name.split(/\s+/).slice(0, 2).map(part => part[0]?.toUpperCase() ?? "").join("");
  const body = (triggerProps: JSX.HTMLAttributes<HTMLElement>) => {
    const style = { "--stamp-angle": `${angleFor(props.seed)}deg`, "--stamp-size": `${props.size ?? 40}px` };
    const content = (
      <span ref={el => useSquircle(el, { mode: "clip" })} class={styles.stampInner}>
        <Show when={props.logoUrl} fallback={initials()}>
          <img src={props.logoUrl ?? ""} alt="" decoding="async" referrerPolicy="no-referrer" />
        </Show>
      </span>
    );
    // Kobalte's trigger ref positions the tooltip; keep it alongside the squircle.
    const ref = (el: HTMLElement) => {
      (triggerProps as { ref?: (el: HTMLElement) => void }).ref?.(el);
      useSquircle(el);
    };
    return props.href
      ? <a {...triggerProps} ref={ref} href={props.href} class={styles.stamp} style={style} aria-label={props.name}>{content}</a>
      : <span {...triggerProps} ref={ref} class={styles.stamp} style={style} role="img" aria-label={props.name} tabIndex={0}>{content}</span>;
  };
  return <Tooltip content={props.name}>{triggerProps => body(triggerProps)}</Tooltip>;
}

/** A row of stamps; past `max` the rest fold into a "+N" mark. */
export function StampRow(props: { apps: StampProps[]; max?: number; label?: string; class?: string }) {
  const shown = () => props.apps.slice(0, props.max ?? 8);
  const rest = () => Math.max(0, props.apps.length - shown().length);
  let row: HTMLDivElement | undefined;
  onMount(() => {
    if (!row || prefersReducedMotion()) return;
    // The stamps press onto the card one after another the first time the card shows.
    Array.from(row.children).forEach((child, index) => {
      animate(child as HTMLElement, { opacity: [0, 1], scale: [1.18, 1] }, { type: "spring", visualDuration: 0.34, bounce: 0.18, delay: 0.12 + index * 0.045 });
    });
  });
  return (
    <div ref={row} class={cx(styles.stamps, props.class)} role="list" aria-label={props.label ?? "Apps"}>
      <For each={shown()}>{app => <span role="listitem"><Stamp {...app} /></span>}</For>
      <Show when={rest() > 0}><span role="listitem" ref={el => useSquircle(el)} class={styles.more}>+{rest()}</span></Show>
    </div>
  );
}

/** The current time in an IANA zone, ticking each minute with rolling digits, plus the zone and its UTC offset. */
export function LiveClock(props: { timeZone: string; class?: string; showZone?: boolean }) {
  const [now, setNow] = createSignal(Date.now());
  let timer = 0;
  const schedule = () => {
    const wait = 60_000 - (Date.now() % 60_000) + 50;
    timer = window.setTimeout(() => { setNow(Date.now()); schedule(); }, wait);
  };
  onMount(schedule);
  onCleanup(() => window.clearTimeout(timer));
  const time = () => {
    try {
      return formatTime(now(), props.timeZone);
    } catch {
      return formatTime(now(), "UTC");
    }
  };
  return (
    <span class={cx(styles.clock, props.class)}>
      <SlotText value={time()} class={styles.clockTime} align="end" />
      <Show when={props.showZone !== false}>
        <span class={styles.clockZone}>{timezoneLabel(props.timeZone)} · UTC{utcOffset(props.timeZone)}</span>
      </Show>
    </span>
  );
}
