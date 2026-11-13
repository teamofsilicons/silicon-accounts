"use client";

/**
 * /__apps-empty: Connected Apps with no app connected, in versions to choose from (Anil, 2026-11-13: "we need to think
 * what we show when someone goes to that page and doesn't have any app connected"). Home's introduction sends a new
 * Carbon here from its Apps card. Each version is drawn as the page would be: the page bar, then its content.
 *
 * What the site can know: there is no public list of apps in the API (Silicon Apps syncs apps to it privately), so a
 * version that names apps uses Team of Silicons' own, whose icons the site already has, linked to their pages on
 * Silicon Apps (apps.teamofsilicons.com/apps/<id>). Their names and that address need Anil's check.
 */
import type { ReactNode } from "react";
import { LayoutGrid, LogIn, MousePointerClick, ShieldCheck } from "lucide-react";
import { EmptyState } from "@teamofsilicons/silicon-ui/empty-state";
import { ButtonLink } from "@/components/foundation/button-link";
import { AppMark } from "@/components/account/parts/app-mark";
import { withAppIcon } from "@/components/account/parts/app-icons";
import { PageBar } from "@/components/account/parts/page-bar";
import { LinkItem, Row, Section, Tile } from "@/components/account/parts/rows";
import styles from "./apps-empty-lab.module.css";

const APPS_URL = "https://apps.teamofsilicons.com";
const OURS = [
  { app_id: "briefcase", name: "Briefcase" },
  { app_id: "dm", name: "Silicon DM" },
  { app_id: "ting", name: "Ting" },
  { app_id: "write", name: "Silicon Write" },
  { app_id: "silicon-writings", name: "Silicon Writings" },
];
const icon = (node: ReactNode) => <Tile>{node}</Tile>;
const browse = <ButtonLink href={APPS_URL} external variant="secondary" size="sm">Browse Silicon Apps</ButtonLink>;

const VERSIONS: Array<{ key: string; name: string; note: string; body: ReactNode }> = [
  {
    key: "today",
    name: "Today",
    note: "Silicon UI's empty state with the site's words. Says why it's empty, not what to do.",
    body: <EmptyState icon={<LayoutGrid width={24} height={24} strokeWidth={1.5} />} title="No apps yet" description="Apps show up here after you sign in to them with Silicon Accounts." />,
  },
  {
    key: "browse",
    name: "A  A way out",
    note: "The prototype's words (yours and your Silicons' sign-ins) and one button to Silicon Apps, where apps are found.",
    body: <EmptyState icon={<LayoutGrid width={24} height={24} strokeWidth={1.5} />} title="No apps yet" description="Apps appear here after you or your Silicons sign in." action={browse} />,
  },
  {
    key: "ours",
    name: "B  Apps to try",
    note: "One line on why it's empty, then Team of Silicons' own apps as rows, each to its page on Silicon Apps. Something to do at once; names and links need checking.",
    body: (
      <>
        <p className={styles.lead}>Apps appear here after you or your Silicons sign in.</p>
        <Section id="lab-ours" title="Apps to try">
          {OURS.map(app => (
            <LinkItem key={app.app_id} href={`${APPS_URL}/apps/${app.app_id}`} lead={<AppMark app={withAppIcon({ ...app, logo_url: null })} size={28} decorative />} title={app.name} detail="On Silicon Apps" />
          ))}
        </Section>
      </>
    ),
  },
  {
    key: "how",
    name: "C  How it works",
    note: "What happens when you connect an app, in three rows, with Browse Silicon Apps. Teaches the page before there's anything on it.",
    body: (
      <Section id="lab-how" title="No apps yet" description="Apps appear here after you or your Silicons sign in.">
        <Row lead={icon(<MousePointerClick size={16} strokeWidth={2} />)} title="Open an app" detail="Any app on Silicon Apps">{browse}</Row>
        <Row lead={icon(<LogIn size={16} strokeWidth={2} />)} title="Sign in with Silicon Accounts" detail="You choose what it can see" />
        <Row lead={icon(<ShieldCheck size={16} strokeWidth={2} />)} title="It shows up here" detail="Change what it sees, or remove it, at any time" />
      </Section>
    ),
  },
];

export function AppsEmptyLab() {
  return (
    <main className={styles.lab}>
      <header className={styles.intro}>
        <h1 className={styles.title}>Connected Apps, empty</h1>
        <p className={styles.lede}>What someone who has just joined sees after Home&rsquo;s Apps card, before any app is connected.</p>
      </header>
      {VERSIONS.map(version => (
        <section key={version.key} className={styles.version} aria-label={version.name}>
          <div>
            <h2 className={styles.name}>{version.name}</h2>
            <p className={styles.note}>{version.note}</p>
          </div>
          <div className={styles.stage}>
            <PageBar title="Connected Apps" />
            <div className={styles.page}>{version.body}</div>
          </div>
        </section>
      ))}
    </main>
  );
}
