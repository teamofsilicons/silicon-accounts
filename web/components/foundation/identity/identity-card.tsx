"use client";

/**
 * The identity card (the account site's home): a squircle "passport" on warm paper with grain, that tilts very slightly
 * toward the pointer (≤ 3°) and flips in 3D to show its back. Content is the page's: pass `front` and `back`.
 *
 *   <IdentityCard label="Identity card of c:saket" front={<Front />} back={<Back />} />
 *   // inside either face:
 *   const card = useIdentityCard();  <Button onClick={card.toggle}>Details</Button>
 *
 * Also exported: IdentityField (label, value, copy), Stamp / StampRow (apps the account carries), LiveClock (time in a
 * zone, rolling digits).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { animate, useReducedMotion, type AnimationPlaybackControls } from "motion/react";
import { CopyButton } from "@/components/arc/copy-button/copy-button";
import { SlotText } from "@/components/arc/slot-text/slot-text";
import { Tooltip } from "@/components/arc/tooltip/tooltip";
import { formatTime } from "@/lib/format";
import { timezoneLabel, utcOffset } from "@/lib/timezones";
import styles from "./identity-card.module.css";

const cx = (...names: Array<string | false | null | undefined>) => names.filter(Boolean).join(" ");

const MAX_TILT = 3;
const FLIP = { type: "spring", visualDuration: 0.62, bounce: 0.12 } as const;

interface IdentityCardContextValue {
  flipped: boolean;
  setFlipped: (next: boolean) => void;
  toggle: () => void;
}

const IdentityCardContext = createContext<IdentityCardContextValue | null>(null);

/** Flip controls for buttons inside the card's faces. */
export function useIdentityCard(): IdentityCardContextValue {
  const context = useContext(IdentityCardContext);
  if (!context) throw new Error("useIdentityCard() must be called inside an <IdentityCard> face.");
  return context;
}

export interface IdentityCardProps {
  front: ReactNode;
  back: ReactNode;
  /** Accessible name of the card, for example "Identity card of c:saket". */
  label: string;
  flipped?: boolean;
  defaultFlipped?: boolean;
  onFlippedChange?: (flipped: boolean) => void;
  /** Turn the pointer tilt off. */
  tilt?: boolean;
  className?: string;
}

