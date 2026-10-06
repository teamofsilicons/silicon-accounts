"use client";

/**
 * Arc's Combobox with the keyboard behaviour of the WAI-ARIA combobox pattern, for the sign-up page's timezone:
 *
 *   - focus arriving does not open the list (a Tab walk through the form would otherwise drop it over the date of
 *     birth and "Create account"); typing, ArrowDown or a click opens it, as before;
 *   - the list closes when focus moves on to something outside the field;
 *   - the open list is not a Tab stop (it scrolls, so browsers make it focusable); the arrow keys reach its options.
 *
 * Arc's Combobox opens on focus and closes only on an outside press, Escape or a choice (a request to the foundation
 * to fix it there). This wrapper adds the rest from outside, without touching Arc's look, motion or markup: focus
 * events stop at the wrapper before Arc's handler, leaving sends Arc its own Escape, and the listbox gets
 * tabindex="-1" when it appears.
 */
import { useEffect, useRef } from "react";
import { Combobox, type ComboboxProps } from "@/components/arc/combobox/combobox";
import styles from "./flow.module.css";

export function ComboboxField(props: ComboboxProps) {
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = root.current;
    if (!node) return;
    const quiet = () => {
      for (const list of node.querySelectorAll('[role="listbox"]:not([tabindex])')) list.setAttribute("tabindex", "-1");
    };
    quiet();
    const observer = new MutationObserver(quiet);
    observer.observe(node, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  /** Closes the list the way Escape does in Arc (it also forgets the half-typed search). */
  const close = () => {
    const input = root.current?.querySelector<HTMLInputElement>('input[role="combobox"]');
    if (input?.getAttribute("aria-expanded") === "true") input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  };

  return (
    <div
      ref={root}
      className={styles.comboboxField}
      onFocusCapture={event => {
        // Arc opens the list on focus; here a click, typing or ArrowDown opens it instead.
        if ((event.target as Element).getAttribute("role") === "combobox") event.stopPropagation();
      }}
      onBlur={event => {
        // Focus went to something else on the page (not to nothing: a press outside already closes the list in Arc).
        const next = event.relatedTarget as Node | null;
        if (next && !root.current?.contains(next)) close();
      }}
    >
      <Combobox {...props} />
    </div>
  );
}
