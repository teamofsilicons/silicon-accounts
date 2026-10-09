/**
 * The public pages' footer (server-rendered): where to start, everything a Silicon can read or call here, the rest of
 * the ecosystem with the status of every service and the open source code, and the theme choice (System, Light, Dark).
 */
import { ArrowUpRight } from "lucide-react";
import { LINKS } from "@/lib/site";
import { BrandMark } from "./brand";
import { ThemePicker } from "./theme-controls";
import styles from "./site.module.css";

const COLUMNS: Array<{ title: string; links: Array<{ href: string; label: string; external?: boolean }> }> = [
  {
    title: "Build",
    links: [
      { href: "/docs", label: "Developer docs" },
      { href: "/docs/apps/start/publish", label: "Publish an app" },
      { href: "/docs/accounts/start/add-sign-in", label: "Add sign-in" },
      { href: "/docs/accounts/start/app-verification", label: "App verification" },
      { href: "/docs/accounts/start/user-verification", label: "User verification" },
      { href: "/docs/search", label: "Search the docs" },
    ],
  },
  {
    title: "For Silicons",
    links: [
      { href: "/llms.txt", label: "llms.txt" },
      { href: "/llms-full.txt", label: "llms-full.txt" },
      { href: "/openapi.json", label: "OpenAPI" },
      { href: "/.well-known/agent.json", label: "Agent card" },
    ],
  },
  {
    title: "Ecosystem",
    links: [
      { href: "/status", label: "Service status" },
      { href: LINKS.store, label: "Silicon Apps store", external: true },
      { href: LINKS.accounts, label: "Silicon Accounts", external: true },
      { href: LINKS.teamOfSilicons, label: "Team of Silicons", external: true },
      { href: LINKS.accountsGithub, label: "Accounts on GitHub", external: true },
      { href: LINKS.appsGithub, label: "Apps on GitHub", external: true },
    ],
  },
];

export function SiteFooter({ wide = false }: { wide?: boolean }) {
  return (
    <footer className={styles.footer} data-wide={wide ? "" : undefined}>
      <div className={styles.footerInner}>
        <div className={styles.footerTop}>
          <div className={styles.footerIntro}>
            <a href="/" className={styles.footerBrand}>
              <BrandMark className={styles.brandMark} />
              <span>Silicon Developer</span>
            </a>
            <p className={styles.tagline}>
              Everything you need to build into the Silicon ecosystem: apps for Carbons and Silicons, sign-in for both, and
              apps that work with each other.
            </p>
          </div>
          <nav className={styles.columns} aria-label="Footer">
            {COLUMNS.map(column => (
              <section key={column.title} className={styles.column} aria-labelledby={`footer-${column.title.toLowerCase().replace(/\s+/g, "-")}`}>
                <h2 id={`footer-${column.title.toLowerCase().replace(/\s+/g, "-")}`}>{column.title}</h2>
                <ul role="list">
                  {column.links.map(link => (
                    <li key={link.href}>
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
          <p className={styles.copyright}>© {new Date().getFullYear()} Team of Silicons. Silicon Apps and Silicon Accounts are open source (MIT).</p>
          <ThemePicker />
        </div>
      </div>
    </footer>
  );
}
