"use client";

/**
 * /__share: "Share your details" from scratch, in four directions drawn from redesign/research/hosted-sign-in.md. Every
 * version is kept; a new idea is a new version. Nothing is sent. Built from Silicon UI and the site's tokens; the layouts,
 * hierarchy and words are new.
 *
 *   1 Provider sheet  Google and Microsoft: the account provider's bar on top, "Briefcase wants access to your Team of
 *                     Silicons account", the account under it, what is always seen, one box per extra with Select all,
 *                     "Make sure you trust Briefcase", Cancel and Continue side by side.
 *   1b Cut           1 cut to what it must say: the question, who, one sentence, a box per extra, two buttons, one line.
 *   2 Handshake       Supabase and Auth0: the two marks paired, "Connect Briefcase to your Team of Silicons account", one
 *                     sentence of what is always shared, "Signed in as" with a way out, the extras as chips, one
 *                     "Continue to Briefcase".
 *   3 Your card       Apple: what Briefcase will receive drawn as one card, filled live as the switches under it change;
 *                     one Continue.
 *   4 Permissions     GitHub and Slack: who made the app, Required and Optional as tables in plain words, Allow boxes,
 *                     "Authorize Briefcase", where it goes next, and a strip of facts about the app.
 *
 * A Case switch picks the data: "Briefcase today" (its live public settings and what its code uses: id and name only, so
 * no extra details, no tagline, no privacy or terms links) or "An app that asks for more" (sample). Each design hides
 * what the case doesn't have. Proposals the API doesn't support yet are marked in the page: who made the app and when
 * it joined (4), and the facts strip.
 */
import Link from "next/link";
import { createContext, useContext, useState, type ReactNode } from "react";
import { ArrowLeftRight, BadgeCheck, Cake, CalendarClock, Clock, ExternalLink, Globe, Lock, LogOut, Mail, Phone, ShieldCheck, UserRound, X } from "lucide-react";
import { Avatar } from "@teamofsilicons/silicon-ui/avatar";
import { Badge } from "@teamofsilicons/silicon-ui/badge";
import { Button } from "@teamofsilicons/silicon-ui/button";
import { Checkbox } from "@teamofsilicons/silicon-ui/checkbox";
import ChipGroup from "@teamofsilicons/silicon-ui/chip-group";
import SegmentedControl from "@teamofsilicons/silicon-ui/segmented-control";
import { Switch } from "@teamofsilicons/silicon-ui/switch";
import { AppMark } from "@/components/account/parts/app-mark";
import { AccountsGlyph } from "@/components/foundation/shell/brand-mark";
import styles from "./share-lab.module.css";

/* ------------------------------------------------------------------------------------------------ sample data */

const ACCOUNTS_ICON = { app_id: "silicon-accounts", name: "Team of Silicons", logo_url: "/icon-512.png" };
const ME = { name: "Saket Dev", id: "c:saket" };

interface Detail { key: string; label: string; plain: string; value: string | null; required: boolean; icon: ReactNode }
const SAMPLE_DETAILS: Detail[] = [
  { key: "email", label: "Email address", plain: "Email you and know it's you", value: "s***@gmail.com", required: true, icon: <Mail size={16} strokeWidth={2} /> },
  { key: "timezone", label: "Timezone", plain: "Show times in your local time", value: "Kolkata, Asia (UTC+05:30)", required: false, icon: <Clock size={16} strokeWidth={2} /> },
  { key: "dob", label: "Date of birth", plain: "Know your birthday", value: "Mar 14, 1998", required: false, icon: <Cake size={16} strokeWidth={2} /> },
  { key: "phone", label: "Phone number", plain: "Text you", value: null, required: false, icon: <Phone size={16} strokeWidth={2} /> },
];

/**
 * The cases (Anil, 2026-11-19: "does briefcase need this?… use real data"). Real: Briefcase as Silicon Accounts and its
 * code have it today: the app's public settings (name "Silicon Briefcase", briefcase.teamofsilicons.com, no tagline, no
 * privacy policy or terms links), and its code uses a person's id and name only, so it asks for no extra details. More:
 * an app that does ask (an email required; timezone, date of birth and a phone it doesn't have, optional), sample data.
 */
