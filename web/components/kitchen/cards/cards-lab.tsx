"use client";

/**
 * /__cards: the card for Silicons and apps (Anil, 2026-11-11), development only, like /__banner and /__needs. Each
 * card system shows Your Silicons and Your apps in one anatomy, at Home's 800px column, three a row, so the two
 * sections read as one family. All of them follow Home's card rules (the 2026-11-11 spacing audit): a clear border and
 * no resting shadow (a shadow on hover), 12px inside, 2px from title to line, 28px marks, body titles.
 *
 *   1  Tile: a mark beside the title and one line; the whole card is the link. Home today, tidied.
 *   2  Tile + footer: the same, then a hairline and a footer: a fact at the start, the action at the end.
 *   3  Picture: a band on top (a Silicon's own colours; an app's picture), then the title and its line.
 *   4  Stacked: the mark on top, the title, two lines, the action at the foot.
 *
 * Sample data, but only what the API gives: a Silicon's name, si:id, status (active, waiting for a custodian), when its
 * key last changed; an app's name, its line (Anil's words for the popular ones), whether you've signed in and when.
 */
import type { CSSProperties, ReactNode } from "react";
import { useState } from "react";
import { BellIcon, BriefcaseIcon, ChatsCircleIcon, type Icon } from "@phosphor-icons/react";
import { ChevronRight, Plus } from "lucide-react";
import { Button } from "@teamofsilicons/silicon-ui/button";
import SegmentedControl from "@teamofsilicons/silicon-ui/segmented-control";
import { AppMark } from "@/components/account/parts/app-mark";
import { withAppIcon } from "@/components/account/parts/app-icons";
import { pairOf, SiliconMark } from "@/components/account/parts/silicon-mark";
import styles from "./cards-lab.module.css";

interface SiliconItem { uuid: string; name: string; id: string; fact: string; tone?: "warning"; pending?: boolean }
interface AppItem { id: string; name: string; icon: Icon; line: string; fact: string; joined: boolean; picture: string; activity: string }

const SILICONS: SiliconItem[] = [
  { uuid: "lab-zap", name: "zap", id: "si:zap", fact: "Key never changed" },
  { uuid: "lab-anil", name: "anil", id: "si:anil", fact: "Key changed 3 weeks ago" },
  { uuid: "lab-researcher", name: "Researcher", id: "si:researcher", fact: "Waiting for a custodian", tone: "warning", pending: true },
];
const APPS: AppItem[] = [
  { id: "briefcase", name: "Silicon Briefcase", icon: BriefcaseIcon, line: "Keep and share files with your Silicons.", fact: "Signed in 2 days ago", joined: true, picture: "110", activity: "3 files shared with you" },
  { id: "dm", name: "Silicon DM", icon: ChatsCircleIcon, line: "Message people and Silicons directly.", fact: "Signed in today", joined: true, picture: "102", activity: "5 unread messages" },
  { id: "ting", name: "Silicon Ting", icon: BellIcon, line: "Get notified when your Silicons need you.", fact: "Not signed in yet", joined: false, picture: "127", activity: "2 new notifications" },
];

