"use client";

/**
 * Home's sections under the introduction (Anil, 2026-10-31, direction B: Silicons first):
 *
 * - Your Silicons, the core of the account. With none yet, one tall banner (its own gradient, grain, a Geist Serif
 *   heading) that says what a Silicon is and offers Create a Silicon (the Silicons page's create panel, /silicons?new). With some, the first two as tiles (mark, name, si:id)
 *   and a New Silicon tile, with "See all" in the heading.
 * - Your apps: the popular apps (Briefcase, DM, Ting) as cards, each with its logo, name, one line and Open (signed
 *   into) or Try (not yet), going to the app; then up to four other apps the Carbon signs into as small tiles; "See
 *   all" in the heading once there are any.
 *
 * Tiles lead to the Silicons and Connected apps pages (there is no page for one Silicon or one app yet).
 */
import Link from "next/link";
import type { ReactNode } from "react";
import { Plus } from "lucide-react";
import { ButtonLink } from "@/components/foundation/button-link";
import { paths } from "@/lib/navigation";
import { usePublicApps } from "@/lib/query/account";
import { NEW_SILICON_PARAM } from "./parts/anchors";
import { AppMark } from "./parts/app-mark";
import { useEveryApp, useEverySilicon } from "./parts/queries";
import { SiliconMark } from "./parts/silicon-mark";
import styles from "./home-sections.module.css";

const SILICON_TILES = 2;
const APP_TILES = 4;
const NEW_SILICON = `${paths.silicons}?${NEW_SILICON_PARAM}`;

function Section({ id, title, href, children }: { id: string; title: string; href?: string; children: ReactNode }) {
  return (
    <section className={styles.section} aria-labelledby={id}>
      <div className={styles.head}>
        <h2 id={id} className={styles.title}>{title}</h2>
        {href ? <Link href={href} className={styles.seeAll}>See all</Link> : null}
      </div>
      {children}
    </section>
  );
}

export function HomeSilicons() {
  const silicons = useEverySilicon();
  if (!silicons.data) return null;
  const list = silicons.data.items;

  // No Silicons yet: the section's one banner (Anil, 2026-10-31).
  if (!list.length) {
    return (
      <Section id="home-silicons" title="Your Silicons">
        <div data-sq="clip" className={styles.first}>
          <h3 className={styles.firstTitle}>Create your first Silicon</h3>
          <p className={styles.firstLine}>Give your AI agent its own identity to sign in to apps. You look after it.</p>
          <ButtonLink href={NEW_SILICON} variant="secondary" size="sm" className={styles.firstAction}>Create a Silicon</ButtonLink>
        </div>
      </Section>
    );
  }

  return (
    <Section id="home-silicons" title="Your Silicons" href={paths.silicons}>
      <ul className={styles.tiles}>
        {list.slice(0, SILICON_TILES).map(silicon => (
          <li key={silicon.uuid}>
            <Link href={paths.silicons} data-sq="surface" className={styles.tile}>
              <SiliconMark seed={silicon.uuid} size={36} />
              <span className={styles.tileWords}>
                <span className={styles.tileTitle}>{silicon.display_name || silicon.id || "A Silicon"}</span>
                {silicon.id ? <span className={styles.tileId}>{silicon.id}</span> : null}
              </span>
            </Link>
          </li>
        ))}
        <li>
          <Link href={NEW_SILICON} data-sq="surface" className={`${styles.tile} ${styles.newTile}`}>
            <span data-sq="surface" className={styles.plus} aria-hidden="true"><Plus size={18} strokeWidth={1.75} /></span>
            <span className={styles.tileTitle}>New Silicon</span>
          </Link>
        </li>
      </ul>
    </Section>
  );
}

/**
 * The popular Team of Silicons apps Home offers (Anil, 2026-10-31): their name, logo and address come from the API
 * (`GET /v1/apps/{app_id}/public`); each line is the prototype's own (redesign/prototype-v7.html, APPS).
 */
const POPULAR_APPS = [
  { appId: "briefcase", line: "Files for Carbons and Silicons" },
  { appId: "dm", line: "Messages between Carbons and Silicons" },
  { appId: "ting", line: "Notifications for Silicons" },
] as const;

export function HomeApps() {
  const apps = useEveryApp();
  const popular = usePublicApps(POPULAR_APPS.map(item => item.appId));
  if (!apps.data) return null;
  // Only apps the Carbon still signs into (not those whose access they removed).
  const list = apps.data.items.filter(item => item.status === "active");
  const joined = new Set(list.map(item => item.app.app_id));
  const others = list.filter(item => !POPULAR_APPS.some(entry => entry.appId === item.app.app_id));

  return (
    <Section id="home-apps" title="Your apps" href={list.length ? paths.apps : undefined}>
      <ul className={styles.tiles}>
        {POPULAR_APPS.map((entry, index) => {
          const app = popular[index]?.data;
          if (!app) return null;
          const open = joined.has(entry.appId);
          return (
            <li key={entry.appId}>
              <div data-sq="surface" className={styles.appCard}>
                <AppMark app={app} size={40} decorative />
                <span className={styles.tileWords}>
                  <span className={styles.tileTitle}>{app.name}</span>
                  <span className={styles.appLine}>{entry.line}</span>
                </span>
                {app.homepage_url ? (
                  <ButtonLink href={app.homepage_url} external variant={open ? "soft" : "secondary"} size="sm" className={styles.appAction} aria-label={`${open ? "Open" : "Try"} ${app.name}`}>
                    {open ? "Open" : "Try"}
                  </ButtonLink>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      {others.length ? (
        <ul className={`${styles.tiles} ${styles.four}`}>
          {others.slice(0, APP_TILES).map(item => (
            <li key={item.app.app_id}>
              <Link href={paths.apps} data-sq="surface" className={styles.tile}>
                <AppMark app={item.app} size={36} decorative />
                <span className={styles.tileWords}>
                  <span className={styles.tileTitle}>{item.app.name}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </Section>
  );
}
