/**
 * The public pages' footer (server-rendered), one quiet line as on Silicon Writings and the Silicon Apps store: the
 * copyright in the pixel face and a few links (what a Silicon can read here, the status of every service, the store,
 * the account site and the open source code).
 */
import { LINKS } from "@/lib/site";
import styles from "./site.module.css";

const LINKS_ROW: Array<{ href: string; label: string; external?: boolean }> = [
  { href: "/llms.txt", label: "llms.txt" },
  { href: "/openapi.json", label: "API" },
  { href: "/status", label: "Status" },
  { href: LINKS.store, label: "Silicon Apps", external: true },
  { href: LINKS.accounts, label: "Silicon Accounts", external: true },
  { href: LINKS.accountsGithub, label: "GitHub", external: true },
];

export function SiteFooter({ wide = false }: { wide?: boolean }) {
  return (
    <footer className={styles.footer} data-wide={wide ? "" : undefined}>
      <div className={styles.footerInner}>
        <p className={styles.copyright}>© {new Date().getFullYear()} Team of Silicons</p>
        <nav aria-label="Footer">
          <ul role="list" className={styles.footerLinks}>
            {LINKS_ROW.map(link => (
              <li key={link.href}>
                <a href={link.href} className={styles.footerLink} rel={link.external ? "noopener" : undefined}>{link.label}</a>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </footer>
  );
}
