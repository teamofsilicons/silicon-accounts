/**
 * "On this page": the page's h2 and h3 headings (server-rendered). On wide screens it is a rail beside the article;
 * below 1280 px the same list is a <details> disclosure at the top of the article. The docs' one script island
 * (docs-enhancer.tsx) marks the section being read on both lists (aria-current="location") as you scroll.
 */
import { ArrowUp, ChevronDown } from "lucide-react";
import type { TocItem } from "@/lib/docs/types";
import styles from "./docs-toc.module.css";

function TocList({ items }: { items: TocItem[] }) {
  return (
    <ol className={styles.list} role="list">
      {items.map(item => (
        <li key={item.id} data-depth={item.depth}>
          <a href={`#${item.id}`} className={styles.link}>{item.text}</a>
        </li>
      ))}
    </ol>
  );
}

/** The rail beside the article (1280 px and wider). */
export function DocsTocRail({ items }: { items: TocItem[] }) {
  return (
    <nav className={styles.rail} aria-label="On this page" data-toc="">
      {items.length ? (
        <>
          <p className={styles.title}>On this page</p>
          <div className={styles.scroller} data-toc-scroller="">
            <TocList items={items} />
          </div>
        </>
      ) : null}
      <div className={styles.extras}>
        <a href="#top" className={styles.extra}>
          <ArrowUp size={14} strokeWidth={1.75} aria-hidden="true" />
          Back to top
        </a>
      </div>
    </nav>
  );
}

/** The disclosure at the top of the article (narrower than 1280 px). */
export function DocsTocDisclosure({ items }: { items: TocItem[] }) {
  if (items.length < 2) return null;
  return (
    <details className={styles.disclosure} data-sq="surface">
      <summary className={styles.summary}>
        <span className={styles.summaryText}>On this page</span>
        <ChevronDown size={16} strokeWidth={1.75} aria-hidden="true" className={styles.chevron} />
      </summary>
      <nav className={styles.disclosureBody} aria-label="On this page" data-toc="">
        <TocList items={items} />
      </nav>
    </details>
  );
}
