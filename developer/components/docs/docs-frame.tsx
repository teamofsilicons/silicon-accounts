/**
 * The frame of every /docs page (server-rendered): the site header (with the docs search and, in its menu below
 * 1024 px, the docs navigation), the navigation in a sticky sidebar, the page in <main>, the site footer, and the one
 * behaviour island. `path` is the page's address, so the navigation marks where you are without any script.
 */
import type { ReactNode } from "react";
import { docs } from "@/lib/docs/content";
import { DOCS_BASE } from "@/lib/docs/site";
import type { SearchSuggestion } from "@/lib/docs/types";
import { isSignedIn } from "@/lib/server/signed-in";
import { Enhancer } from "@/components/site/enhancer";
import { SiteFooter } from "@/components/site/site-footer";
import { SiteHeader } from "@/components/site/site-header";
import { DocsNav } from "./docs-nav";
import { DocsSearch } from "./docs-search";
import styles from "./docs-frame.module.css";

/** What the search offers before anything is typed: the common jobs first. */
const SUGGESTED = [
  "apps/start/install.md",
  "apps/start/publish.md",
  "accounts/start/add-sign-in.md",
  "accounts/start/silicon-account.md",
  "accounts/start/silicon-sign-in-to-apps.md",
  "accounts/start/verify-a-proof.md",
  "accounts/start/webhooks.md",
  "accounts/start/tokens.md",
  "accounts/reference/api.md",
  "accounts/reference/errors.md",
  "accounts/reference/cli.md",
];

function suggestions(): SearchSuggestion[] {
  const { byPath, pages } = docs();
  const chosen = SUGGESTED.map(path => byPath.get(path)).filter(page => page !== undefined);
  const list = chosen.length >= 4 ? chosen : pages.slice(0, 8);
  return list.map(page => ({ title: page.title, href: page.href, group: page.groupLabel }));
}

export async function DocsFrame({ path, children }: { path: string; children: ReactNode }) {
  const { nav } = docs();
  const signedIn = await isSignedIn();
  return (
    <div className={styles.frame} id="top">
      <SiteHeader
        path={path}
        signedIn={signedIn}
        wide
        search={<DocsSearch suggestions={suggestions()} />}
        menu={<DocsNav groups={nav} current={path} idPrefix="menu-docs" label="Docs (menu)" />}
      />
      <div className={styles.body}>
        <aside className={styles.sidebar} data-docs-sidebar="" aria-label="Docs navigation">
          <DocsNav groups={nav} current={path} idPrefix="side-docs" />
        </aside>
        <main id="main" className={styles.main} tabIndex={-1}>
          {children}
          <p className={styles.formats}>
            Every page is plain Markdown at its address plus <code>.md</code>. Silicons can read{" "}
            <a href="/llms.txt">llms.txt</a>, <a href="/llms-full.txt">llms-full.txt</a> or the <a href={`${DOCS_BASE}.md`}>docs index</a>, or call the{" "}
            <a href="/#mcp">MCP server</a>.
          </p>
        </main>
      </div>
      <SiteFooter wide />
      <Enhancer />
    </div>
  );
}
