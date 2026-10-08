"use client";

/**
 * The docs navigation: Overview, then the Start / Learn / Reference groups with their pages in order, a page's own
 * pages (the API reference's parts) indented under it. The page being read is marked (aria-current) and its group's
 * heading links to the group's page. Rendered in the sidebar and, below 1024 px, in the menu drawer.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef } from "react";
import type { NavGroup, NavItem } from "@/lib/docs/types";
import { DOCS_BASE, PRODUCTS } from "@/lib/docs/site";
import styles from "./docs-nav.module.css";

export type DocsNavData = NavGroup[];

function normalize(path: string) {
  return path.replace(/\/+$/, "") || "/";
}

function Item({ item, current, onNavigate }: { item: NavItem; current: string; onNavigate?: () => void }) {
  const active = normalize(item.href) === current;
  const inside = item.children.some(child => normalize(child.href) === current);
  return (
    <li>
      <Link href={item.href} className={styles.link} data-sq="surface" aria-current={active ? "page" : undefined} data-inside={inside ? "" : undefined} onClick={onNavigate}>
        {item.title}
      </Link>
      {item.children.length ? (
        <ul className={styles.children} role="list">
          {item.children.map(child => <Item key={child.path} item={child} current={current} onNavigate={onNavigate} />)}
        </ul>
      ) : null}
    </li>
  );
}

export function DocsNav({ groups, onNavigate, className }: { groups: DocsNavData; onNavigate?: () => void; className?: string }) {
  const current = normalize(usePathname() ?? DOCS_BASE);
  const product = PRODUCTS.find(item => current === `${DOCS_BASE}/${item.key}` || current.startsWith(`${DOCS_BASE}/${item.key}/`));
  const visibleGroups = groups.filter(group => product && group.key.startsWith(`${product.key}/`));
  const root = useRef<HTMLElement>(null);
  // The sidebar and the drawer may both hold a navigation: ids stay unique per copy.
  const idPrefix = `docs-nav-${useId().replace(/:/g, "")}`;

  // Keep the current page in view inside the scrolling sidebar or drawer (long Reference lists), never moving the page.
  useEffect(() => {
    const nav = root.current;
    const active = nav?.querySelector<HTMLElement>("[aria-current='page']");
    if (!nav || !active) return;
    let scroller: HTMLElement | null = nav.parentElement;
    while (scroller && !(scroller.scrollHeight > scroller.clientHeight && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement;
    if (!scroller || scroller === document.scrollingElement || scroller === document.body) return;
    const top = active.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    if (top < scroller.scrollTop + 48 || top > scroller.scrollTop + scroller.clientHeight - 96) scroller.scrollTop = Math.max(0, top - scroller.clientHeight / 3);
  }, [current]);

  return (
    <nav ref={root} className={className ? `${styles.nav} ${className}` : styles.nav} aria-label="Docs">
      <ul className={styles.top} role="list">
        <li>
          <Link href={DOCS_BASE} className={styles.link} data-sq="surface" aria-current={current === DOCS_BASE ? "page" : undefined} onClick={onNavigate}>
            Overview
          </Link>
        </li>
      </ul>
      <ul className={styles.products} role="list" aria-label="Documentation products">
        {PRODUCTS.map(item => <li key={item.key}><Link href={`${DOCS_BASE}/${item.key}`} data-sq="surface" className={styles.link} aria-current={product?.key === item.key ? "true" : undefined} onClick={onNavigate}>{item.label}</Link></li>)}
      </ul>
      {visibleGroups.map(group => {
        const groupActive = group.href !== null && normalize(group.href) === current;
        const items = group.items.filter(item => item.href !== DOCS_BASE);
        return (
          <section key={group.key} className={styles.group} aria-labelledby={`${idPrefix}-${group.key}`}>
            {group.href ? (
              <Link id={`${idPrefix}-${group.key}`} href={group.href} className={styles.groupTitle} aria-current={groupActive ? "page" : undefined} onClick={onNavigate}>
                {group.label}
              </Link>
            ) : (
              <h2 id={`${idPrefix}-${group.key}`} className={styles.groupTitle}>{group.label}</h2>
            )}
            <ul className={styles.list} role="list">
              {items.map(item => <Item key={item.path} item={item} current={current} onNavigate={onNavigate} />)}
            </ul>
          </section>
        );
      })}
    </nav>
  );
}