export function IdentityCard({ front, back, label, flipped: flippedProp, defaultFlipped = false, onFlippedChange, tilt = true, className }: IdentityCardProps) {
  const reduced = useReducedMotion() ?? false;
  const [inner, setInner] = useState(defaultFlipped);
  const flipped = flippedProp ?? inner;
  const setFlipped = useCallback((next: boolean) => {
    if (flippedProp === undefined) setInner(next);
    onFlippedChange?.(next);
  }, [flippedProp, onFlippedChange]);
  const sceneRef = useRef<HTMLDivElement>(null);
  const frontRef = useRef<HTMLElement>(null);
  const backRef = useRef<HTMLElement>(null);

  /* Tilt: an exponentially smoothed follow of the pointer, written to CSS variables and data attributes on the scene
     (no React render per frame). */
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene || !tilt || reduced) return;
    const state = { x: 0, y: 0, tx: 0, ty: 0, frame: 0 };
    const step = () => {
      state.x += (state.tx - state.x) * 0.14;
      state.y += (state.ty - state.y) * 0.14;
      scene.style.setProperty("--id-tilt-x", `${state.x.toFixed(3)}deg`);
      scene.style.setProperty("--id-tilt-y", `${state.y.toFixed(3)}deg`);
      scene.style.setProperty("--id-light-x", `${(50 + state.y * 12).toFixed(1)}%`);
      scene.style.setProperty("--id-light-y", `${(20 - state.x * 10).toFixed(1)}%`);
      const moving = Math.abs(state.tx - state.x) > 0.005 || Math.abs(state.ty - state.y) > 0.005;
      state.frame = moving ? requestAnimationFrame(step) : 0;
    };
    const kick = () => {
      if (!state.frame) state.frame = requestAnimationFrame(step);
    };
    const onMove = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      const box = scene.getBoundingClientRect();
      const dx = Math.max(-1, Math.min(1, ((event.clientX - box.left) / box.width) * 2 - 1));
      const dy = Math.max(-1, Math.min(1, ((event.clientY - box.top) / box.height) * 2 - 1));
      state.tx = -dy * MAX_TILT;
      state.ty = dx * MAX_TILT;
      scene.dataset.active = "";
      kick();
    };
    const onLeave = () => {
      state.tx = 0;
      state.ty = 0;
      delete scene.dataset.active;
      kick();
    };
    scene.addEventListener("pointermove", onMove);
    scene.addEventListener("pointerleave", onLeave);
    return () => {
      scene.removeEventListener("pointermove", onMove);
      scene.removeEventListener("pointerleave", onLeave);
      cancelAnimationFrame(state.frame);
      delete scene.dataset.active;
    };
  }, [tilt, reduced]);

  /* Flip: one spring on the Y rotation; the faces swap at 90° by backface visibility. At rest on its back the card is
     laid flat again (data-settled="back"), so its text is not rasterized through two rotations. */
  const angle = useRef(defaultFlipped ? 180 : 0);
  const first = useRef(true);
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    const target = flipped ? 180 : 0;
    const settle = () => {
      scene.dataset.settled = flipped ? "back" : "front";
      delete scene.dataset.moving;
    };
    if (first.current || reduced) {
      const animateIn = !first.current;
      first.current = false;
      angle.current = target;
      scene.style.setProperty("--id-flip", `${target}deg`);
      settle();
      const shown = flipped ? backRef.current : frontRef.current;
      if (animateIn && shown) animate(shown, { opacity: [0, 1] }, { duration: 0.16 });
      return;
    }
    delete scene.dataset.settled;
    scene.dataset.moving = "";
    const controls: AnimationPlaybackControls = animate(angle.current, target, {
      ...FLIP,
      onUpdate: value => {
        angle.current = value;
        scene.style.setProperty("--id-flip", `${value.toFixed(2)}deg`);
      },
      onComplete: settle,
    });
    // Focus follows the flip so keyboard users land on the face they asked for.
    queueMicrotask(() => {
      const face = flipped ? backRef.current : frontRef.current;
      if (face && scene.contains(document.activeElement)) face.querySelector<HTMLElement>("button, a, [tabindex='0']")?.focus({ preventScroll: true });
    });
    return () => controls.stop();
  }, [flipped, reduced]);

  const context = useMemo<IdentityCardContextValue>(() => ({ flipped, setFlipped, toggle: () => setFlipped(!flipped) }), [flipped, setFlipped]);

  return (
    <IdentityCardContext.Provider value={context}>
      <div ref={sceneRef} className={cx(styles.scene, className)} data-identity-card="" data-reduced={reduced || undefined} data-settled={defaultFlipped ? "back" : "front"}>
        <div className={styles.card}>
          <section ref={frontRef} data-sq="surface" className={styles.face} aria-label={label} aria-hidden={flipped || undefined} inert={flipped} data-hidden={flipped || undefined}>
            <CardDecor />
            {front}
          </section>
          <section ref={backRef} data-sq="surface" className={cx(styles.face, styles.back)} aria-label={`${label}, details`} aria-hidden={!flipped || undefined} inert={!flipped} data-hidden={!flipped || undefined}>
            <CardDecor />
            {back}
          </section>
        </div>
      </div>
    </IdentityCardContext.Provider>
  );
}

