import type { JSX } from "solid-js";

/**
 * Solid JSX values are real DOM nodes, so a prop rendered in two places (a select's option and its trigger, a card and
 * its quick look) would be moved, not copied. Components that show a JSX prop more than once accept either a node or a
 * function; this returns a fresh copy for each use: functions are called again, nodes are deep-cloned (a static
 * snapshot, which is what icons, logos and avatars are), and text passes through.
 */
export function freshJSX(value: JSX.Element | (() => JSX.Element) | undefined | null): JSX.Element {
  if (value === undefined || value === null || value === false) return undefined;
  if (typeof value === "function") return (value as () => JSX.Element)();
  if (Array.isArray(value)) return value.map(item => freshJSX(item as JSX.Element));
  if (typeof Node !== "undefined" && value instanceof Node) return value.cloneNode(true) as unknown as JSX.Element;
  return value;
}
