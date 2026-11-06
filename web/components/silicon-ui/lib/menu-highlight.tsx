"use client";

import { useRef } from "react";
import type { FocusEvent, MouseEvent } from "react";
import { motion, useReducedMotion } from "motion/react";
import { FluidHoverHighlight, useFluidHover, type FluidRect } from "./fluid-hover";
import { motionTokens } from "./motion-tokens";

/** A fluid hover highlight in a menu: where it sits, whether it travels, its pointer session, and its tone. */
type FluidHighlight = { rect: FluidRect | null; glide: boolean; session: number; danger: boolean };
/** A marker positioned by top and height only (a list's current-page marker). */
type BarHighlight = { top: number; height: number; danger: boolean; glide: boolean };

const ITEMS = '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="option"]';

/**
 * Fluid hover for a Radix menu or listbox (lib/fluid-hover): the item nearest the pointer is lit, gaps and padding
 * included, a click in a gap picks the lit item, and the keyboard moves the highlight with Radix's focus, without travel.
 * Spread `contentProps` on the content, call `reset` when it opens, and render `<MenuHighlight state={highlight} … />`
 * as its first child. Items mark a destructive tone with `data-tone="danger"`.
 */
export function useMenuHighlight(itemSelector = ITEMS) {
  // The content element is taken from its own events, so the hook never competes with the content's ref.
  const content = useRef<HTMLElement | null>(null);
  const hover = useFluidHover(content, { items: itemSelector });
  const own = (event: { currentTarget: EventTarget }) => { content.current = event.currentTarget as HTMLElement; };
  const { handlers } = hover;
  const highlight: FluidHighlight = { rect: hover.rect, glide: hover.glide, session: hover.session, danger: hover.item?.dataset.tone === "danger" };
  return {
    highlight,
    reset: hover.reset,
    contentProps: {
      onMouseEnter: (event: MouseEvent<HTMLElement>) => { own(event); handlers.onMouseEnter(); },
      onMouseMove: (event: MouseEvent<HTMLElement>) => { own(event); handlers.onMouseMove(event); },
      onMouseLeave: handlers.onMouseLeave,
      onKeyDownCapture: handlers.onKeyDownCapture,
      onFocus: (event: FocusEvent<HTMLElement>) => { own(event); handlers.onFocus(event); },
      onBlur: handlers.onBlur,
      onClick: (event: MouseEvent<HTMLElement>) => { own(event); handlers.onClick(event); },
    },
  };
}

/** The highlight itself: the fluid hover highlight, or a marker that moves by top and height (a current-page marker). */
export function MenuHighlight({ state, className }: { state: FluidHighlight | BarHighlight | null; className?: string }) {
  if (state && "session" in state) return <FluidHoverHighlight hover={state} className={className} tone={state.danger ? "danger" : undefined} />;
  return <BarMarker state={state} className={className} />;
}

function BarMarker({ state, className }: { state: BarHighlight | null; className?: string }) {
  const reduced = useReducedMotion();
  return <motion.span className={className} data-tone={state?.danger ? "danger" : undefined} aria-hidden="true" initial={false}
    animate={state ? { y: state.top, height: state.height, opacity: 1 } : { opacity: 0 }}
    transition={{ default: state?.glide && !reduced ? motionTokens.spring.fast : { duration: 0 }, opacity: { duration: reduced ? 0 : motionTokens.duration.fast } }} />;
}