function CardDecor() {
  return (
    <>
      <span className={styles.grain} aria-hidden="true" />
      <span className={styles.sheen} aria-hidden="true" />
      <span data-sq="surface" className={styles.inset} aria-hidden="true" />
      <svg className={styles.seal} viewBox="0 0 200 200" fill="none" stroke="currentColor" aria-hidden="true">
        <circle cx="100" cy="100" r="96" strokeWidth="1.5" />
        <circle cx="100" cy="100" r="84" strokeWidth="1" strokeDasharray="2 5" />
        <circle cx="100" cy="100" r="70" strokeWidth="1" />
        <circle cx="100" cy="100" r="44" strokeWidth="1" strokeDasharray="1 4" />
        <path d="M100 30v140M30 100h140M50.5 50.5l99 99M149.5 50.5l-99 99" strokeWidth=".75" strokeDasharray="1 6" />
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
  /** Replaces the plain value (for example an inline editor or a live clock). */
  children?: ReactNode;
  /** Let a long value take the card's whole row (ids up to 30 characters). */
  wide?: boolean;
  className?: string;
}

/** A label and its value on the card, optionally copyable. Long values are cut with an ellipsis; the title has them. */
export function IdentityField({ label, value, mono, copyLabel, children, wide, className }: IdentityFieldProps) {
  return (
    <div className={cx(styles.field, wide && styles.wide, className)}>
      <span className={styles.fieldLabel}>{label}</span>
      <span className={styles.fieldValue}>
        {children ?? <span className={cx(styles.fieldText, mono && styles.mono)} title={value ?? undefined}>{value || "Not set"}</span>}
        {copyLabel && value ? <CopyButton value={value} label={copyLabel} iconOnly variant="plain" className={styles.copy} /> : null}
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
export function Stamp({ name, logoUrl, seed, href, size = 40 }: StampProps) {
  const initials = name.split(/\s+/).slice(0, 2).map(part => part[0]?.toUpperCase() ?? "").join("");
  const style = { "--stamp-angle": `${angleFor(seed)}deg`, "--stamp-size": `${size}px` } as CSSProperties;
  const content = (
    <span data-sq="clip" className={styles.stampInner}>
      {/* eslint-disable-next-line @next/next/no-img-element -- app logos are arbitrary https or data URLs, shown as is. */}
      {logoUrl ? <img src={logoUrl} alt="" decoding="async" referrerPolicy="no-referrer" /> : initials}
    </span>
  );
  return (
    <Tooltip content={name}>
      {href
        ? <a href={href} data-sq="surface" className={styles.stamp} style={style} aria-label={name}>{content}</a>
        : <span data-sq="surface" className={styles.stamp} style={style} role="img" aria-label={name} tabIndex={0}>{content}</span>}
    </Tooltip>
  );
}

/** A row of stamps; past `max` the rest fold into a "+N" mark. */
export function StampRow({ apps, max = 8, label = "Apps", className }: { apps: StampProps[]; max?: number; label?: string; className?: string }) {
  const reduced = useReducedMotion() ?? false;
  const shown = apps.slice(0, max);
  const rest = Math.max(0, apps.length - shown.length);
  const rowRef = useRef<HTMLDivElement>(null);
  const pressed = useRef(false);
  useEffect(() => {
    const row = rowRef.current;
    if (!row || reduced || pressed.current) return;
    pressed.current = true;
    // The stamps press onto the card one after another the first time the card shows.
    Array.from(row.children).forEach((child, index) => {
      animate(child as HTMLElement, { opacity: [0, 1], scale: [1.18, 1] }, { type: "spring", visualDuration: 0.34, bounce: 0.18, delay: 0.12 + index * 0.045 });
    });
  }, [reduced]);
  return (
    <div ref={rowRef} className={cx(styles.stamps, className)} role="list" aria-label={label}>
      {shown.map(app => <span key={app.seed} role="listitem"><Stamp {...app} /></span>)}
      {rest > 0 ? <span role="listitem" data-sq="surface" className={styles.more}>+{rest}</span> : null}
    </div>
  );
}

/** The current time in an IANA zone, ticking each minute with rolling digits, plus the zone and its UTC offset. */
export function LiveClock({ timeZone, className, showZone = true }: { timeZone: string; className?: string; showZone?: boolean }) {
  // The first render matches the server (no clock yet); the time appears after hydration and then ticks each minute.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    let timer = 0;
    const tick = () => {
      setNow(Date.now());
      timer = window.setTimeout(tick, 60_000 - (Date.now() % 60_000) + 50);
    };
    tick();
    return () => window.clearTimeout(timer);
  }, []);
  let time = "--:--";
  if (now !== null) {
    try {
      time = formatTime(now, timeZone);
    } catch {
      time = formatTime(now, "UTC");
    }
  }
  return (
    <span className={cx(styles.clock, className)}>
      <SlotText value={time} className={styles.clockTime} align="end" />
      {showZone ? <span className={styles.clockZone}>{timezoneLabel(timeZone)} · UTC{now === null ? "" : utcOffset(timeZone)}</span> : null}
    </span>
  );
}