const SYSTEMS: { id: string; name: string; note: string; silicon: (item: SiliconItem) => ReactNode; app: (item: AppItem) => ReactNode; newSilicon: ReactNode }[] = [
  { id: "tile", name: "1 · Tile", note: "A mark beside the title and one line; the whole card is the link, a chevron at the end. The calmest and most compact: Home today, made one family.", silicon: s => <Tile mark={<SiliconMark seed={s.uuid} size={28} pending={s.pending} />} title={s.name} line={s.id} mono />, app: a => <Tile mark={<AppIcon icon={a.icon} />} title={a.name} line={a.line} />, newSilicon: <NewTile /> },
  { id: "footer", name: "2 · Tile + footer", note: "The tile, then a hairline and a footer: one fact at the start (when its key changed; when you last signed in), the action at the end. Says the most at a glance.", silicon: s => <Footer mark={<SiliconMark seed={s.uuid} size={28} pending={s.pending} />} title={s.name} line={s.id} mono fact={s.fact} tone={s.tone} action="Open" />, app: a => <Footer mark={<AppIcon icon={a.icon} />} title={a.name} line={a.line} fact={a.fact} action={a.joined ? "Open" : "Try"} primary={!a.joined} />, newSilicon: <NewTile tall /> },
  { id: "picture", name: "3 · Picture", note: "A band on top: a Silicon in its own colours (its mark's pair), an app in its picture; then the title and its line. The same family as the introduction's picture cards.", silicon: s => <PictureCard band={<span className={styles.band} style={siliconBand(s.uuid)} />} title={s.name} line={s.id} mono fact={s.fact} tone={s.tone} />, app: a => <PictureCard band={<span className={styles.band} style={{ backgroundImage: `url("/banner/bg-${a.picture}.webp")` }} />} title={a.name} line={a.line} fact={a.fact} />, newSilicon: <NewTile picture /> },
  { id: "stacked", name: "4 · Stacked", note: "The mark on top, the title, two lines, the action at the foot. Roomier: each card reads on its own, like today's app cards without the watermark.", silicon: s => <Stacked mark={<SiliconMark seed={s.uuid} size={28} pending={s.pending} />} title={s.name} line={s.id} mono fact={s.fact} tone={s.tone} action="Open" />, app: a => <Stacked mark={<AppIcon icon={a.icon} />} title={a.name} line={a.line} fact={a.fact} action={a.joined ? "Open" : "Try"} primary={!a.joined} />, newSilicon: <NewTile tall /> },
];

export function CardsLab() {
  const [count, setCount] = useState("3");
  const silicons = SILICONS.slice(0, Number(count));
  return (
    <main className={styles.lab}>
      <header className={styles.intro}>
        <h1 className={styles.title}>Silicon and app cards</h1>
        <p className={styles.lede}>One card family for Your Silicons and Your apps, in four systems, at Home&rsquo;s content column. Sample words; nothing here acts.</p>
        <SegmentedControl size="sm" label="Silicons" options={[{ value: "1", label: "One Silicon" }, { value: "2", label: "Two" }, { value: "3", label: "Three" }]} value={count} onValueChange={setCount} />
      </header>
      <AppLayouts />
      <AppSpacing />
      <AppSpec />
      {SYSTEMS.map(system => (
        <section key={system.id} className={styles.system} aria-labelledby={`system-${system.id}`}>
          <div className={styles.systemHead}>
            <h2 id={`system-${system.id}`} className={styles.systemName}>{system.name}</h2>
            <p className={styles.systemNote}>{system.note}</p>
          </div>
          <div className={styles.stage}>
            <div className={styles.column}>
              <Section title="Your Silicons">
                {silicons.map(item => <li key={item.uuid}>{system.silicon(item)}</li>)}
                {silicons.length < 3 ? <li>{system.newSilicon}</li> : null}
              </Section>
              <Section title="Your apps">
                {APPS.map(item => <li key={item.id}>{system.app(item)}</li>)}
              </Section>
            </div>
          </div>
        </section>
      ))}
    </main>
  );
}

/* Parts -------------------------------------------------------------------------------------------------------- */

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={styles.section}>
      <div className={styles.head}><h3 className={styles.sectionTitle}>{title}</h3><span className={styles.seeAll}>See all</span></div>
      <ul className={styles.grid}>{children}</ul>
    </section>
  );
}

const AppIcon = ({ icon: IconMark }: { icon: Icon }) => (
  <span data-sq="surface" className={styles.appIcon} aria-hidden="true"><IconMark size={18} weight="regular" /></span>
);

function siliconBand(seed: string): CSSProperties {
  const pair = pairOf(seed);
  return { backgroundImage: `linear-gradient(135deg, var(--silicon-mark-${pair}-from), var(--silicon-mark-${pair}-to))` };
}

