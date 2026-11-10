"use client";

/**
 * Home's sections under the introduction (Anil, 2026-10-31, direction B: Silicons first):
 *
 * - Your Silicons, the core of the account. With none yet, one tall banner (its own gradient, grain, a Geist Serif
 *   heading) that says what a Silicon is and offers Create a Silicon (the Silicons page's create panel, /silicons?new). With some, the first two as tiles (mark, name, si:id)
 *   and a New Silicon tile, with "See all" in the heading.
 * - Your apps: the apps the Carbon signs into, then the popular apps not signed in to yet, all in one card. See HomeApps.
 *
 * Tiles lead to the Silicons and Connected apps pages (there is no page for one Silicon or one app yet).
 */
import Link from "next/link";
import type { ReactNode } from "react";
import { ChevronRight, Plus } from "lucide-react";
import { ButtonLink } from "@/components/foundation/button-link";
import { formatRelative } from "@/lib/format";
import { paths } from "@/lib/navigation";
import { usePublicApps } from "@/lib/query/account";
import { AppMark } from "./parts/app-mark";
import { withAppIcon } from "./parts/app-icons";
import { useNow } from "./parts/common";
import { useEveryApp, useEverySilicon } from "./parts/queries";
import { SiliconMark } from "./parts/silicon-mark";
import { siliconHref } from "./silicons/silicons";
import styles from "./home-sections.module.css";

const SILICON_TILES = 2;
const APP_CARDS = 6;
const NEW_SILICON = `${paths.silicons}/new`;

function Section({ id, title, href, children }: { id: string; title: string; href?: string; children: ReactNode }) {
  return (
    <section className={styles.section} aria-labelledby={id}>
      <div className={styles.head}>
        <h2 id={id} className={styles.title}>{title}</h2>
        {/* A quiet link (a soft button was too loud): label weight with a chevron (Anil, 2026-11-10). */}
        {href ? <Link href={href} className={styles.seeAll}>See All<ChevronRight size={14} strokeWidth={2} aria-hidden="true" /></Link> : null}
      </div>
      {children}
    </section>
  );
}

export function HomeSilicons() {
  const silicons = useEverySilicon();
  if (!silicons.data) return null;
  const list = silicons.data.items;

  // No Silicons yet: no section for now (Anil, 2026-11-11); the introduction above presents Silicons. The first-Silicon
  // banner it showed (parts/first-silicon.tsx) is kept for when Home wants it back.
  if (!list.length) return null;

  return (
    <Section id="home-silicons" title="Your Silicons" href={paths.silicons}>
      <ul className={styles.tiles}>
        {list.slice(0, SILICON_TILES).map(silicon => (
          <li key={silicon.uuid}>
            <Link href={siliconHref(silicon)} data-sq="surface" className={styles.tile}>
              <SiliconMark seed={silicon.uuid} size={28} />
              <span className={styles.tileWords}>
                <span className={styles.tileTitle}>{silicon.display_name || silicon.id || "A Silicon"}</span>
                {silicon.id ? <span className={styles.tileId}>{silicon.id}</span> : null}
              </span>
            </Link>
          </li>
        ))}
        <li>
          <Link href={NEW_SILICON} data-sq="surface" className={`${styles.tile} ${styles.newTile}`}>
            <span data-sq="surface" className={styles.plus} aria-hidden="true"><Plus size={16} strokeWidth={1.75} /></span>
            <span className={styles.tileTitle}>New Silicon</span>
          </Link>
        </li>
      </ul>
    </Section>
  );
}

/**
 * The popular Team of Silicons apps Home offers (Anil, 2026-10-31): their name and address come from the API
 * (`GET /v1/apps/{app_id}/public`); each line is Anil's (2026-10-31: what you do there). Their marks are Anil's app
 * icons (parts/app-icons.ts, 2026-11-10), as are Write's and Writings'.
 */
const POPULAR_APPS: { appId: string; line: string }[] = [
  { appId: "briefcase", line: "Keep and share files with your Silicons." },
  { appId: "dm", line: "Message people and Silicons directly." },
  { appId: "ting", line: "Get notified when your Silicons need you." },
];

/** An app's address without the scheme, for the line under an app that has no line of Anil's. */
function domainOf(url: string | null): string | null {
  if (!url) return null;
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return null; }
}

/**
 * Your apps (Anil, 2026-11-10): one grid, every app in the same tile + footer card. First the apps the Carbon signs
 * into, most recent first: their mark, name and line (Anil's line for the popular apps, else the app's address), when
 * they last signed in and Open. Then the popular apps (Briefcase, DM, Ting) not signed in to yet: "Not signed in yet"
 * and Try (soft). Up to APP_CARDS; "See all" goes to Connected apps. Which apps show here is still open (Anil is
 * thinking of a different logic); the separate Try an app section is gone.
 *
 * With no app signed in to, the section doesn't show: the introduction above presents apps (Anil, 2026-11-11).
 */
export function HomeApps() {
  const apps = useEveryApp();
  const now = useNow(60_000);
  const popular = usePublicApps(POPULAR_APPS.map(item => item.appId));
  if (!apps.data) return null;
  // Only apps the Carbon still signs into (not those whose access they removed), most recent first.
  const list = apps.data.items
    .filter(item => item.status === "active")
    .sort((a, b) => (b.last_signed_in_at ?? "").localeCompare(a.last_signed_in_at ?? ""));
  if (!list.length) return null;
  const untried = POPULAR_APPS.flatMap((entry, index) => {
    const app = popular[index]?.data;
    return app && !list.some(item => item.app.app_id === entry.appId) ? [{ entry, app }] : [];
  });
  const cards = [
    ...list.map(item => {
      const line = POPULAR_APPS.find(candidate => candidate.appId === item.app.app_id)?.line ?? domainOf(item.app.homepage_url);
      return { app: item.app, line, when: item.last_signed_in_at ? formatRelative(item.last_signed_in_at, now) : null, joined: true };
    }),
    ...untried.map(({ entry, app }) => ({ app, line: entry.line, when: null, joined: false })),
  ].slice(0, APP_CARDS);

  return (
    <Section id="home-apps" title="Your apps" href={paths.apps}>
      <ul className={styles.tiles}>
        {cards.map(({ app, line, when, joined }) => (
          <li key={app.app_id}>
            <div data-sq="surface" className={styles.appCard}>
              <div className={styles.appTop}>
                <AppMark app={withAppIcon(app)} size={40} className={styles.appMark} decorative />
                <span className={styles.appWords}>
                  <span className={styles.appName}>{app.name}</span>
                  {line ? <span className={styles.appLine}>{line}</span> : null}
                </span>
              </div>
              <div className={styles.appFooter}>
                <span className={styles.appFact}>{when ? <>Signed in <span className={styles.appWhen}>{when}</span></> : "Not signed in yet"}</span>
                {app.homepage_url ? (
                  <ButtonLink href={app.homepage_url} external variant={joined ? "secondary" : "soft"} size="xs" aria-label={`${joined ? "Open" : "Try"} ${app.name}`}>
                    {joined ? "Open" : "Try"}
                  </ButtonLink>
                ) : null}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </Section>
  );
}
