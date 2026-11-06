"use client";

/**
 * The type inspector (Anil, 2026-11-06), development only: switched on in the dev states panel. The cursor becomes a
 * crosshair; hovering text outlines it and shows its role on the type scale (styles/tokens.css), or "Off scale" with the
 * nearest role and what differs, then its size, line-height, weight, tracking and family. Clicks in the page do nothing
 * while it's on, so inspecting can't navigate or submit. Esc turns it off.
 *
 * Roles are read from the real tokens through hidden probes, so there's no second copy of the scale to drift. Browsers
 * don't say which face rendered, so the family is the first name in the computed stack (`system-ui`, not "SF Pro").
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import styles from "./type-inspector.module.css";

const ROLES = ["display", "h1", "h2", "h3", "body", "small", "caption", "label"];
/** Anything marked with this (the dev panel) stays clickable and isn't inspected. */
const EXEMPT = "[data-type-inspect-exempt]";
const GAP = 14;

interface Measure {
  size: number;
  /** Line-height as a ratio of size; null for `normal`. */
  line: number | null;
  weight: number;
  /** Tracking in em. */
  tracking: number;
}

interface Reading extends Measure {
  role: string | null;
  near: string | null;
  lineLabel: string;
  family: string;
}

function measure(style: CSSStyleDeclaration): Measure {
  const size = parseFloat(style.fontSize);
  const line = parseFloat(style.lineHeight);
  const tracking = parseFloat(style.letterSpacing);
  return { size, line: Number.isNaN(line) ? null : line / size, weight: Number(style.fontWeight), tracking: Number.isNaN(tracking) ? 0 : tracking / size };
}

function readRoles(): Record<string, Measure> {
  const out: Record<string, Measure> = {};
  for (const role of ROLES) {
    const probe = document.createElement("span");
    probe.hidden = true;
    probe.style.font = `var(--${role})`;
    probe.style.letterSpacing = `var(--${role}-tracking)`;
    document.body.append(probe);
    out[role] = measure(getComputedStyle(probe));
    probe.remove();
  }
  return out;
}

const round = (value: number, places = 2) => String(Number(value.toFixed(places)));

/** What differs from a role, in the words the readout uses. */
function differences(found: Measure, role: Measure): string[] {
  const out: string[] = [];
  if (Math.abs(found.size - role.size) > 0.1) out.push(`size ${round(found.size)}`);
  if (found.line === null || role.line === null ? found.line !== role.line : Math.abs(found.line - role.line) > 0.01) out.push(`line ${found.line === null ? "normal" : round(found.line)}, not ${role.line === null ? "normal" : round(role.line)}`);
  if (found.weight !== role.weight) out.push(`weight ${found.weight}, not ${role.weight}`);
  if (Math.abs(found.tracking - role.tracking) > 0.002) out.push(`tracking ${round(found.tracking, 3)}em, not ${round(role.tracking, 3)}em`);
  return out;
}

function read(element: Element, roles: Record<string, Measure>): Reading {
  const style = getComputedStyle(element);
  const found = measure(style);
  const family = style.fontFamily.split(",")[0]?.trim().replace(/^["']|["']$/g, "") ?? "";
  const lineLabel = found.line === null ? "normal" : `${round(found.line * found.size)} px (${round(found.line)})`;
  const reading: Reading = { ...found, role: null, near: null, lineLabel, family };

  let fewest = Infinity;
  for (const [name, role] of Object.entries(roles)) {
    const diff = differences(found, role);
    if (!diff.length) return { ...reading, role: name, near: null };
    if (Math.abs(found.size - role.size) <= 0.1 && diff.length < fewest) {
      fewest = diff.length;
      reading.near = `Near ${name}: ${diff.join(", ")}`;
    }
  }
  return reading;
}

/** The text under a point: the element holding it and the box to outline, or null over padding, icons and the like. */
function textAt(x: number, y: number): { element: Element; box: DOMRect } | null {
  const hit = document.elementFromPoint(x, y);
  if (!hit || hit.closest(EXEMPT)) return null;
  if (hit instanceof HTMLInputElement || hit instanceof HTMLTextAreaElement) {
    return hit.value || hit.placeholder ? { element: hit, box: hit.getBoundingClientRect() } : null;
  }
  const range = document.createRange();
  for (let element: Element | null = hit; element && element !== document.body; element = element.parentElement) {
    for (const node of element.childNodes) {
      if (node.nodeType !== Node.TEXT_NODE || !node.textContent?.trim()) continue;
      range.selectNodeContents(node);
      const over = Array.from(range.getClientRects()).some(rect => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom);
      if (over) return { element, box: range.getBoundingClientRect() };
    }
  }
  return null;
}

export function TypeInspector({ onExit }: { onExit: () => void }) {
  const [reading, setReading] = useState<Reading | null>(null);
  const outline = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const point = useRef({ x: 0, y: 0 });

  const place = () => {
    const el = card.current;
    if (!el) return;
    const { x, y } = point.current;
    const left = x + GAP + el.offsetWidth > window.innerWidth ? x - GAP - el.offsetWidth : x + GAP;
    const top = y + GAP + el.offsetHeight > window.innerHeight ? y - GAP - el.offsetHeight : y + GAP;
    el.style.transform = `translate(${Math.max(GAP, left)}px, ${Math.max(GAP, top)}px)`;
  };

  useLayoutEffect(place, [reading]);

  useEffect(() => {
    const roles = readRoles();
    const root = document.documentElement;
    root.setAttribute("data-type-inspect", "");
    let frame = 0;

    const update = () => {
      frame = 0;
      const found = textAt(point.current.x, point.current.y);
      if (outline.current) {
        outline.current.hidden = !found;
        if (found) {
          outline.current.style.transform = `translate(${found.box.left}px, ${found.box.top}px)`;
          outline.current.style.width = `${found.box.width}px`;
          outline.current.style.height = `${found.box.height}px`;
        }
      }
      setReading(found ? read(found.element, roles) : null);
      place();
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    const move = (event: PointerEvent) => {
      point.current = { x: event.clientX, y: event.clientY };
      schedule();
    };
    const swallow = (event: Event) => {
      if (event.target instanceof Element && event.target.closest(EXEMPT)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onExit();
    };

    // On window, so they run before anything on document: Radix closes a dialog on Esc in document's capture phase.
    window.addEventListener("pointermove", move, true);
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("pointerdown", swallow, true);
    window.addEventListener("click", swallow, true);
    window.addEventListener("keydown", key, true);
    return () => {
      cancelAnimationFrame(frame);
      root.removeAttribute("data-type-inspect");
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("pointerdown", swallow, true);
      window.removeEventListener("click", swallow, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [onExit]);

  return createPortal(
    <>
      <div ref={outline} className={styles.outline} hidden />
      <div ref={card} className={styles.card} hidden={!reading} data-off={reading && !reading.role ? "" : undefined}>
        {reading ? (
          <>
            <p className={styles.role}>{reading.role ?? "Off scale"}</p>
            {reading.near ? <p className={styles.near}>{reading.near}</p> : null}
            <dl className={styles.facts}>
              <dt>Size</dt><dd>{round(reading.size)} px</dd>
              <dt>Line</dt><dd>{reading.lineLabel}</dd>
              <dt>Weight</dt><dd>{reading.weight}</dd>
              <dt>Tracking</dt><dd>{round(reading.tracking, 3)}em</dd>
              <dt>Family</dt><dd>{reading.family}</dd>
            </dl>
          </>
        ) : null}
      </div>
    </>,
    document.body,
  );
}
