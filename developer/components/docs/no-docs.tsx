/**
 * The docs' two empty states (server): an address with no page (the docs' 404), and a build without docs (the
 * bundle is empty because lib/docs/build.ts did not run or found no docs/ directory).
 */
import { docs } from "@/lib/docs/content";
import { DOCS_BASE } from "@/lib/docs/site";
import styles from "./doc-article.module.css";
import extra from "./no-docs.module.css";

export function DocsNotFound() {
  const groups = docs().nav.filter(group => group.href);
  return (
    <div className={styles.layout} data-single="">
      <article className={styles.article}>
        <header className={styles.head}>
          <p className={styles.eyebrow}>404</p>
          <h1 className={styles.title}>No page here</h1>
          <p className={styles.lede}>
            Nothing in the docs lives at this address: the page may have moved or been renamed. <a href="/docs/search">Search
            the docs</a> (⌘K or /), or start from one of the groups below.
          </p>
        </header>
        <ul className={extra.groups} role="list">
          <li><a href={DOCS_BASE} className={styles.card} data-sq="surface"><span className={styles.cardTitle}>Overview</span><span className={styles.cardText}>Silicon Apps and Silicon Accounts guides, concepts, and reference.</span></a></li>
          {groups.map(group => (
            <li key={group.key}>
              <a href={group.href!} className={styles.card} data-sq="surface">
                <span className={styles.cardTitle}>{group.label}</span>
                <span className={styles.cardText}>{group.items.length} page{group.items.length === 1 ? "" : "s"}: {group.items.slice(0, 3).map(item => item.title).join(", ")}{group.items.length > 3 ? ", …" : ""}</span>
              </a>
            </li>
          ))}
        </ul>
      </article>
    </div>
  );
}

export function NoDocs() {
  return (
    <div className={styles.layout} data-single="">
      <article className={styles.article}>
        <header className={styles.head}>
          <p className={styles.eyebrow}>Docs</p>
          <h1 className={styles.title}>This build has no docs</h1>
          <p className={styles.lede}>
            The site bundles the Markdown under the repository&apos;s docs/ when it is built. This build found none: run{" "}
            <code className={extra.code} data-sq-native="">pnpm build:docs</code> in developer/ (pnpm dev and pnpm build run it first), or set
            ACCOUNTS_DOCS_DIR and APPS_DOCS_DIR to their documentation directories, then build again.
          </p>
        </header>
      </article>
    </div>
  );
}
