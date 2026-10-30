"use client";

/**
 * The account site's section list, as in the lead designer's prototype: Silicon UI's NavList with every section (lib/navigation.ts
 * SECTIONS), a count where something waits for the Carbon, and the other sites at the foot, marked as leaving. The
 * shell shows it beside the page from 900px and inside a bottom sheet on narrower screens; both read this one list.
 * Beside the page (the inset shell) it also carries what a top bar would: `head` (the brand and search) above the
 * list and `account` (the account menu) at its foot.
 */
import type { ReactNode } from "react";
import { ArrowUpRight } from "lucide-react";
import { Badge } from "@teamofsilicons/silicon-ui/badge";
import { ButtonLink } from "@teamofsilicons/silicon-ui/button-link";
import { NavItem, NavList } from "@teamofsilicons/silicon-ui/nav-list";
import { ELSEWHERE, SECTIONS, type SectionKey } from "@/lib/navigation";
import { useCustodianRequests } from "@/lib/query/silicons";
import styles from "./sidebar.module.css";

export interface SidebarProps {
  activeKey: SectionKey | undefined;
  /** The developer site's address (GET /v1/meta). */
  developerUrl: string;
  /** Called when a row is chosen (closes the phone sheet). */
  onNavigate?: () => void;
  /** Above the list, beside the page only: the brand and search. */
  head?: ReactNode;
  /** At the foot, beside the page only: the account menu. */
  account?: ReactNode;
}

export function Sidebar({ activeKey, developerUrl, onNavigate, head, account }: SidebarProps) {
  const requests = useCustodianRequests();
  const waiting = requests.data?.items.filter(request => request.status === "pending").length ?? 0;
  const counts: Partial<Record<SectionKey, number>> = { silicons: waiting };

  return (
    <div className={styles.sidebar}>
      {head ? <div className={styles.head}>{head}</div> : null}
      <NavList label="Account sections" onNavigate={onNavigate}>
        {SECTIONS.map(section => {
          const Icon = section.icon;
          const count = counts[section.key] ?? 0;
          return (
            <NavItem
              key={section.key}
              href={section.href}
              icon={<Icon strokeWidth={1.75} aria-hidden="true" />}
              active={section.key === activeKey}
              trailing={count > 0 ? <Badge tone="warning" size="sm" aria-label={`${count} waiting for you`}>{count}</Badge> : undefined}
            >
              {section.label}
            </NavItem>
          );
        })}
      </NavList>
      <nav className={styles.foot} aria-label="Other sites">
        {ELSEWHERE.map(site => (
          <ButtonLink key={site.key} href={site.href(developerUrl)} variant="ghost" size="sm" onClick={onNavigate}>
            {site.label}
            <ArrowUpRight size={14} strokeWidth={1.75} aria-hidden="true" />
          </ButtonLink>
        ))}
      </nav>
      {account ? <div className={styles.account}>{account}</div> : null}
    </div>
  );
}
