"use client";

/**
 * /__landing: the signed-out landing page in the account site's own look, with real screens of the account app
 * (Anil, 2026-11-19: "we're just experimenting"). Allo through the site's type roles, the site's tokens, Silicon UI
 * buttons, and the sidebar itself (Silicon UI NavList) as the way through the screens. The page at "/" is unchanged.
 *
 * Words: the hero and How it works are the landing's own (components/landing, landing/apps/accounts/copy.md); the
 * tour's labels and lines are the sidebar's (lib/navigation.ts SECTIONS). No other words are invented here.
 *
 * Screens: public/landing-lab/<screen>.png, captured with `pnpm screens` on the mock API (sample people: Saket Dev,
 * Scout, Briefcase), cropped to the first view. The site is light only (lib/theme.ts), so each screen has one picture.
 */
import Image from "next/image";
import { useState } from "react";
import { NavItem, NavList } from "@teamofsilicons/silicon-ui/nav-list";
import { ButtonLink } from "@/components/foundation/button-link";
import { AccountsGlyph } from "@/components/foundation/shell/brand-mark";
import { SECTIONS, type SectionKey } from "@/lib/navigation";
import styles from "./landing-lab.module.css";

const SIGN_UP = "/sign-in?intent=signup";
const SIGN_IN = "/sign-in";

/** A captured screen of the account app. */
function Shot({ name, alt, width, height, priority, className }: { name: string; alt: string; width: number; height: number; priority?: boolean; className?: string }) {
  return <Image className={className} src={`/landing-lab/${name}.png`} alt={alt} width={width} height={height} priority={priority} unoptimized />;
}

/** The sidebar sections the tour walks through, with the screen each opens. */
const TOUR: Array<{ key: SectionKey; shot: string }> = [
  { key: "home", shot: "home" },
  { key: "silicons", shot: "silicons" },
  { key: "apps", shot: "apps" },
  { key: "security", shot: "security" },
];

const STEPS = [
  { title: "Sign in", body: "With a code sent to your email or phone, or with Google or Apple. The app decides which of these it offers.", shot: "sign-in", width: 466, height: 598 },
  { title: "See what's shared", body: "The first time you sign into an app, and whenever it asks for more, you see exactly what it will get. Optional details stay unticked until you tick them.", shot: "consent", width: 466, height: 862 },
  { title: "Take it back", body: "Every app you've signed into is listed in your account. Remove an app's access whenever you want.", shot: "app-page", width: 390, height: 620 },
];

function TopBar() {
  return (
    <header className={styles.bar}>
      <a className={styles.brand} href="/__landing" aria-label="Team of Silicons Accounts">
        <span className={styles.mark}><AccountsGlyph /></span>
        <span>Team of Silicons <span className={styles.product}>Accounts</span></span>
      </a>
      <div className={styles.barActions}>
        <ButtonLink href={SIGN_IN} variant="ghost" size="sm">Sign In</ButtonLink>
        <ButtonLink href={SIGN_UP} size="sm">Create Account</ButtonLink>
      </div>
    </header>
  );
}

function Tour() {
  const [open, setOpen] = useState<SectionKey>("home");
  const sections = TOUR.map(item => ({ ...item, section: SECTIONS.find(section => section.key === item.key)! }));
  const current = sections.find(item => item.key === open) ?? sections[0]!;
  return (
    <section className={styles.tour} data-sq="surface" aria-label="Inside your account">
      <div className={styles.tourSide}>
        <NavList label="Inside your account">
          {sections.map(({ key, section }) => {
            const Icon = section.icon;
            return (
              <NavItem key={key} icon={<Icon size={16} strokeWidth={2} />} active={key === open} onSelect={() => setOpen(key)}>
                {section.label}
              </NavItem>
            );
          })}
        </NavList>
        <p className={styles.tourLine} aria-live="polite">{current.section.description}</p>
        <figure className={styles.switcher}>
          <div className={styles.switcherShot} data-sq="clip">
            <Shot name="switcher" alt="The account switcher at the sidebar's foot, with four signed-in accounts" width={332} height={320} />
          </div>
        </figure>
      </div>
      {/* The screen as a computer shows it, or as a phone does at phone widths (landing-lab.module.css). */}
      <div className={styles.window} data-sq="clip">
        <Shot className={styles.wide} name={current.shot} alt={`Silicon Accounts: ${current.section.label}`} width={1166} height={882} priority />
        <Shot className={styles.narrow} name={`${current.shot}-phone`} alt={`Silicon Accounts on a phone: ${current.section.label}`} width={390} height={844} />
      </div>
    </section>
  );
}

export function LandingLab() {
  return (
    <div className={styles.page}>
      <TopBar />
      <main className={styles.main}>
        <section className={styles.hero}>
          <div className={styles.heroCopy}>
            <h1 className={styles.heading}>One account for every app you sign into. You choose what each one gets.</h1>
            <p className={styles.lede}>
              Silicon Accounts is the personal account you carry into every app that signs in with it. The first time an app asks for your details, you see exactly what it wants. You can remove its access whenever you want.
            </p>
            <div className={styles.actions}>
              <ButtonLink href={SIGN_UP} size="lg">Create Your Account</ButtonLink>
              <ButtonLink href={SIGN_IN} variant="secondary" size="lg">Sign In</ButtonLink>
            </div>
          </div>
        </section>

        <Tour />

        <section className={styles.how} aria-labelledby="lab-how">
          <div className={styles.sectionHead}>
            <p className={styles.eyebrow}>How it works</p>
            <h2 id="lab-how" className={styles.h2}>See what every app gets, and take it back.</h2>
            <p className={styles.lede}>Sign in with what the app offers, check what it&rsquo;s asking for, and remove its access whenever you want.</p>
          </div>
          <ol className={styles.steps}>
            {STEPS.map((step, index) => (
              <li key={step.title} className={styles.step}>
                <div className={styles.stepShot} data-sq="clip">
                  <Shot name={step.shot} alt="" width={step.width} height={step.height} />
                </div>
                <p className={styles.stepNumber}>{String(index + 1).padStart(2, "0")}</p>
                <h3 className={styles.h3}>{step.title}</h3>
                <p className={styles.stepBody}>{step.body}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className={styles.close} aria-label="Get started">
          <div className={styles.actions}>
            <ButtonLink href={SIGN_UP} size="lg">Create Your Account</ButtonLink>
            <ButtonLink href={SIGN_IN} variant="secondary" size="lg">Sign In</ButtonLink>
          </div>
        </section>
      </main>
    </div>
  );
}
