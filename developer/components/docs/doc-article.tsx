/**
 * One docs page (server-rendered): its header (where it sits, title, lede, kind, last change and its Markdown),
 * "On this page", the body, the related pages from its front matter (instructions link to explanations and back), the
 * previous and next page, and its TechArticle and BreadcrumbList JSON-LD. The landing page (lib/docs/landing.md) adds
 * every page, grouped, at the end. Plain links throughout: every docs page is a full HTML document.
 */
import { ArrowLeft, ArrowRight, ChevronRight, FileText } from "lucide-react";
import { docs, findPageByPath, groupPages, neighbours, parsedPage, type DocPage } from "@/lib/docs/content";
import { DOCS_BASE, GITHUB_PUBLISHED, sectionInfo, productOf, productLabel } from "@/lib/docs/site";
import { JsonLd, absolute, breadcrumbLd, techArticleLd, type Crumb } from "@/lib/seo";
import { DocsTocDisclosure, DocsTocRail } from "./docs-toc";
import { Markdown } from "./markdown";
import styles from "./doc-article.module.css";

/** What kind of page this is, in the docs' own words. */
export function kindLabel(page: DocPage): string {
  if (page.group.endsWith("reference")) return "Reference";
  if (page.group.endsWith("overview")) return "Overview";
  return page.kind === "instructive" ? "Instructions" : "Explanation";
}

/** The trail above a page: Docs, its product, its group, its parent page. */
export function crumbsOf(page: DocPage): Crumb[] {
  const crumbs: Crumb[] = [{ name: "Docs", path: DOCS_BASE }];
  const product = productOf(page.path);
  if (product && page.href !== `${DOCS_BASE}/${product}`) crumbs.push({ name: productLabel(page.path), path: `${DOCS_BASE}/${product}` });
  const group = sectionInfo(page.group);
  if (group) crumbs.push({ name: group.label, path: `${DOCS_BASE}/${group.key}` });
  const parent = page.parent ? findPageByPath(page.parent) : null;
  if (parent) crumbs.push({ name: parent.title, path: parent.href });
  return crumbs;
}

const DATE = new Intl.DateTimeFormat("en", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });

function Crumbs({ crumbs }: { crumbs: Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb" className={styles.crumbs}>
      <ol role="list">
        {crumbs.map((crumb, index) => (
          <li key={crumb.path}>
            {index ? <ChevronRight size={13} strokeWidth={1.75} aria-hidden="true" /> : null}
            <a href={crumb.path}>{crumb.name}</a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

function PageCard({ page, showKind = true }: { page: DocPage; showKind?: boolean }) {
  return (
    <a href={page.href} className={styles.card} data-sq="surface">
      {showKind ? <span className={styles.cardKind}>{page.groupLabel} · {kindLabel(page)}</span> : null}
      <span className={styles.cardTitle}>{page.title}</span>
      {page.description ? <span className={styles.cardText}>{page.description}</span> : null}
    </a>
  );
}

function Pager({ page }: { page: DocPage }) {
  const { previous, next } = neighbours(page);
  if (!previous && !next) return null;
  return (
    <nav className={styles.pager} aria-label="Previous and next page">
      {previous ? (
        <a href={previous.href} className={styles.pagerLink} data-sq="surface" rel="prev">
          <span className={styles.pagerLabel}><ArrowLeft size={14} strokeWidth={1.75} aria-hidden="true" />Previous</span>
          <span className={styles.pagerTitle}>{previous.title}</span>
        </a>
      ) : <span />}
      {next ? (
        <a href={next.href} className={styles.pagerLink} data-next="" data-sq="surface" rel="next">
          <span className={styles.pagerLabel}>Next<ArrowRight size={14} strokeWidth={1.75} aria-hidden="true" /></span>
          <span className={styles.pagerTitle}>{next.title}</span>
        </a>
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
          <section key={group.key} className={styles.everyGroup} aria-labelledby={`every-${group.key.replace("/", "-")}`}>
            <h3 id={`every-${group.key.replace("/", "-")}`} className={styles.everyGroupTitle}><a href={group.href!}>{group.label}</a></h3>
            <p className={styles.everyGroupText}>{sectionInfo(group.key)?.summary}</p>
            <ul role="list" className={styles.everyList}>
              {groupPages(group.key).map(page => (
                <li key={page.path} data-child={page.parent ? "" : undefined}><a href={page.href}>{page.title}</a></li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </section>
  );
}

function wordCount(markdown: string): number {
  return markdown.replace(/```[\s\S]*?```/g, " ").split(/\s+/).filter(Boolean).length;
}

export function DocArticle({ page }: { page: DocPage }) {
  const parsed = parsedPage(page);
  const landing = page.path === "index.md";
  const related = page.related.map(path => findPageByPath(path)).filter((entry): entry is DocPage => entry !== null && entry.path !== page.path);
  const crumbs = crumbsOf(page);
  const modified = page.modified ? new Date(page.modified) : null;
  return (
    <div className={styles.layout}>
      <article className={styles.article}>
        <header className={styles.head}>
          {landing ? <p className={styles.eyebrow}>Documentation</p> : <Crumbs crumbs={crumbs} />}
          <h1 className={landing ? `${styles.title} ${styles.landingTitle}` : styles.title}>{page.title}</h1>
          {page.description ? <p className={styles.lede}>{page.description}</p> : null}
          <div className={styles.meta}>
            {landing ? null : <span className={styles.kind} data-sq="surface" data-kind={page.group.endsWith("reference") ? "reference" : page.kind}>{kindLabel(page)}</span>}
            {modified ? <span className={styles.updated}>Updated <time dateTime={page.modified!}>{DATE.format(modified)}</time></span> : null}
            <a className={styles.metaLink} href={page.rawHref} type="text/markdown"><FileText size={14} strokeWidth={1.75} aria-hidden="true" />Markdown</a>
            {GITHUB_PUBLISHED ? <a className={styles.metaLink} href={page.editHref} rel="noopener">Edit on GitHub</a> : null}
          </div>
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
      <JsonLd
        graph={[
          techArticleLd({ title: page.title, description: page.description, path: page.href, modified: page.modified, section: page.groupLabel, markdown: page.rawHref, words: wordCount(page.body) }),
          breadcrumbLd([...crumbs, { name: page.title, path: page.href }].filter((crumb, index, all) => all.findIndex(other => other.path === crumb.path) === index)),
        ]}
      />
    </div>
  );
}

/** /docs/<product>/start, /learn, /reference: the group's purpose and its pages. */
export function GroupPage({ group }: { group: string }) {
  const info = sectionInfo(group);
  const pages = groupPages(group);
  const label = pages[0]?.groupLabel ?? info?.label ?? group;
  const top = pages.filter(page => !page.parent || !pages.some(other => other.path === page.parent));
  const product = group.split("/")[0]!;
  const crumbs: Crumb[] = [{ name: "Docs", path: DOCS_BASE }, { name: productLabel(`${product}/`), path: `${DOCS_BASE}/${product}` }];
  return (
    <div className={styles.layout} data-single="">
      <article className={styles.article}>
        <header className={styles.head}>
          <Crumbs crumbs={crumbs} />
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
      <JsonLd
        graph={[
          {
            "@type": "CollectionPage",
            name: label,
            description: info?.summary ?? label,
            url: absolute(`${DOCS_BASE}/${group}`),
            hasPart: pages.map(page => ({ "@type": "TechArticle", headline: page.title, url: absolute(page.href) })),
          },
          breadcrumbLd([...crumbs, { name: label, path: `${DOCS_BASE}/${group}` }]),
        ]}
      />
    </div>
  );
}
