/** Small DOM helpers shared by the ported components. */

let idCounter = 0;
/** Stable unique ids for label/description wiring when createUniqueId is not available (outside components). */
export function uid(prefix = "arc"): string {
  idCounter += 1;
  return `${prefix}-${idCounter.toString(36)}`;
}

/** True when the event target is a text field, so global shortcuts never steal keys from typing. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  const type = (target as HTMLInputElement).type;
  return !["button", "checkbox", "radio", "submit", "reset", "range", "color", "file"].includes(type);
}

/** Merges ref callbacks. */
export function mergeRefs<T>(...refs: Array<((el: T) => void) | undefined>): (el: T) => void {
  return el => {
    for (const ref of refs) ref?.(el);
  };
}

/** Is this the macOS/iOS platform (for showing ⌘ instead of Ctrl). */
export function isApplePlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? "";
  return /mac|iphone|ipad|ipod/i.test(platform);
}
