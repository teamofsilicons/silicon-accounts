/**
 * The public pages' footer (server-rendered), as on the developer site: the account, everything a Silicon can read or
 * call here, the rest of the ecosystem (the developer site and its docs by the address GET /v1/meta names), and the
 * theme choice (System, Light, Dark).
 */
import { ArrowUpRight } from "lucide-react";
import { LINKS } from "@/lib/site";
import { BrandMark } from "./brand";
import { ThemePicker } from "./theme-controls";
import styles from "./site.module.css";

interface FooterLink {
  href: string;
  label: string;
  external?: boolean;
}

export interface SiteFooterProps {
  /** The developer site (GET /v1/meta `developer_url`). */
  developerUrl: string;
}

export function SiteFooter({ developerUrl }: SiteFooterProps) {
  const columns: Array<{ id: string; title: string; links: FooterLink[] }> = [
    {
      id: "footer-account",
      title: "Your account",
      links: [
        { href: "/sign-in?intent=signup", label: "Sign up" },
        { href: "/sign-in", label: "Sign in" },
        { href: "/#for-silicons", label: "For Silicons" },
        { href: "/#for-carbons", label: "For Carbons" },
        { href: "/#faq", label: "Questions" },
      ],
    },
    {
      id: "footer-agents",
      title: "For agents",
      links: [
        { href: "/llms.txt", label: "llms.txt" },
        { href: "/llms-full.txt", label: "llms-full.txt" },
        { href: "/#mcp", label: "MCP server" },
        { href: "/openapi.json", label: "OpenAPI" },
        { href: "/.well-known/agent.json", label: "Agent card" },
        { href: "/.well-known/openid-configuration", label: "OpenID configuration" },
      ],
    },
    {
      id: "footer-ecosystem",
      title: "Ecosystem",
      links: [
        { href: developerUrl, label: "Developer site", external: true },
        { href: `${developerUrl}/docs`, label: "Docs", external: true },
        { href: LINKS.store, label: "Silicon Apps store", external: true },
        { href: LINKS.teamOfSilicons, label: "Team of Silicons", external: true },
        { href: LINKS.accountsGithub, label: "Silicon Accounts on GitHub", external: true },
      ],
    },
  ];
  return (
    <footer className={styles.footer}>
      <div className={styles.footerInner}>
        <div className={styles.footerTop}>
          <div className={styles.footerIntro}>
            <a href="/" className={styles.footerBrand}>
              <BrandMark className={styles.brandMark} />
              <span>Silicon Accounts</span>
            </a>
            <p className={styles.tagline}>
              One account for every Carbon and Silicon. Sign into every app as yourself, and look after the Silicons in your care.
            </p>
          </div>
          <nav className={styles.columns} aria-label="Footer">
            {columns.map(column => (
              <section key={column.id} className={styles.column} aria-labelledby={column.id}>
                <h2 id={column.id}>{column.title}</h2>
                <ul role="list">
                  {column.links.map(link => (
                    <li key={link.label}>
                      <a href={link.href} className={styles.footerLink} rel={link.external ? "noopener" : undefined}>
                        {link.label}
                        {link.external ? <ArrowUpRight size={13} strokeWidth={1.75} aria-hidden="true" className={styles.externalIcon} /> : null}
                      </a>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </nav>
        </div>
        <div className={styles.footerBottom}>
          <p className={styles.copyright}>© {new Date().getFullYear()} Team of Silicons. Silicon Accounts is public on GitHub.</p>
          <ThemePicker />
        </div>
      </div>
    </footer>
  );
}
