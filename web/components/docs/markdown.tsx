/**
 * Renders a docs page's Markdown AST (lib/docs/markdown.ts) as React, on the server. Links are resolved for the site
 * (lib/docs/links.ts): pages become client-side links to /docs/…, files outside docs/ go to GitHub (only once the
 * repository is published there: GITHUB_PUBLISHED in lib/docs/site.ts; until then they render as text), a link to a page
 * that does not exist renders as its text. Headings get anchors, code blocks are highlighted, GitHub alerts
 * (`> [!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, `[!CAUTION]`) become callouts, and tables scroll sideways on
 * narrow screens.
 */
import Link from "next/link";
import { Fragment, type ReactNode } from "react";
import { ArrowUpRight, Info, Lightbulb, MessageSquareWarning, OctagonAlert, TriangleAlert } from "lucide-react";
import { pageExists } from "@/lib/docs/content";
import { resolveLink } from "@/lib/docs/links";
import type { Block, CalloutKind, Inline } from "@/lib/docs/markdown";
import { GITHUB_BRANCH, GITHUB_PUBLISHED, GITHUB_REPO } from "@/lib/docs/site";
import { CodeBlock } from "./code-block";
import styles from "./prose.module.css";

interface Context {
  /** The page's path inside docs/, for relative links. */
  from: string;
}

const CALLOUTS: Record<CalloutKind, { label: string; icon: ReactNode }> = {
  note: { label: "Note", icon: <Info size={16} strokeWidth={1.75} /> },
  tip: { label: "Tip", icon: <Lightbulb size={16} strokeWidth={1.75} /> },
  important: { label: "Important", icon: <MessageSquareWarning size={16} strokeWidth={1.75} /> },
  warning: { label: "Warning", icon: <TriangleAlert size={16} strokeWidth={1.75} /> },
  caution: { label: "Caution", icon: <OctagonAlert size={16} strokeWidth={1.75} /> },
};

function InlineLink({ href, title, children, context }: { href: string; title: string | null; children: ReactNode; context: Context }) {
  const link = resolveLink(href, context.from, pageExists);
  const tooltip = title ?? undefined;
  switch (link.kind) {
    case "page":
    case "section":
      return <Link href={link.href} title={tooltip}>{children}</Link>;
    case "anchor":
    case "site":
      return <a href={link.href} title={tooltip}>{children}</a>;
    case "repo":
      // A file of the repository: GitHub serves it only once the repository is published there.
      if (!GITHUB_PUBLISHED) return <span title="The repository isn't published on GitHub yet">{children}</span>;
      return (
        <a href={link.href} title={tooltip} className={styles.external}>
          {children}
          <ArrowUpRight size={12} strokeWidth={2} aria-hidden="true" className={styles.externalIcon} />
        </a>
      );
    case "external":
      return (
        <a href={link.href} title={tooltip} className={styles.external}>
          {children}
          <ArrowUpRight size={12} strokeWidth={2} aria-hidden="true" className={styles.externalIcon} />
        </a>
      );
    case "missing":
      return <span className={styles.missing} title={`Link not available: ${link.reason}`}>{children}</span>;
  }
}

