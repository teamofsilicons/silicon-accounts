"use client";
import type { MouseEvent, ReactNode } from "react";
import { Ellipsis, ChevronRight as NavArrowRight } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { DropdownMenuContent, DropdownMenuItem, DropdownMenuRoot, DropdownMenuTrigger } from "../dropdown-menu/dropdown-menu";
import { SiliconLink } from "../lib/silicon-provider";
import { motionTokens } from "../lib/motion-tokens";
import styles from "./breadcrumb.module.css";
export interface BreadcrumbItem {
  label: string;
  href?: string;
  /** Runs when the crumb is chosen. Without an href the crumb renders as a button, for paths that live in local state. */
  onClick?: (event: MouseEvent<HTMLElement>) => void;
}
export interface BreadcrumbProps {
  /** The path from the top level to the current page, which is the last item. */
  items: BreadcrumbItem[];
  /** The navigation landmark's name (default "Breadcrumb"). */
  ariaLabel?: string;
  /** Experimental. The most crumbs to show, at least 2. A longer path shows the first crumb, a "…" menu of the levels
   *  between, and the last `maxItems - 1` crumbs. By default the path never collapses. */
  maxItems?: number;
}
/** Crumbs present on first render stay still; crumbs added later slide in from the path before them.
 *  With maxItems, the levels a long path hides move into a "…" menu, where they stay links. */
export function Breadcrumb({ items, ariaLabel = "Breadcrumb", maxItems }: BreadcrumbProps) {
  const reduced = useReducedMotion() ?? false;
  const still = { duration: 0 };
  const path = items.map(item => item.label).join("/");
  // The first crumb and the current page always show. Crumbs keep their index in `items` as their key, so the ones
  // that stay visible never remount when the path collapses or grows.
  const shown = Math.max(2, Math.floor(maxItems ?? Infinity));
  const hidden = items.length > shown ? items.slice(1, items.length - shown + 1) : [];
  const crumb = (key: string, first: boolean, children: ReactNode) => <motion.li key={key}
    layout={reduced ? false : "position"} layoutDependency={path}
    initial={reduced ? false : { opacity: 0, x: -8, filter: `blur(${motionTokens.blur.subtle}px)` }} animate={{ opacity: 1, x: 0, filter: "blur(0px)" }}
    exit={reduced ? { opacity: 0, transition: still } : { opacity: 0, x: -4, filter: `blur(${motionTokens.blur.subtle}px)`, transition: { duration: motionTokens.duration.instant, ease: [...motionTokens.ease.standard] } }}
    transition={reduced ? still : { duration: motionTokens.duration.standard, ease: [...motionTokens.ease.enter], layout: motionTokens.spring.smooth }}>
    {!first && <NavArrowRight width={14} height={14} aria-hidden="true"/>}
    {children}
  </motion.li>;
  const crumbs = items.map((item, index) => {
    const current = index === items.length - 1;
    return crumb(`${item.label}-${index}`, index === 0, !current && item.href ? <SiliconLink href={item.href} data-label={item.label} onClick={item.onClick}>{item.label}</SiliconLink>
      : !current && item.onClick ? <button type="button" data-label={item.label} onClick={item.onClick}>{item.label}</button>
      : <span aria-current={current ? "page" : undefined} data-label={item.label}>{item.label}</span>);
  });
  if (hidden.length) crumbs.splice(1, hidden.length, crumb("more", false, <DropdownMenuRoot>
    <DropdownMenuTrigger asChild><button type="button" className={styles.more} aria-label={`Show ${hidden.length} more ${hidden.length === 1 ? "level" : "levels"}`}><Ellipsis width={16} height={16} aria-hidden="true"/></button></DropdownMenuTrigger>
    <DropdownMenuContent align="start">{hidden.map((item, index) => item.href
      ? <DropdownMenuItem key={`${item.label}-${index + 1}`} asChild onClick={item.onClick}><SiliconLink href={item.href}>{item.label}</SiliconLink></DropdownMenuItem>
      : <DropdownMenuItem key={`${item.label}-${index + 1}`} disabled={!item.onClick} onClick={item.onClick}>{item.label}</DropdownMenuItem>)}
    </DropdownMenuContent>
  </DropdownMenuRoot>));
  return <nav aria-label={ariaLabel}><ol className={styles.list}><AnimatePresence mode="popLayout" initial={false}>{crumbs}</AnimatePresence></ol></nav>;
}
