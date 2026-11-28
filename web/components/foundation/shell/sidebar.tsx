"use client";

/**
 * What the account site puts in Silicon UI's AppShell sidebar (account-shell.tsx): the section list, as in the lead
 * designer's prototype (NavList with every section, lib/navigation.ts SECTIONS, a count where something waits for the
 * Carbon), and the other sites as small grey chips for the shell's `links` (Anil, 2026-10-30). AppShell draws both
 * beside the page from 900px and in its bottom sheet under that, and follows their links through the shell's guards.
 */
import { Badge } from "@teamofsilicons/silicon-ui/badge";
import { ButtonLink } from "@teamofsilicons/silicon-ui/button-link";
import { NavItem, NavList } from "@teamofsilicons/silicon-ui/nav-list";
import { ELSEWHERE, SECTIONS, type SectionKey } from "@/lib/navigation";
import { useCustodianRequests } from "@/lib/query/silicons";
import styles from "./sidebar.module.css";

export function SidebarNav({ activeKey }: { activeKey: SectionKey | undefined }) {
  const requests = useCustodianRequests();
  const waiting = requests.data?.items.filter(request => request.status === "pending").length ?? 0;
  const counts: Partial<Record<SectionKey, number>> = { silicons: waiting };

  return (
    <NavList label="Account sections" className={styles.nav}>
      {SECTIONS.map(section => {
        const Icon = section.icon;
        const count = counts[section.key] ?? 0;
        return (
          <NavItem
            key={section.key}
            href={section.href}
            icon={<Icon strokeWidth={2} aria-hidden="true" />}
            active={section.key === activeKey}
            trailing={count > 0 ? <Badge tone="warning" size="sm" aria-label={`${count} waiting for you`}>{count}</Badge> : undefined}
          >
            {section.label}
          </NavItem>
        );
      })}
    </NavList>
  );
}

/** The other sites (the developer site, the docs), for AppShell's `links`. */
export function SidebarLinks({ developerUrl }: { developerUrl: string }) {
  return ELSEWHERE.map(site => (
    <ButtonLink key={site.key} href={site.href(developerUrl)} variant="soft" size="xs">
      {site.label}
    </ButtonLink>
  ));
}
