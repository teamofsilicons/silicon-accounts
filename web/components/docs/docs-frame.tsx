/**
 * The frame of every /docs page (server): the sticky header, the navigation in a sticky sidebar (a drawer below
 * 1024 px), the page, and a footer that points Silicons at the Markdown versions (llms.txt, llms-full.txt).
 */
import Link from "next/link";
import type { ReactNode } from "react";
import { docs } from "@/lib/docs/content";
import { DOCS_BASE, GITHUB_PUBLISHED, GITHUB_REPO } from "@/lib/docs/site";
import type { SearchSuggestion } from "@/lib/docs/types";
import { DocsHeader } from "./docs-header";
import { DocsNav } from "./docs-nav";
import styles from "./docs-frame.module.css";

/** What the search offers before anything is typed: the common jobs first. */
const SUGGESTED = [
  "start/add-sign-in.md",
  "start/silicon-account.md",
  "start/silicon-sign-in-to-apps.md",
  "start/verify-a-proof.md",
  "start/webhooks.md",
  "start/tokens.md",
  "reference/api.md",
  "reference/errors.md",
  "reference/cli.md",
];

function suggestions(): SearchSuggestion[] {
  const { byPath, pages } = docs();
  const chosen = SUGGESTED.map(path => byPath.get(path)).filter(page => page !== undefined);
  const list = chosen.length >= 4 ? chosen : pages.slice(0, 8);
  return list.map(page => ({ title: page.title, href: page.href, group: page.groupLabel }));
}

export function DocsFrame({ children }: { children: ReactNode }) {
  const { nav } = docs();
  return (
    <div className={styles.frame} id="top">
      <a className="skip-link" href="#docs-main">Skip to content</a>
      <DocsHeader groups={nav} suggestions={suggestions()} />
      <div className={styles.body}>
        <aside className={styles.sidebar} data-docs-sidebar="">
          <DocsNav groups={nav} />
        </aside>
        <main id="docs-main" className={styles.main} tabIndex={-1}>
          {children}
          <footer className={styles.footer}>
            <span>Silicon Accounts docs</span>
            <span className={styles.footerLinks}>
              <a href="/llms.txt">llms.txt</a>
              <a href="/llms-full.txt">llms-full.txt</a>
              <a href={`${DOCS_BASE}/index.md`}>Markdown</a>
              {GITHUB_PUBLISHED ? <a href={GITHUB_REPO}>GitHub</a> : null}
              <Link href="/">Your account</Link>
            </span>
          </footer>
        </main>
      </div>
    </div>
  );
}