interface Case {
  app: { app_id: string; name: string; logo_url: string; tagline: string | null; domain: string; maker: string; since: string; privacy: boolean };
  details: Detail[];
}
const CASES: Record<string, { label: string; data: Case }> = {
  real: { label: "Briefcase today", data: { app: { app_id: "briefcase", name: "Silicon Briefcase", logo_url: "/icons/briefcase/web/icon-512-maskable.png", tagline: null, domain: "briefcase.teamofsilicons.com", maker: "Team of Silicons", since: "Sep 2026", privacy: false }, details: [] } },
  more: { label: "An app that asks for more (sample)", data: { app: { app_id: "briefcase", name: "Briefcase", logo_url: "/icons/briefcase/web/icon-512-maskable.png", tagline: "Your files, for every Carbon and Silicon.", domain: "briefcase.teamofsilicons.com", maker: "Team of Silicons", since: "Sep 2026", privacy: true }, details: SAMPLE_DETAILS } },
};
const CaseContext = createContext<Case>(CASES.real!.data);

/** The chosen case's app and details, split the way every design needs them. */
function useCase() {
  const { app, details } = useContext(CaseContext);
  const REQUIRED = details.filter(detail => detail.required);
  const OPTIONAL = details.filter(detail => !detail.required);
  const SHAREABLE = OPTIONAL.filter(detail => detail.value !== null);
  const MISSING = OPTIONAL.filter(detail => detail.value === null);
  // "your name, photo and CarbonID", or "…, CarbonID and email" when the email is required.
  const always = ["name", "photo", "CarbonID", ...REQUIRED.map(detail => detail.key === "email" ? "email" : detail.label.toLowerCase())];
  const seen = always.length > 1 ? `${always.slice(0, -1).join(", ")} and ${always.at(-1)}` : always[0];
  return { APP: app, REQUIRED, OPTIONAL, SHAREABLE, MISSING, seen };
}
const PROFILE = { label: "Name, photo and CarbonID", value: `${ME.name} · ${ME.id}` };

const noop = () => undefined;
const useChoice = () => {
  const [on, setOn] = useState<string[]>([]);
  return { on, setOn, toggle: (key: string, value: boolean) => setOn(current => (value ? [...current, key] : current.filter(item => item !== key))) };
};
function Mark({ size = 40 }: { size?: number }) {
  const { APP } = useCase();
  return <AppMark app={APP} size={size} decorative className={styles.ring} />;
}

/* ------------------------------------------------------------------------------------------------ 1 Provider sheet */

