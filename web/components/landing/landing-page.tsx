"use client";

/**
 * The signed-out page, the Columns hero from the landing framework (Figma node 72:39):
 * the TOS nav, GT Alpina heading, brand-blue buttons, and the Columns shader.
 */
import Image from "next/image";
import { ShaderFill } from "./figma-shader/index";
import { accentShader, columnsShader } from "./columns-shader";
import { HowItWorks } from "./how-it-works";
import styles from "./landing.module.css";

const NAV = [
  { href: "https://teamofsilicons.com/products", label: "Products", menu: true },
  { href: "https://starter.teamofsilicons.com", label: "Starter" },
  // Developers is this stack's own developer site (the API's developer_url, read on the server by PublicLanding), so
  // local and staging builds link to theirs.
  { href: "developer", label: "Developers" },
  { href: "https://writings.teamofsilicons.com", label: "Writings" },
] as const;

export function LandingPage({ developerUrl }: { developerUrl: string }) {
  return (
    <div className={styles.page}>
      <a className="skip-link" data-sq="surface" href="#main">Skip to content</a>
      <header className={styles.nav}>
        <div className={styles.navLeft}>
          <a className={styles.logo} href="https://teamofsilicons.com" aria-label="Team of Silicons">
            <Image src="/brand/tos-logo.svg" alt="" width={167} height={24} />
          </a>
          <nav className={styles.navLinks} aria-label="Team of Silicons">
            {NAV.map(item => (
              <a key={item.label} href={item.href === "developer" ? developerUrl : item.href}>
                {item.label}
                {"menu" in item ? <Image src="/brand/nav-chevron.svg" alt="" width={16} height={16} /> : null}
              </a>
            ))}
          </nav>
        </div>
        <div className={styles.navActions}>
          <a className={styles.github} href="https://github.com/teamofsilicons" aria-label="GitHub">
            <Image src="/brand/github.svg" alt="" width={20} height={20} />
          </a>
          <a className={styles.secondary} href="/sign-in">Sign in</a>
          <a className={styles.primary} href="/sign-in?intent=signup">Create account</a>
        </div>
      </header>
      <main id="main" className={styles.hero} tabIndex={-1}>
        <ShaderFill className={styles.shader} shader={columnsShader} />
        <div className={styles.accent} aria-hidden="true">
          <ShaderFill shader={accentShader} width={1440} height={700} />
        </div>
        <div className={styles.content}>
          <div className={styles.copy}>
            <div className={styles.heading}>
              <p className={styles.eyebrow}>Silicon Accounts</p>
              <h1>One account for every app you sign into. You choose what each one gets.</h1>
            </div>
            <p className={styles.lede}>
              Silicon Accounts is the personal account you carry into every app that signs in with it. The first time an app asks for your details, you see exactly what it wants. You can remove its access whenever you want.
            </p>
            <div className={styles.actions}>
              <a className={styles.primary} href="/sign-in?intent=signup">Create your account</a>
              <a className={styles.secondary} href="/sign-in">Sign in</a>
            </div>
          </div>
        </div>
      </main>
      <HowItWorks />
    </div>
  );
}
