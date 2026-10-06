/**
 * Escape inside a drawer or a popover belongs to the control that has focus when that control has something of its own
 * to close: an open timezone list, an open calendar, a name being edited, a confirm question being asked. Only the
 * next Escape closes the layer.
 *
 * Radix closes its layers from a capture listener on the document, before the control's own key handler runs, so the
 * layer has to be told to leave this Escape alone:
 *
 *   <DrawerContent {...escapeLayer} …>      // or PopoverContent
 *
 * (Arc's Combobox list, DatePicker calendar, InlineEdit and ConfirmMorph are not layers of their own; a request asks
 * Arc to make them so, which would make this unnecessary.)
 */
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

/** Marks the layer's own panel, where the search for an inner control stops. */
const ROOT = "data-escape-layer";

/** Controls that close something of their own on Escape while focus is in them. */
const OWN_ESCAPE = [
  // Arc Combobox with its list open (focus stays in its input).
  '[role="combobox"][aria-expanded="true"]',
  // Arc DatePicker's trigger while its calendar is open.
  '[aria-haspopup="dialog"][aria-expanded="true"]',
  // Arc InlineEdit while editing: Escape puts the saved text back.
  "[data-editing]",
].join(", ");

/** Arc ConfirmMorph asking its question or showing a result (Escape returns it to rest). */
const MORPH_STATES = '[data-state="confirming"], [data-state="done"], [data-state="error"]';

/** True when Escape at `target` is handled by a control inside the layer, which closes its own part first. */
export function escapeBelongsInside(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest(OWN_ESCAPE)) return true;
  // A ConfirmMorph's root (focused while it works or shows a result) or one of its faces. A HoldToConfirm button also
  // says data-state="done", but it has no faces and no Escape of its own.
  const morph = target.closest(MORPH_STATES);
  if (morph?.querySelector("[data-face]")) return true;
  // A popup of a control (Arc DatePicker's calendar is a dialog inside the layer); the layer's own panel is not one.
  const dialog = target.closest('[role="dialog"]');
  return !!dialog && !dialog.hasAttribute(ROOT);
}

/** For Radix's onEscapeKeyDown: keeps the layer open when the Escape belongs to a control inside it. */
export function keepEscapeInside(event: KeyboardEvent | ReactKeyboardEvent): void {
  if (escapeBelongsInside(event.target)) event.preventDefault();
}

/** Spread onto DrawerContent or PopoverContent. */
export const escapeLayer = { [ROOT]: "", onEscapeKeyDown: keepEscapeInside } as const;