function Words({ title, line, mono }: { title: string; line: string; mono?: boolean }) {
  return (
    <span className={styles.words}>
      <span className={styles.cardTitle}>{title}</span>
      <span className={mono ? styles.cardId : styles.cardLine}>{line}</span>
    </span>
  );
}

function Fact({ fact, tone }: { fact: string; tone?: "warning" }) {
  return <span className={styles.fact} data-tone={tone}>{fact}</span>;
}

/* 1 · Tile */
function Tile({ mark, title, line, mono }: { mark: ReactNode; title: string; line: string; mono?: boolean }) {
  return (
    <a href="#cards" data-sq="surface" className={`${styles.card} ${styles.tile}`}>
      {mark}
      <Words title={title} line={line} mono={mono} />
      <ChevronRight className={styles.chevron} size={16} strokeWidth={2} aria-hidden="true" />
    </a>
  );
}

/* 2 · Tile + footer */
function Footer({ mark, title, line, mono, fact, tone, action, primary, activity }: { mark: ReactNode; title: string; line: string; mono?: boolean; fact: string; tone?: "warning"; action: string; primary?: boolean; activity?: boolean }) {
  return (
    <div data-sq="surface" className={`${styles.card} ${styles.footerCard}`} data-activity={activity ? "" : undefined}>
      <div className={styles.footerTop}>{mark}<Words title={title} line={line} mono={mono} /></div>
      <div className={styles.footer}>
        <Fact fact={fact} tone={tone} />
        <Button variant={primary ? "soft" : "secondary"} size="xs">{action}</Button>
      </div>
    </div>
  );
}

/* 3 · Picture */
function PictureCard({ band, title, line, mono, fact, tone }: { band: ReactNode; title: string; line: string; mono?: boolean; fact: string; tone?: "warning" }) {
  return (
    <a href="#cards" data-sq="clip" className={`${styles.card} ${styles.pictureCard}`}>
      {band}
      <span className={styles.pictureWords}>
        <Words title={title} line={line} mono={mono} />
        <Fact fact={fact} tone={tone} />
      </span>
    </a>
  );
}

/* 4 · Stacked */
function Stacked({ mark, title, line, mono, fact, tone, action, primary }: { mark: ReactNode; title: string; line: string; mono?: boolean; fact: string; tone?: "warning"; action: string; primary?: boolean }) {
  return (
    <div data-sq="surface" className={`${styles.card} ${styles.stacked}`}>
      {mark}
      <Words title={title} line={line} mono={mono} />
      <Fact fact={fact} tone={tone} />
      <div className={styles.stackedAction}><Button variant={primary ? "soft" : "secondary"} size="sm">{action}</Button></div>
    </div>
  );
}

/* New Silicon, in each system's shape: quiet, grey, a plus. */
function NewTile({ tall, picture }: { tall?: boolean; picture?: boolean }) {
  return (
    <a href="#cards" data-sq="surface" className={`${styles.card} ${styles.newCard}`} data-tall={tall ? "" : undefined} data-picture={picture ? "" : undefined}>
      <span data-sq="surface" className={styles.plus} aria-hidden="true"><Plus size={16} strokeWidth={1.75} /></span>
      <span className={styles.cardTitle}>New Silicon</span>
    </a>
  );
}

/* Apps · Tile + footer, Anil's spec (2026-11-11) ---------------------------------------------------------------- */

/**
 * Your apps as tile + footer, for the two kinds of Carbon: the first time (the app's icon, name and description; in the
 * footer that they haven't signed in yet, and Try) and an existing user (icon, name, and what's new in the app: unread
 * messages, notifications; in the footer when they last signed in, and Open). The activity line is sample data: the
 * account API doesn't know an app's messages or notifications, so it needs each app to give a count.
 */
