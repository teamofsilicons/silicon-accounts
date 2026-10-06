/**
 * The sign-in methods of an app, in the order the sign-in page shows them. Each row switches a method on or off; the
 * handle reorders it (drag it, or focus it and use the arrow keys). Other rows make room while a row is dragged, and
 * the order is committed on drop, so the list never reflows under the pointer.
 */
import { For, Show, createSignal, type JSX } from "solid-js";
import { GripVertical, Mail, Smartphone } from "lucide-solid";
import type { SigninMethod } from "../../../api";
import { AppleMark, GoogleMark } from "../../../arc/blocks/sign-in/sign-in";
import { Switch } from "../../../arc/switch/switch";
import { createFlip } from "../../../arc/lib/flip";
import { prefersReducedMotion, spring } from "../../../arc/lib/motion";
import { useSquircle } from "../../../arc/lib/squircle";
import { METHOD_DESCRIPTION, METHOD_LABEL } from "../lib/labels";
import styles from "./signin.module.css";

export interface MethodRowInfo {
  /** One line under the description (mode, client), and a warning when the method cannot work as set up. */
  status?: JSX.Element;
  warning?: string | null;
}

const ICONS: Record<SigninMethod, () => JSX.Element> = {
  google: () => <GoogleMark size={18} />,
  apple: () => <AppleMark size={18} />,
  email: () => <Mail size={18} stroke-width={1.75} />,
  phone: () => <Smartphone size={18} stroke-width={1.75} />,
};

export function MethodList(props: {
  order: SigninMethod[];
  enabled: Record<SigninMethod, boolean>;
  onToggle: (method: SigninMethod, on: boolean) => void;
  onReorder: (order: SigninMethod[]) => void;
  info: (method: SigninMethod) => MethodRowInfo;
  error?: string | null;
}) {
  let list: HTMLUListElement | undefined;
  const flip = createFlip(() => list, "li[data-method]", el => el.dataset.method ?? null);
  const [announcement, setAnnouncement] = createSignal("");
  const [dragging, setDragging] = createSignal<SigninMethod | null>(null);

  const move = (method: SigninMethod, to: number, animate = true) => {
    const from = props.order.indexOf(method);
    if (from < 0 || to < 0 || to >= props.order.length || to === from) return;
    const next = [...props.order];
    next.splice(from, 1);
    next.splice(to, 0, method);
    if (animate) flip.capture();
    props.onReorder(next);
    if (animate) flip.play(spring.smooth);
    setAnnouncement(`${METHOD_LABEL[method]} moved to position ${to + 1} of ${next.length}.`);
  };

  /* Pointer drag: the row follows the pointer; the rows it passes slide aside; the new order lands on release. */
  const startDrag = (method: SigninMethod, event: PointerEvent) => {
    if (event.button !== 0 || !list) return;
    const rows = Array.from(list.querySelectorAll<HTMLElement>("li[data-method]"));
    const index = rows.findIndex(row => row.dataset.method === method);
    const row = rows[index];
    if (!row) return;
    event.preventDefault();
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);
    const tops = rows.map(item => item.offsetTop);
    const heights = rows.map(item => item.offsetHeight);
    const span = (heights[index] ?? 0) + (rows.length > 1 ? Math.max(0, (tops[1] ?? 0) - (tops[0] ?? 0) - (heights[0] ?? 0)) : 0);
    const startY = event.clientY;
    let target = index;
    setDragging(method);
    row.dataset.dragging = "";
    const onMove = (moveEvent: PointerEvent) => {
      const max = (tops[rows.length - 1] ?? 0) - (tops[index] ?? 0);
      const min = -(tops[index] ?? 0);
      const dy = Math.min(max, Math.max(min, moveEvent.clientY - startY));
      row.style.translate = `0 ${dy}px`;
      const center = (tops[index] ?? 0) + (heights[index] ?? 0) / 2 + dy;
      target = index;
      rows.forEach((_, i) => {
        const middle = (tops[i] ?? 0) + (heights[i] ?? 0) / 2;
        if (i > index && center > middle) target = i;
        if (i < index && center < middle && target >= index) target = Math.min(target === index ? i : target, i);
      });
      rows.forEach((item, i) => {
        if (i === index) return;
        const shift = target > index && i > index && i <= target ? -span : target < index && i < index && i >= target ? span : 0;
        item.style.translate = shift ? `0 ${shift}px` : "";
      });
    };
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      // Commit without animation: every row already sits where the new order puts it.
      for (const item of rows) {
        item.style.transition = "none";
        item.style.translate = "";
      }
      delete row.dataset.dragging;
      setDragging(null);
      move(method, target, false);
      requestAnimationFrame(() => { for (const item of rows) item.style.transition = ""; });
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  };

  const onHandleKey = (method: SigninMethod, event: KeyboardEvent) => {
    const index = props.order.indexOf(method);
    const target = event.key === "ArrowUp" ? index - 1 : event.key === "ArrowDown" ? index + 1 : event.key === "Home" ? 0 : event.key === "End" ? props.order.length - 1 : null;
    if (target === null) return;
    event.preventDefault();
    move(method, target, !prefersReducedMotion());
    queueMicrotask(() => list?.querySelector<HTMLElement>(`li[data-method="${method}"] [data-handle]`)?.focus());
  };

  return (
    <div class={styles.methods}>
      <ul ref={el => { list = el; useSquircle(el); }} class={styles.methodList} role="list" aria-label="Sign-in methods, in the order they are shown" data-dragging={dragging() ? "" : undefined}>
        <For each={props.order}>
          {(method, index) => (
            <li ref={el => useSquircle(el)} class={styles.methodRow} data-method={method} data-on={props.enabled[method] || undefined}>
              <button
                type="button"
                ref={el => useSquircle(el)}
                class={styles.handle}
                data-handle=""
                aria-label={`Move ${METHOD_LABEL[method]}, position ${index() + 1} of ${props.order.length}. Use the up and down arrow keys.`}
                aria-roledescription="sortable handle"
                onPointerDown={event => startDrag(method, event)}
                onKeyDown={event => onHandleKey(method, event)}
              >
                <GripVertical size={16} stroke-width={1.75} aria-hidden="true" />
              </button>
              <span class={styles.methodIcon} aria-hidden="true">{ICONS[method]()}</span>
              <span class={styles.methodText}>
                <span class={styles.methodName} id={`method-${method}`}>{METHOD_LABEL[method]}</span>
                <span class={styles.methodDescription}>{props.info(method).status ?? METHOD_DESCRIPTION[method]}</span>
                <Show when={props.enabled[method] && props.info(method).warning}>{warning => <span class={styles.methodWarning}>{warning()}</span>}</Show>
              </span>
              <Switch aria-labelledby={`method-${method}`} checked={props.enabled[method]} onChange={on => props.onToggle(method, on)} />
            </li>
          )}
        </For>
      </ul>
      <Show when={props.error}><p class={styles.fieldError} role="alert">{props.error}</p></Show>
      <p class="sr-only" role="status">{announcement()}</p>
    </div>
  );
}
