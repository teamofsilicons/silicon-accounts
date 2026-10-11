"use client";

/**
 * The docs' top bar, sticky over the page: the site's brand (home), "Docs", search, and below
 * 1024 px a menu button that opens the navigation in a drawer from the left.
 */
import Link from "next/link";
import { useState } from "react";
import { Menu } from "lucide-react";
import { Drawer, DrawerContent, DrawerTrigger } from "@/components/silicon-ui/drawer/drawer";
import { BrandMark } from "@/components/foundation/shell/brand-mark";
import { DOCS_BASE } from "@/lib/docs/site";
import type { NavGroup, SearchSuggestion } from "@/lib/docs/types";
import { DocsNav } from "./docs-nav";
import { DocsSearch } from "./docs-search";
import styles from "./docs-frame.module.css";

export function DocsHeader({ groups, suggestions }: { groups: NavGroup[]; suggestions: SearchSuggestion[] }) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <header className={styles.top}>
      <div className={styles.topInner}>
        <div className={styles.brandRow}>
          <Link href="/" className={styles.brand} data-sq="surface" aria-label="Silicon Accounts home">
            <BrandMark />
            <span className={styles.brandText}>Silicon Accounts</span>
          </Link>
          <span className={styles.divider} aria-hidden="true">/</span>
          <Link href={DOCS_BASE} className={styles.docsLink} data-sq="surface">Docs</Link>
        </div>
        <div className={styles.actions}>
          <DocsSearch suggestions={suggestions} />
          <Drawer open={menuOpen} onOpenChange={setMenuOpen}>
            <DrawerTrigger asChild>
              <button type="button" className={styles.menuButton} data-sq="surface" aria-label="Open the docs menu">
                <Menu size={18} strokeWidth={1.75} aria-hidden="true" />
              </button>
            </DrawerTrigger>
            <DrawerContent side="left" title="Docs" description="Every page, in reading order" className={styles.drawer}>
              <DocsNav groups={groups} onNavigate={() => setMenuOpen(false)} className={styles.drawerNav} />
            </DrawerContent>
          </Drawer>
        </div>
      </div>
    </header>
  );
}
