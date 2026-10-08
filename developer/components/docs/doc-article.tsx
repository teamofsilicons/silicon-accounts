/**
 * One docs page (server): its header (where it sits, title, lede, and kind),
 * "On this page", the body, the related pages from its front matter (instructions link to explanations and back),
 * and the previous and next page. The landing page (docs/index.md) adds every page, grouped, at the end.
 */
import Link from "next/link";
import { ArrowLeft, ArrowRight, ChevronRight } from "lucide-react";
import { docs, findPageByPath, groupPages, neighbours, parsedPage, type DocPage } from "@/lib/docs/content";
import { DOCS_BASE, sectionInfo, productOf, productLabel } from "@/lib/docs/site";
import { DocsTocDisclosure, DocsTocRail } from "./docs-toc";
import { Markdown } from "./markdown";
import styles from "./doc-article.module.css";

/** What kind of page this is, in the docs' own words. */
export function kindLabel(page: DocPage): string {
  if (page.group.endsWith("reference")) return "Reference";
  if (page.group.endsWith("overview")) return "Overview";
  return page.kind === "instructive" ? "Instructions" : "Explanation";
}

function Crumbs({ page }: { page: DocPage }) {
  const parent = page.parent ? findPageByPath(page.parent) : null;
  const group = sectionInfo(page.group);
  return (
    <nav aria-label="Breadcrumb" className={styles.crumbs}>
      <ol role="list">
        <li><Link href={DOCS_BASE}>Docs</Link></li>
        {productOf(page.path) ? <li><ChevronRight size={13} strokeWidth={1.75} aria-hidden="true" /><Link href={`${DOCS_BASE}/${productOf(page.path)}`}>{productLabel(page.path)}</Link></li> : null}
        {group ? (
          <li>
            <ChevronRight size={13} strokeWidth={1.75} aria-hidden="true" />
            <Link href={`${DOCS_BASE}/${group.key}`}>{group.label}</Link>
          </li>
        ) : null}
        {parent ? (
          <li>
            <ChevronRight size={13} strokeWidth={1.75} aria-hidden="true" />
            <Link href={parent.href}>{parent.title}</Link>
          </li>
        ) : null}
      </ol>
    </nav>
  );
}

function PageCard({ page, showKind = true }: { page: DocPage; showKind?: boolean }) {
  return (
    <Link href={page.href} className={styles.card} data-sq="surface">
      {showKind ? <span className={styles.cardKind}>{page.groupLabel} · {kindLabel(page)}</span> : null}
      <span className={styles.cardTitle}>{page.title}</span>
      {page.description ? <span className={styles.cardText}>{page.description}</span> : null}
    </Link>
  );
}

function Pager({ page }: { page: DocPage }) {
  const { previous, next } = neighbours(page);
  if (!previous && !next) return null;
  return (
    <nav className={styles.pager} aria-label="Previous and next page">
      {previous ? (
        <Link href={previous.href} className={styles.pagerLink} data-sq="surface" rel="prev">
          <span className={styles.pagerLabel}><ArrowLeft size={14} strokeWidth={1.75} aria-hidden="true" />Previous</span>
          <span className={styles.pagerTitle}>{previous.title}</span>
        </Link>
      ) : <span />}
      {next ? (
        <Link href={next.href} className={styles.pagerLink} data-next="" data-sq="surface" rel="next">
          <span className={styles.pagerLabel}>Next<ArrowRight size={14} strokeWidth={1.75} aria-hidden="true" /></span>
          <span className={styles.pagerTitle}>{next.title}</span>
        </Link>
      ) : null}
    </nav>
  );
}

function EveryPage() {
  const groups = docs().nav.filter(group => group.href);
  return (
    <section className={styles.everyPage} aria-labelledby="every-page">
      <h2 id="every-page" className={styles.sectionTitle}>Every page</h2>
      <div className={styles.everyGroups}>
        {groups.map(group => (
          <div key={group.key} className={styles.everyGroup}>
            <h3 className={styles.everyGroupTitle}><Link href={group.href!}>{group.label}</Link></h3>
            <p className={styles.everyGroupText}>{sectionInfo(group.key)?.summary}</p>
            <ul role="list" className={styles.everyList}>
              {groupPages(group.key).map(page => (
                <li key={page.path} data-child={page.parent ? "" : undefined}><Link href={page.href}>{page.title}</Link></li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

export function DocArticle({ page }: { page: DocPage }) {
  const parsed = parsedPage(page);
  const landing = page.path === "index.md";
  const related = page.related.map(path => findPageByPath(path)).filter((entry): entry is DocPage => entry !== null && entry.path !== page.path);
  return (
    <div className={styles.layout}>
      <article className={styles.article}>
        <header className={styles.head}>
          {landing ? <p className={styles.eyebrow}>Documentation</p> : <Crumbs page={page} />}
          <h1 className={landing ? `${styles.title} ${styles.landingTitle}` : styles.title}>{page.title}</h1>
          {page.description ? <p className={styles.lede}>{page.description}</p> : null}
          {landing ? null : (
            <div className={styles.meta}>
              <span className={styles.kind} data-sq="surface" data-kind={page.group.endsWith("reference") ? "reference" : page.kind}>{kindLabel(page)}</span>
            </div>
          )}
        </header>

        <div className={styles.tocInline}>
          <DocsTocDisclosure items={parsed.toc} />
        </div>

        <Markdown blocks={parsed.blocks} from={page.path} />

        {landing ? <EveryPage /> : null}

        {related.length ? (
          <section className={styles.related} aria-labelledby="related-pages">
            <h2 id="related-pages" className={styles.sectionTitle}>Related</h2>
            <div className={styles.cards}>
              {related.map(entry => <PageCard key={entry.path} page={entry} />)}
            </div>
          </section>
        ) : null}

        <Pager page={page} />
      </article>
      <aside className={styles.rail} aria-label="Page tools">
        <DocsTocRail items={parsed.toc} />
      </aside>
    </div>
  );
}

/** /docs/start, /docs/learn, /docs/reference: the group's purpose and its pages. */
export function GroupPage({ group }: { group: string }) {
  const info = sectionInfo(group);
  const pages = groupPages(group);
  const label = pages[0]?.groupLabel ?? info?.label ?? group;
  const top = pages.filter(page => !page.parent || !pages.some(other => other.path === page.parent));
  return (
    <div className={styles.layout} data-single="">
      <article className={styles.article}>
        <header className={styles.head}>
          <nav aria-label="Breadcrumb" className={styles.crumbs}>
            <ol role="list"><li><Link href={DOCS_BASE}>Docs</Link></li></ol>
          </nav>
          <h1 className={styles.title}>{label}</h1>
          {info ? <p className={styles.lede}>{info.summary}</p> : null}
        </header>
        <ul className={styles.groupList} role="list">
          {top.map(page => {
            const children = pages.filter(child => child.parent === page.path);
            return (
              <li key={page.path}>
                <PageCard page={page} showKind={false} />
                {children.length ? (
                  <ul className={styles.groupChildren} role="list">
                    {children.map(child => <li key={child.path}><PageCard page={child} showKind={false} /></li>)}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      </article>
    </div>
  );
}
