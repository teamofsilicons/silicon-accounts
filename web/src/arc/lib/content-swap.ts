/**
 * Crossfades arbitrary Solid children when they change (Arc's keyed AnimatePresence around a label).
 * A MutationObserver watches the content element; on a change, a snapshot of the previous content is popped out of
 * flow inside the slot and animates away while the new content animates in. Text rises from a soft blur; icon-only
 * content pops on a spring. The snapshot is aria-hidden and inert, so assistive tech only reads the live content.
 */
import { onCleanup, onMount } from "solid-js";
import { animate, prefersReducedMotion, presets, tween, type AnimationControls } from "./motion";

export interface ContentSwapOptions {
  /** Called when a swap starts (for example to arm a width morph). */
  onSwap?: () => void;
  /** Override the default enter/exit animations. */
  enter?: (el: HTMLElement, iconOnly: boolean) => AnimationControls | void;
  exit?: (el: HTMLElement, iconOnly: boolean) => AnimationControls | void;
}

const isIconOnly = (el: Element) => !/\S/.test(el.textContent ?? "") && !!el.querySelector("svg, img");

export function createContentSwap(slot: () => HTMLElement | undefined, content: () => HTMLElement | undefined, options: ContentSwapOptions = {}) {
  onMount(() => {
    const target = content();
    const host = slot();
    if (!target || !host || typeof MutationObserver === "undefined") return;
    let snapshot = target.cloneNode(true) as HTMLElement;
    let lastKey = keyOf(target);
    const observer = new MutationObserver(() => {
      const key = keyOf(target);
      if (key === lastKey) {
        snapshot = target.cloneNode(true) as HTMLElement;
        return;
      }
      lastKey = key;
      options.onSwap?.();
      const old = snapshot;
      snapshot = target.cloneNode(true) as HTMLElement;
      const iconOnly = isIconOnly(target);
      const wasIconOnly = isIconOnly(old);
      // The outgoing copy leaves from where the content sat, out of flow, so the slot never holds both widths.
      old.removeAttribute("id");
      old.setAttribute("aria-hidden", "true");
      old.setAttribute("inert", "");
      Object.assign(old.style, {
        position: "absolute",
        left: `${target.offsetLeft}px`,
        top: `${target.offsetTop}px`,
        pointerEvents: "none",
      });
      // A cloned node restarts its CSS animations (a drawn check would draw again): finish them at once.
      for (const node of [old, ...Array.from(old.querySelectorAll<HTMLElement>("*"))]) node.style.animationDelay = "-60s";
      host.appendChild(old);
      const leave = options.exit?.(old, wasIconOnly)
        ?? (prefersReducedMotion() ? animate(old, { opacity: 0 }, tween(0)) : wasIconOnly ? presets.iconOut(old) : presets.textOut(old, "-3px"));
      (leave ?? Promise.resolve()).then(() => old.remove());
      options.enter?.(target, iconOnly) ?? (iconOnly ? presets.iconIn(target) : presets.textIn(target, "4px"));
    });
    observer.observe(target, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["data-icon", "class", "d"] });
    onCleanup(() => observer.disconnect());
  });
}

/** Text plus element names, so a new label or icon crossfades while prop-only updates stay still (Arc labelKey). */
function keyOf(el: Element): string {
  let key = "";
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) key += node.textContent ?? "";
    else if (node instanceof Element) {
      const icon = node.getAttribute("data-icon") ?? (node.tagName === "svg" ? (node.getAttribute("class") ?? "svg") : "");
      key += `<${node.tagName}${icon ? `:${icon}` : ""}>${keyOf(node)}`;
    }
  }
  return key;
}