function ProviderSheet() {
  const { APP, REQUIRED, SHAREABLE, MISSING } = useCase();
  const { on, setOn, toggle } = useChoice();
  const all = on.length === SHAREABLE.length;
  return (
    <div className={styles.stage1}>
      <div className={styles.sheet1} data-sq="surface">
        <div className={styles.providerBar}>
          <span className={styles.glyph} aria-hidden="true"><AccountsGlyph /></span>
          Sign in with Team of Silicons
        </div>
        <div className={styles.sheet1Body}>
          <div className={styles.center}>
            <Mark size={48} />
            <h1 className={styles.title1}>{APP.name} wants access to your Team of Silicons account</h1>
            <span className={styles.chip1}><Avatar name={ME.name} size="sm" /> {ME.id}</span>
          </div>

          <section className={styles.block1} aria-labelledby="s1-always">
            <h2 id="s1-always" className={styles.label1}>{APP.name} will always see</h2>
            <ul className={styles.plainList}>
              <li><UserRound size={16} strokeWidth={2} aria-hidden="true" /><span><strong>{PROFILE.label}</strong> {PROFILE.value}</span></li>
              {REQUIRED.map(detail => <li key={detail.key}>{detail.icon}<span><strong>{detail.label}</strong> {detail.value}</span></li>)}
            </ul>
          </section>

          {SHAREABLE.length || MISSING.length ? <section className={styles.block1} aria-labelledby="s1-choose">
            <h2 id="s1-choose" className={styles.label1}>Select what else <span className={styles.accent}>{APP.name}</span> can see</h2>
            {SHAREABLE.length > 1 ? <div className={styles.selectAll}>
              <Checkbox label="Select all" checked={all ? true : on.length ? "indeterminate" : false} onCheckedChange={value => setOn(value === true ? SHAREABLE.map(detail => detail.key) : [])} />
            </div> : null}
            <div className={styles.checks}>
              {SHAREABLE.map(detail => <Checkbox key={detail.key} label={detail.label} description={detail.value ?? undefined} checked={on.includes(detail.key)} onCheckedChange={value => toggle(detail.key, value === true)} />)}
              {MISSING.map(detail => (
                <div key={detail.key} className={styles.missingRow}>
                  <span><strong>{detail.label}</strong><span className={styles.muted}>Not on your account yet</span></span>
                  <Button size="sm" variant="ghost" onClick={noop}>Add</Button>
                </div>
              ))}
            </div>
          </section> : null}

          <section className={styles.trust1} aria-labelledby="s1-trust">
            <h2 id="s1-trust" className={styles.label1}>Make sure you trust {APP.name}</h2>
            <p>You may be sharing personal details with this app. You can always see or remove its access in <Link href="/apps">Connected Apps</Link>.</p>
            {APP.privacy ? <p>See {APP.name}&rsquo;s <a href="#privacy">Privacy Policy</a> and <a href="#terms">Terms of Service</a>.</p> : null}
          </section>

          <div className={styles.pair}>
            <Button variant="secondary" onClick={noop}>Cancel</Button>
            <Button onClick={noop}>Continue</Button>
          </div>
        </div>
      </div>
      <p className={styles.under1}><span>English (United States)</span><span>Help · Privacy · Terms</span></p>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------ 1b Provider sheet, cut */

/**
 * 1 with everything cut that can be (Anil, 2026-11-19: "try cutting as much as you can"): the provider bar, the
 * question, who you are, one sentence for what is always shared, a box per extra (no Select all, no values, no missing
 * detail), one line for removing access and the app's policy, two buttons. No footer under the sheet.
 */
function ProviderCut() {
  const { APP, SHAREABLE, seen } = useCase();
  const { on, toggle } = useChoice();
  return (
    <div className={styles.stage1}>
      <div className={styles.sheet1} data-sq="surface">
        <div className={styles.providerBar}>
          <span className={styles.glyph} aria-hidden="true"><AccountsGlyph /></span>
          Sign in with Team of Silicons
        </div>
        <div className={styles.cutBody}>
          <div className={styles.center}>
            <h1 className={styles.title1}>{APP.name} wants access to your account</h1>
            <span className={styles.chip1}><Avatar name={ME.name} size="sm" /> {ME.id}</span>
          </div>
          <p className={styles.cutLine}>{APP.name} will see your {seen}.</p>
          {SHAREABLE.length ? <div className={styles.cutChecks}>
            {SHAREABLE.map(detail => <Checkbox key={detail.key} label={`Also share my ${detail.label.toLowerCase()}`} checked={on.includes(detail.key)} onCheckedChange={value => toggle(detail.key, value === true)} />)}
          </div> : null}
          <div className={styles.pair}>
            <Button variant="secondary" onClick={noop}>Cancel</Button>
            <Button onClick={noop}>Continue</Button>
          </div>
          <p className={styles.cutFoot}>Remove it any time in <Link href="/apps">Connected Apps</Link>{APP.privacy ? <> · <a href="#privacy">Privacy</a> · <a href="#terms">Terms</a></> : null}</p>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------ 2 Handshake */

function Handshake() {
  const { APP, SHAREABLE, MISSING, seen } = useCase();
  const [also, setAlso] = useState<string[]>([]);
  return (
    <div className={styles.stage2}>
      <div className={styles.card2} data-sq="surface">
        <div className={styles.pairMarks} aria-hidden="true">
          <AppMark app={APP} size={56} decorative className={styles.ring} />
          <ArrowLeftRight size={18} strokeWidth={2} />
          <AppMark app={ACCOUNTS_ICON} size={56} decorative className={styles.ring} />
        </div>
        <h1 className={styles.title2}>Connect {APP.name} to your Team of Silicons account</h1>
        <p className={styles.lead2}>{APP.name} will see your {seen}.</p>

        <div className={styles.signedIn} data-sq="surface">
          <Avatar name={ME.name} size="md" />
          <span className={styles.signedText}><span className={styles.muted}>Signed in as</span><span>{ME.id}</span></span>
          <Button size="sm" variant="ghost" aria-label="Use another account" onClick={noop}><LogOut size={16} strokeWidth={2} aria-hidden="true" /></Button>
        </div>

        {SHAREABLE.length || MISSING.length ? <div className={styles.also}>
          <p className={styles.alsoLabel}>Also share, if you like</p>
          <ChipGroup label="Also share" multiple options={SHAREABLE.map(detail => ({ value: detail.key, label: detail.label }))} value={also} onValueChange={setAlso} />
          {MISSING.length ? <p className={styles.muted}>Add a phone number in your account to share it.</p> : null}
        </div> : null}

        <div className={styles.stack2}>
          <Button size="lg" onClick={noop}>Continue to {APP.name}</Button>
          <Button variant="ghost" onClick={noop}>Cancel</Button>
        </div>
        <p className={styles.foot2}>You can remove {APP.name} any time in <Link href="/apps">Connected Apps</Link>.</p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------ 3 Your card */

function YourCard() {
  const { APP, REQUIRED, SHAREABLE, MISSING } = useCase();
  const { on, toggle } = useChoice();
  const shown = [...REQUIRED, ...SHAREABLE.filter(detail => on.includes(detail.key))];
  return (
    <div className={styles.stage3}>
      <div className={styles.sheet3} data-sq="surface">
        <div className={styles.sheet3Head}>
          <span className={styles.sheet3Title}>Sign in with Team of Silicons</span>
          <Button size="sm" variant="ghost" aria-label="Cancel" onClick={noop}><X size={16} strokeWidth={2} aria-hidden="true" /></Button>
        </div>
        <div className={styles.intro3}>
          <Mark size={40} />
          <h1 className={styles.title3}>Create your {APP.name} profile from your Team of Silicons account ({ME.id}).</h1>
        </div>

        {/* What Briefcase receives, drawn as the card it will hold; it changes as the switches below change. */}
        <figure className={styles.idCard} data-sq="surface" aria-label={`What ${APP.name} will receive`}>
          <div className={styles.idTop}>
            <Avatar name={ME.name} size="lg" />
            <div className={styles.idName}><strong>{ME.name}</strong><span className={styles.mono}>{ME.id}</span></div>
            <span className={styles.idFor}>for {APP.name}</span>
          </div>
          {shown.length ? <dl className={styles.idFields}>
            {shown.map(detail => (
              <div key={detail.key} className={styles.idField}><dt>{detail.label}</dt><dd>{detail.value}</dd></div>
            ))}
          </dl> : null}
        </figure>

        {SHAREABLE.length || MISSING.length ? <div className={styles.toggles} data-sq="surface">
          {SHAREABLE.map(detail => (
            <label key={detail.key} className={styles.toggleRow}>
              <span className={styles.toggleIcon} aria-hidden="true">{detail.icon}</span>
              <span className={styles.toggleText}><strong>{detail.label}</strong><span className={styles.muted}>{on.includes(detail.key) ? "On your card" : "Not shared"}</span></span>
              <Switch checked={on.includes(detail.key)} onCheckedChange={value => toggle(detail.key, value)} aria-label={`Share your ${detail.label.toLowerCase()} with ${APP.name}`} />
            </label>
          ))}
          {MISSING.map(detail => (
            <div key={detail.key} className={styles.toggleRow}>
              <span className={styles.toggleIcon} aria-hidden="true">{detail.icon}</span>
              <span className={styles.toggleText}><strong>{detail.label}</strong><span className={styles.muted}>Not on your account</span></span>
              <Button size="sm" variant="soft" onClick={noop}>Add</Button>
            </div>
          ))}
        </div> : null}

        <Button size="lg" className={styles.wide} onClick={noop}>Continue</Button>
        <p className={styles.foot3}>You can remove {APP.name} any time in <Link href="/apps">Connected Apps</Link>.{APP.privacy ? <> Your use of it is subject to its <a href="#privacy">privacy policy</a> and <a href="#terms">terms</a>.</> : null}</p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------ 4 Permissions */

function Permissions() {
  const { APP, REQUIRED, OPTIONAL } = useCase();
  const { on, toggle } = useChoice();
  return (
    <div className={styles.stage4}>
      <div className={styles.card4} data-sq="surface">
        <header className={styles.head4}>
          <Mark size={48} />
          <div className={styles.head4Text}>
            <h1 className={styles.title4}>Authorize {APP.name}</h1>
            <span className={styles.by}>by {APP.maker} <BadgeCheck size={14} strokeWidth={2} aria-label="Verified" /></span>
          </div>
          <span className={styles.who}><Avatar name={ME.name} size="sm" /><span className={styles.mono}>{ME.id}</span></span>
        </header>

        <section className={styles.can4} aria-labelledby="s4-can">
          <h2 id="s4-can" className={styles.label4}>{APP.name} will be able to</h2>
          <ul className={styles.canList}>
            <li><UserRound size={18} strokeWidth={1.75} aria-hidden="true" /><span><strong>Know who you are</strong><span className={styles.muted}>{PROFILE.label}</span></span></li>
            {REQUIRED.map(detail => <li key={detail.key}>{detail.icon}<span><strong>{detail.plain}</strong><span className={styles.muted}>{detail.label} ({detail.value})</span></span></li>)}
          </ul>
        </section>

        {OPTIONAL.length ? <section aria-labelledby="s4-optional">
          <h2 id="s4-optional" className={styles.label4}>Optional <span className={styles.muted}>off unless you allow it</span></h2>
          <table className={styles.table4}>
            <thead><tr><th scope="col">Allow</th><th scope="col">Detail</th><th scope="col">What {APP.name} gets</th></tr></thead>
            <tbody>
              {OPTIONAL.map(detail => (
                <tr key={detail.key}>
                  <td>{detail.value === null ? <Lock size={14} strokeWidth={2} aria-label="Not on your account" /> : <Checkbox checked={on.includes(detail.key)} onCheckedChange={value => toggle(detail.key, value === true)} aria-label={`Allow ${detail.label.toLowerCase()}`} />}</td>
                  <td><strong>{detail.label}</strong></td>
                  <td className={styles.muted}>{detail.value ?? "Not on your account yet"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section> : null}

        <div className={styles.actions4}>
          <Button variant="secondary" onClick={noop}>Cancel</Button>
          <Button onClick={noop}>Authorize {APP.name}</Button>
        </div>
        <p className={styles.redirect}>Authorizing will take you to <strong>https://{APP.domain}</strong></p>
      </div>
      {/* Facts about the app (a proposal: the API has no maker, verification or join date for apps yet). */}
      <ul className={styles.facts} data-sq="surface">
        <li><ShieldCheck size={16} strokeWidth={2} aria-hidden="true" /><span><strong>Made by</strong> {APP.maker}</span></li>
        <li><CalendarClock size={16} strokeWidth={2} aria-hidden="true" /><span><strong>On Silicon Apps</strong> since {APP.since}</span></li>
        <li><Globe size={16} strokeWidth={2} aria-hidden="true" /><span><strong>Website</strong> {APP.domain} <ExternalLink size={12} strokeWidth={2} aria-hidden="true" /></span></li>
      </ul>
      <p className={styles.proposal}><Badge size="sm" tone="neutral">Proposal</Badge> Maker, verified mark and the facts strip need the API.</p>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------ the lab */

const DESIGNS = {
  provider: { label: "1 Provider sheet", View: ProviderSheet },
  cut: { label: "1b Cut", View: ProviderCut },
  handshake: { label: "2 Handshake", View: Handshake },
  card: { label: "3 Your card", View: YourCard },
  permissions: { label: "4 Permissions", View: Permissions },
} as const;

export function ShareLab() {
  const [design, setDesign] = useState<keyof typeof DESIGNS>("provider");
  const [caseKey, setCaseKey] = useState<keyof typeof CASES>("real");
  const { View } = DESIGNS[design];
  return (
    <>
      <div className={styles.bar} role="toolbar" aria-label="Share lab">
        <SegmentedControl size="sm" label="Design" options={Object.entries(DESIGNS).map(([value, entry]) => ({ value, label: entry.label }))} value={design} onValueChange={value => setDesign(value as keyof typeof DESIGNS)} />
        <SegmentedControl size="sm" label="Case" options={Object.entries(CASES).map(([value, entry]) => ({ value, label: entry.label }))} value={caseKey} onValueChange={value => setCaseKey(value as keyof typeof CASES)} />
      </div>
      <main className={styles.page}>
        <CaseContext.Provider value={CASES[caseKey]!.data}>
          <View key={`${design}-${caseKey}`} />
        </CaseContext.Provider>
      </main>
    </>
  );
}
