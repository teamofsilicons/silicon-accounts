"use client";

/**
 * The sign-in methods of an app, in the order the sign-in page shows them. Each row switches a method on or off; the
 * handle reorders it: drag it (the other rows glide out of the way, Motion's Reorder), or focus it and use the arrow
 * keys, Home and End. Every move is announced.
 */
import { useState, type KeyboardEvent, type ReactNode } from "react";
import { Reorder, useDragControls, useReducedMotion } from "motion/react";
import { GripVertical } from "lucide-react";
import { Switch } from "@/components/silicon-ui/switch/switch";
import { motionTokens } from "@/components/silicon-ui/lib/motion-tokens";
import type { SigninMethod } from "@/lib/api/types";
import { METHOD_DESCRIPTION, METHOD_LABEL } from "../lib/labels";
import { MethodMark } from "../parts/provider-marks";
import styles from "./sign-in.module.css";

export interface MethodRowInfo {
  /** One line under the name (mode, client). */
  status?: ReactNode;
  /** Shown when the method is on but cannot work as set up. */
  warning?: string | null;
}

interface RowProps {
  method: SigninMethod;
  index: number;
  count: number;
  on: boolean;
  info: MethodRowInfo;
  reduced: boolean;
  onToggle: (on: boolean) => void;
  onKeyMove: (method: SigninMethod, event: KeyboardEvent<HTMLButtonElement>) => void;
}

function MethodRow({ method, index, count, on, info, reduced, onToggle, onKeyMove }: RowProps) {
  const controls = useDragControls();
  const [dragging, setDragging] = useState(false);
  const nameId = `method-${method}`;
  return (
    <Reorder.Item
      as="li"
      value={method}
      data-sq="surface"
      className={styles.methodRow}
      data-method={method}
      data-on={on || undefined}
      data-dragging={dragging || undefined}
      dragListener={false}
      dragControls={controls}
      onDragStart={() => setDragging(true)}
      onDragEnd={() => setDragging(false)}
      transition={reduced ? { duration: 0 } : motionTokens.spring.smooth}
    >
      <button
        type="button"
        data-sq="surface"
        className={styles.handle}
        data-handle={method}
        aria-label={`Move ${METHOD_LABEL[method]}, position ${index + 1} of ${count}. Use the up and down arrow keys.`}
        aria-roledescription="sortable handle"
        onPointerDown={event => {
          event.preventDefault();
          controls.start(event);
        }}
        onKeyDown={event => onKeyMove(method, event)}
      >
        <GripVertical size={16} strokeWidth={1.75} aria-hidden="true" />
      </button>
      <span className={styles.methodIcon} aria-hidden="true"><MethodMark method={method} /></span>
      <span className={styles.methodText}>
        <span className={styles.methodName} id={nameId}>{METHOD_LABEL[method]}</span>
        <span className={styles.methodDescription}>{info.status ?? METHOD_DESCRIPTION[method]}</span>
        {on && info.warning ? <span className={styles.methodWarning}>{info.warning}</span> : null}
      </span>
      <Switch aria-labelledby={nameId} checked={on} onCheckedChange={onToggle} />
    </Reorder.Item>
  );
}

export interface MethodListProps {
  order: SigninMethod[];
  enabled: Record<SigninMethod, boolean>;
  onToggle: (method: SigninMethod, on: boolean) => void;
  onReorder: (order: SigninMethod[]) => void;
  info: (method: SigninMethod) => MethodRowInfo;
  error?: string;
}

export function MethodList({ order, enabled, onToggle, onReorder, info, error }: MethodListProps) {
  const reduced = !!useReducedMotion();
  const [announcement, setAnnouncement] = useState("");

  const onKeyMove = (method: SigninMethod, event: KeyboardEvent<HTMLButtonElement>) => {
    const from = order.indexOf(method);
    const to = event.key === "ArrowUp" ? from - 1 : event.key === "ArrowDown" ? from + 1 : event.key === "Home" ? 0 : event.key === "End" ? order.length - 1 : null;
    if (to === null) return;
    event.preventDefault();
    if (to < 0 || to >= order.length || to === from) return;
    const next = [...order];
    next.splice(from, 1);
    next.splice(to, 0, method);
    onReorder(next);
    setAnnouncement(`${METHOD_LABEL[method]} moved to position ${to + 1} of ${next.length}.`);
    const handle = event.currentTarget;
    // The row moves in the DOM; keep the keyboard on its handle.
    requestAnimationFrame(() => handle.focus());
  };

  return (
    <div className={styles.methods}>
      <Reorder.Group
        as="ul"
        axis="y"
        values={order}
        onReorder={next => onReorder(next as SigninMethod[])}
        data-sq="surface"
        className={styles.methodList}
        aria-label="Sign-in methods, in the order they are shown"
      >
        {order.map((method, index) => (
          <MethodRow
            key={method}
            method={method}
            index={index}
            count={order.length}
            on={enabled[method]}
            info={info(method)}
            reduced={reduced}
            onToggle={on => onToggle(method, on)}
            onKeyMove={onKeyMove}
          />
        ))}
      </Reorder.Group>
      {error ? <p className={styles.fieldError} role="alert">{error}</p> : null}
      <p className="sr-only" role="status">{announcement}</p>
    </div>
  );
}
