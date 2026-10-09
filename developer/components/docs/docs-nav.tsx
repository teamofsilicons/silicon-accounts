/**
 * The docs navigation (server-rendered): Overview, the two products, then the current product's Start / Learn /
 * Reference groups with their pages in order, a page's own pages (the API reference's parts) indented under it. The page
 * being read is marked (aria-current) and its group's heading links to the group's page. Rendered in the sidebar and,
 * below 1024 px, in the header's menu; `idPrefix` keeps ids unique between the two copies. Plain links: a docs page is a
 * full HTML document.
 */
import type { NavGroup, NavItem } from "@/lib/docs/types";
import { DOCS_BASE, PRODUCTS } from "@/lib/docs/site";
import styles from "./docs-nav.module.css";

export type DocsNavData = NavGroup[];

function normalize(path: string) {
  return path.replace(/\/+$/, "") || "/";
}

function Item({ item, current }: { item: NavItem; current: string }) {
  const active = normalize(item.href) === current;
  const inside = item.children.some(child => normalize(child.href) === current);
  return (
    <li>
      <a href={item.href} className={styles.link} data-sq="surface" aria-current={active ? "page" : undefined} data-inside={inside ? "" : undefined}>
        {item.title}
      </a>
      {item.children.length ? (
        <ul className={styles.children} role="list">
          {item.children.map(child => <Item key={child.path} item={child} current={current} />)}
        </ul>
      ) : null}
    </li>
  );
}

export function DocsNav({ groups, current: currentPath, idPrefix, className, label = "Docs" }: { groups: DocsNavData; current: string; idPrefix: string; className?: string; label?: string }) {
  const current = normalize(currentPath);
  const product = PRODUCTS.find(item => current === `${DOCS_BASE}/${item.key}` || current.startsWith(`${DOCS_BASE}/${item.key}/`));
  const visibleGroups = groups.filter(group => product && group.key.startsWith(`${product.key}/`));
  return (
    <nav className={className ? `${styles.nav} ${className}` : styles.nav} aria-label={label} data-docs-nav="">
      <ul className={styles.top} role="list">
        <li>
          <a href={DOCS_BASE} className={styles.link} data-sq="surface" aria-current={current === DOCS_BASE ? "page" : undefined}>
            Overview
          </a>
        </li>
      </ul>
      <ul className={styles.products} role="list" aria-label="Documentation products">
        {PRODUCTS.map(item => (
          <li key={item.key}>
            <a href={`${DOCS_BASE}/${item.key}`} data-sq="surface" className={styles.product} aria-current={current === `${DOCS_BASE}/${item.key}` ? "page" : product?.key === item.key ? "true" : undefined}>
              {item.label}
            </a>
          </li>
        ))}
      </ul>
      {visibleGroups.map(group => {
        const groupActive = group.href !== null && normalize(group.href) === current;
        const items = group.items.filter(item => item.href !== DOCS_BASE);
        const id = `${idPrefix}-${group.key.replace(/[^a-z0-9]+/gi, "-")}`;
        return (
          <section key={group.key} className={styles.group} aria-labelledby={id}>
            {group.href ? (
              <a id={id} href={group.href} className={styles.groupTitle} aria-current={groupActive ? "page" : undefined}>
                {group.label.split(" · ").at(-1)}
              </a>
            ) : (
              <h2 id={id} className={styles.groupTitle}>{group.label.split(" · ").at(-1)}</h2>
            )}
            <ul className={styles.list} role="list">
              {items.map(item => <Item key={item.path} item={item} current={current} />)}
            </ul>
          </section>
        );
      })}
    </nav>
  );
}