function imageSource(src: string, from: string): string | null {
  if (/^https?:\/\//i.test(src) || src.startsWith("/") || src.startsWith("data:image/")) return src;
  // Repository files (outside docs/ or next to the page) are served by GitHub, once the repository is published there.
  if (!GITHUB_PUBLISHED) return null;
  const link = resolveLink(src, from, () => false);
  if (link.kind === "repo") return link.href.replace("/blob/", "/raw/");
  // A file next to the page inside docs/: GitHub serves it.
  if (link.kind === "missing" && !src.includes("..")) return `${GITHUB_REPO}/raw/${GITHUB_BRANCH}/docs/${from.replace(/[^/]*$/, "")}${src}`;
  return null;
}

export function Inlines({ nodes, context }: { nodes: Inline[]; context: Context }): ReactNode {
  return nodes.map((node, index) => {
    switch (node.type) {
      case "text":
        return node.value;
      case "code":
        return <code key={index} className={styles.inlineCode} data-sq-native="">{node.value}</code>;
      case "strong":
        return <strong key={index}><Inlines nodes={node.children} context={context} /></strong>;
      case "em":
        return <em key={index}><Inlines nodes={node.children} context={context} /></em>;
      case "del":
        return <del key={index}><Inlines nodes={node.children} context={context} /></del>;
      case "break":
        return <br key={index} />;
      case "link":
        return <InlineLink key={index} href={node.href} title={node.title} context={context}><Inlines nodes={node.children} context={context} /></InlineLink>;
      case "image": {
        const src = imageSource(node.src, context.from);
        // eslint-disable-next-line @next/next/no-img-element -- docs images are plain files, shown as they are.
        return src ? <img key={index} src={src} alt={node.alt} title={node.title ?? undefined} loading="lazy" className={styles.image} /> : <span key={index}>{node.alt}</span>;
      }
    }
  });
}

function Heading({ depth, id, children }: { depth: number; id: string; children: ReactNode }) {
  // The page title is the only h1; any other # heading in a page is a section.
  const level = Math.min(Math.max(depth, 2), 6);
  const Tag = `h${level}` as "h2" | "h3" | "h4" | "h5" | "h6";
  return (
    <Tag id={id} className={styles[`h${level}`]}>
      {children}
      <a href={`#${id}`} className={styles.anchor} aria-label="Link to this section" data-sq-native="">
        <span aria-hidden="true">#</span>
      </a>
    </Tag>
  );
}

function ListBlock({ block, context }: { block: Extract<Block, { type: "list" }>; context: Context }) {
  const tasks = block.items.some(item => item.checked !== null);
  const items = block.items.map((item, index) => (
    <li key={index} className={item.checked !== null ? styles.task : undefined}>
      {item.checked !== null ? (
        <span className={styles.checkbox} data-checked={item.checked ? "" : undefined} data-sq-native="" role="img" aria-label={item.checked ? "Done" : "Not done"}>
          {item.checked ? <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" /></svg> : null}
        </span>
      ) : null}
      <Blocks blocks={item.children} context={context} tight={block.tight} />
    </li>
  ));
  const className = [styles.list, block.tight ? styles.tight : styles.loose, tasks ? styles.tasks : ""].filter(Boolean).join(" ");
  return block.ordered ? <ol className={className} start={block.start !== 1 ? block.start : undefined}>{items}</ol> : <ul className={className}>{items}</ul>;
}

function TableBlock({ block, context }: { block: Extract<Block, { type: "table" }>; context: Context }) {
  const align = (column: number) => (block.align[column] ? { textAlign: block.align[column]! } : undefined);
  return (
    <div className={styles.tableFrame} data-sq="clip" role="region" aria-label="Table" tabIndex={0}>
      <table className={styles.table}>
        <thead>
          <tr>{block.head.map((cell, column) => <th key={column} scope="col" style={align(column)}><Inlines nodes={cell} context={context} /></th>)}</tr>
        </thead>
        {block.rows.length ? (
          <tbody>
            {block.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, column) => <td key={column} style={align(column)}><Inlines nodes={cell} context={context} /></td>)}</tr>)}
          </tbody>
        ) : null}
      </table>
    </div>
  );
}

export function Blocks({ blocks, context, tight = false }: { blocks: Block[]; context: Context; tight?: boolean }): ReactNode {
  return blocks.map((block, index) => {
    switch (block.type) {
      case "heading":
        return <Heading key={index} depth={block.depth} id={block.id}><Inlines nodes={block.children} context={context} /></Heading>;
      case "paragraph":
        return tight ? <Fragment key={index}><Inlines nodes={block.children} context={context} /></Fragment> : <p key={index}><Inlines nodes={block.children} context={context} /></p>;
      case "code":
        return <CodeBlock key={index} code={block.value} lang={block.lang} meta={block.meta} />;
      case "blockquote":
        return <blockquote key={index} className={styles.quote}><Blocks blocks={block.children} context={context} /></blockquote>;
      case "callout": {
        const callout = CALLOUTS[block.kind];
        return (
          <aside key={index} className={styles.callout} data-kind={block.kind} data-sq="surface" aria-label={callout.label}>
            <p className={styles.calloutTitle}><span className={styles.calloutIcon} aria-hidden="true">{callout.icon}</span>{callout.label}</p>
            <div className={styles.calloutBody}><Blocks blocks={block.children} context={context} /></div>
          </aside>
        );
      }
      case "list":
        return <ListBlock key={index} block={block} context={context} />;
      case "table":
        return <TableBlock key={index} block={block} context={context} />;
      case "hr":
        return <hr key={index} className={styles.rule} />;
    }
  });
}

/** A whole page body. */
export function Markdown({ blocks, from }: { blocks: Block[]; from: string }) {
  return (
    <div className={styles.prose}>
      <Blocks blocks={blocks} context={{ from }} />
    </div>
  );
}