function AppSpec() {
  const firstTime = APPS.map(app => ({ ...app, fact: "Not signed in yet", joined: false }));
  const existing = APPS.map((app, index) => ({ ...app, fact: ["Signed in 2 days ago", "Signed in today", "Signed in last week"][index]!, joined: true }));
  return (
    <section className={styles.system} aria-labelledby="system-apps-spec">
      <div className={styles.systemHead}>
        <h2 id="system-apps-spec" className={styles.systemName}>Apps · Tile + footer <span className={styles.badge}>Anil&rsquo;s spec</span></h2>
        <p className={styles.systemNote}>The first time: the app&rsquo;s icon, name and description, then a footer with &ldquo;Not signed in yet&rdquo; and Try. An existing user: icon, name and what&rsquo;s new in the app, then a footer with when they last signed in and Open. The activity lines are sample data: Silicon Accounts doesn&rsquo;t know an app&rsquo;s messages or notifications, so each app would have to give a count.</p>
      </div>
      <div className={styles.stage}>
        <div className={styles.column}>
          <Section title="Your apps · first time">
            {firstTime.map(item => <li key={item.id}><Footer mark={<AppIcon icon={item.icon} />} title={item.name} line={item.line} fact={item.fact} action="Try" primary /></li>)}
          </Section>
          <Section title="Your apps · existing user">
            {existing.map(item => <li key={item.id}><Footer mark={<AppIcon icon={item.icon} />} title={item.name} line={item.activity} fact={item.fact} action="Open" activity /></li>)}
          </Section>
        </div>
      </div>
    </section>
  );
}

/* Apps · Home's card, spacing (Anil, 2026-11-10) ---------------------------------------------------------------- */

/**
 * Home's app card as it is now (Anil's icons at 32px with a hairline, name, line, a footer with a fact and Open or Try),
 * in several paddings, to find one that feels even. Each sets the top's padding and the footer's; every value is a
 * spacing token. The ones Anil tried on Home are kept: 12 (the first), 8 (now) and 8 with 16 below (not even).
 */
const SPACINGS: { id: string; name: string; note: string; top: string; footer: string }[] = [
  { id: "first", name: "A · 12, footer 8 × 12", note: "The first version: 12 around the top, the footer 8 high and 12 at the sides, so both share one left edge.", top: "var(--space-group)", footer: "var(--space-related) var(--space-group)" },
  { id: "eight", name: "B · 8 all round (Home now)", note: "8 everywhere: the tightest, one edge for everything.", top: "var(--space-related)", footer: "var(--space-related)" },
  { id: "below", name: "C · 8, 16 below (tried, not even)", note: "8 above and at the sides, 16 under the words: the space under the words doesn't match anything else.", top: "var(--space-related) var(--space-related) var(--space-inset)", footer: "var(--space-related)" },
  { id: "twelve", name: "D · 12 all round", note: "12 everywhere, the footer too: taller, one rhythm for the top and the footer.", top: "var(--space-group)", footer: "var(--space-group)" },
  { id: "sixteen", name: "E · 16, footer 12 × 16", note: "16 around the top, the footer 12 high and 16 at the sides: the roomiest, like Adobe's cards.", top: "var(--space-inset)", footer: "var(--space-group) var(--space-inset)" },
  { id: "footer", name: "F · 8, footer 12 × 8", note: "8 around the top, a taller footer (12 high, 8 at the sides): the height goes to the footer instead.", top: "var(--space-related)", footer: "var(--space-group) var(--space-related)" },
];
const HOME_APPS = [
  { id: "write", name: "Silicon Write", line: "write.teamofsilicons.com", fact: "Signed in 2 weeks ago", joined: true },
  { id: "dm", name: "Silicon DM", line: "Message people and Silicons directly.", fact: "Signed in 3 weeks ago", joined: true },
  { id: "briefcase", name: "Silicon Briefcase", line: "Keep and share files with your Silicons.", fact: "Not signed in yet", joined: false },
];

