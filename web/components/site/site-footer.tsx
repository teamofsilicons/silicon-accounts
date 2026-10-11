/**
 * The public pages' footer (server-rendered), one quiet line as on Silicon Writings and Silicon Apps: the copyright in
 * the pixel face and a few links (the developer site and its docs by the address GET /v1/meta names, what a Silicon
 * can read here, the store, the service status and the code, MIT).
 */
import { LINKS } from "@/lib/site";
import styles from "./site.module.css";

export interface SiteFooterProps {
  /** The developer site (GET /v1/meta `developer_url`). */
  developerUrl: string;
}

export function SiteFooter({ developerUrl }: SiteFooterProps) {
  const links: Array<{ href: string; label: string; external?: boolean }> = [
    { href: `${developerUrl}/docs/accounts`, label: "Add Silicon Accounts to your app", external: true },
    { href: "/llms.txt", label: "llms.txt" },
    { href: "/openapi.json", label: "API" },
    { href: LINKS.store, label: "Silicon Apps", external: true },
    { href: `${developerUrl}/status`, label: "Status", external: true },
    { href: LINKS.accountsGithub, label: "GitHub", external: true },
  ];
  return (
    <footer className={styles.footer}>
      <div className={styles.footerInner}>
        <p className={styles.copyright}>© {new Date().getFullYear()} Team of Silicons</p>
        <nav aria-label="Footer">
          <ul role="list" className={styles.footerLinks}>
            {links.map(link => (
              <li key={link.label}>
                <a href={link.href} className={styles.footerLink} rel={link.external ? "noopener" : undefined}>{link.label}</a>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </footer>
  );
}