function AppSpacing() {
  return (
    <section className={styles.system} aria-labelledby="system-app-spacing">
      <div className={styles.systemHead}>
        <h2 id="system-app-spacing" className={styles.systemName}>Apps · Home&rsquo;s card, spacing</h2>
        <p className={styles.systemNote}>Home&rsquo;s app card as it is today (your icons at 32px with a hairline), in six paddings. The gap between the icon and the words stays 12.</p>
      </div>
      <div className={styles.stage}>
        <div className={styles.column}>
          {SPACINGS.map(spacing => (
            <div key={spacing.id} className={styles.spacing} style={{ "--top-pad": spacing.top, "--foot-pad": spacing.footer } as CSSProperties}>
              <div className={styles.systemHead}>
                <h3 className={styles.spacingName}>{spacing.name}</h3>
                <p className={styles.systemNote}>{spacing.note}</p>
              </div>
              <ul className={styles.grid}>
                {HOME_APPS.map(app => (
                  <li key={app.id}>
                    <div data-sq="surface" className={styles.homeCard}>
                      <div className={styles.homeTop}>
                        <AppMark app={withAppIcon({ app_id: app.id, name: app.name, logo_url: null })} size={32} className={styles.homeMark} decorative />
                        <span className={styles.homeWords}>
                          <span className={styles.homeName}>{app.name}</span>
                          <span className={styles.homeLine}>{app.line}</span>
                        </span>
                      </div>
                      <div className={styles.homeFooter}>
                        <span className={styles.homeFact}>{app.fact}</span>
                        <Button variant={app.joined ? "secondary" : "soft"} size="xs">{app.joined ? "Open" : "Try"}</Button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* Apps · Home's card, layouts (Anil, 2026-11-10) ---------------------------------------------------------------- */

/**
 * Home's app card, two layouts, both 8px all round with the top at least 112px and 40px icons:
 *   Beside  the name over its line beside the icon (Anil: "a good version", 2026-11-10); Home now
 *   Below   the name beside the icon, centred on it; the line below at full width (tried, taken back)
 * Both put the time in "Signed in 2 weeks ago" in the text colour, since it is the information (kept on Home).
 */
function AppLayouts() {
  return (
    <section className={styles.system} aria-labelledby="system-app-layouts">
      <div className={styles.systemHead}>
        <h2 id="system-app-layouts" className={styles.systemName}>Apps · Home&rsquo;s card, layouts <span className={styles.badge}>Now</span></h2>
        <p className={styles.systemNote}>Both 8px all round, the top at least 112px, your icons at 40px. Beside is on Home; Below was tried and taken back. Both show the time in &ldquo;Signed in 2 weeks ago&rdquo; in the text colour.</p>
      </div>
      <div className={styles.stage}>
        <div className={styles.column}>
          {(["beside", "below"] as const).map(layout => (
            <div key={layout} className={styles.spacing} style={{ "--top-pad": "var(--space-related)", "--foot-pad": "var(--space-related)" } as CSSProperties}>
              <h3 className={styles.spacingName}>{layout === "beside" ? "Beside · the words beside the icon (Home now)" : "Below · the line below the icon (tried)"}</h3>
              <ul className={styles.grid}>
                {HOME_APPS.map(app => {
                  const mark = <AppMark app={withAppIcon({ app_id: app.id, name: app.name, logo_url: null })} size={40} className={styles.homeMark} decorative />;
                  const when = app.joined ? app.fact.replace("Signed in ", "") : null;
                  return (
                    <li key={app.id}>
                      <div data-sq="surface" className={styles.homeCard}>
                        {layout === "beside" ? (
                          <div className={`${styles.homeTop} ${styles.tallTop}`}>
                            {mark}
                            <span className={styles.homeWords}><span className={styles.homeName}>{app.name}</span><span className={styles.homeLine}>{app.line}</span></span>
                          </div>
                        ) : (
                          <div className={`${styles.belowTop} ${styles.tallTop}`}>
                            <div className={styles.belowHead}>{mark}<span className={styles.homeName}>{app.name}</span></div>
                            <span className={styles.homeLine}>{app.line}</span>
                          </div>
                        )}
                        <div className={styles.homeFooter}>
                          <span className={styles.homeFact}>{when ? <>Signed in <span className={styles.homeWhen}>{when}</span></> : app.fact}</span>
                          <Button variant={app.joined ? "secondary" : "soft"} size="xs">{app.joined ? "Open" : "Try"}</Button>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
