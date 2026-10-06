"use client";

/**
 * The page every hosted sign-in step renders in: the app's branding painted on its own subtree (BrandingScope), the
 * layout the app chose (card, split or minimal), its logo and name, and "Powered by Silicon Accounts", which lives
 * outside the branded subtree so no branding can restyle or hide it.
 *
 * Silicon Accounts' own pages (device approval, the account site's sign-in, problems with no app, the first-party
 * flow) wear the site's brand tokens instead of an app's branding.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { BrandAside, BrandPanel, BrandStage, BrandingScope, PoweredBy } from "@/components/foundation/branding/branding";
import { useTheme } from "@/components/foundation/theme/use-theme";
import type { Branding } from "@/lib/api/types";
import { brandLogo, resolveBrandTheme, type PaintTheme } from "@/lib/branding/apply";
import { normalizeBranding } from "@/lib/branding/defaults";
import { legibleBranding } from "./legible";
import type { FrameApp } from "./model";
import styles from "./flow.module.css";

/** The Silicon Accounts mark, for the account site's own sign-in (the first-party app has no logo of its own). */
const SILICON_ACCOUNTS_MARK = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path fill="#1F5FB8" d="M32 0c19.6 0 25.4 1.4 28.6 3.4C62.6 6.6 64 12.4 64 32s-1.4 25.4-3.4 28.6C57.4 62.6 51.6 64 32 64S6.6 62.6 3.4 60.6C1.4 57.4 0 51.6 0 32S1.4 6.6 3.4 3.4C6.6 1.4 12.4 0 32 0Z"/><circle cx="32" cy="25" r="9" fill="#FFFDF9"/><path fill="#FFFDF9" d="M15 49c2.6-8 9.2-12.5 17-12.5S46.4 41 49 49c-4.6 3-10.4 4.6-17 4.6S19.6 52 15 49Z"/></svg>')}`;

/** The paint theme of a branding for this visitor: the app's forced theme, else the visitor's own. */
export function usePaint(app: FrameApp | null, site: boolean): PaintTheme {
  const { theme } = useTheme();
  const mode = normalizeBranding(app?.branding as Partial<Branding> | undefined).theme;
  return site ? theme : resolveBrandTheme(mode, theme);
}

/** The app's logo and name, as its branding asks. */
export function AppIdentity({ app, paint, hideName, className }: { app: FrameApp | null; paint: PaintTheme; hideName?: boolean; className?: string }) {
  const branding = normalizeBranding(app?.branding as Partial<Branding> | undefined);
  const own = app ? brandLogo(branding, { logo_url: app.logo_url ?? null, logo_dark_url: app.logo_dark_url ?? null }, paint) : null;
  const logo = own ?? (app?.app_id === "accounts" ? SILICON_ACCOUNTS_MARK : null);
  const [broken, setBroken] = useState<string | null>(null);
  if (!app || (!logo && !branding.show_app_name)) return null;
  const showLogo = !!logo && broken !== logo;
  const showName = (branding.show_app_name && !hideName) || !showLogo;
  return (
    <div className={["sa-brand-header", className].filter(Boolean).join(" ")}>
      {showLogo ? (
        // eslint-disable-next-line @next/next/no-img-element -- app logos are arbitrary https or data URLs, shown as they are.
        <img className="sa-brand-logo" src={logo} alt={showName ? "" : app.name} decoding="async" referrerPolicy="no-referrer" onError={() => setBroken(logo)} />
      ) : null}
      {showName ? <span className="sa-brand-name">{app.name}</span> : null}
    </div>
  );
}

export interface HostedFrameProps {
  /** The app being signed into; null paints the Silicon Accounts look. */
  app: FrameApp | null;
  /** A page of Silicon Accounts itself: the site's brand tokens instead of an app's branding. */
  site?: boolean;
  /** The large copy beside the form in the split layout (hidden elsewhere). */
  title: string;
  subtitle?: string | null;
  /** The panel's content (steps). */
  children: ReactNode;
  /** Under the step: terms, privacy and help. */
  footer?: ReactNode;
  busy?: boolean;
  /** "Powered by Silicon Accounts" (on by default; off only for pages that are Silicon Accounts itself). */
  poweredBy?: boolean;
  /** Hide the app's logo and name in the panel (a problem page without an app). */
  plain?: boolean;
  /** The step's title already says the app's name: show the logo alone. */
  hideName?: boolean;
}

export function HostedFrame({ app, site: siteProp, title, subtitle, children, footer, busy, poweredBy = true, plain, hideName }: HostedFrameProps) {
  const site = !!siteProp || !app;
  const paint = usePaint(app, site);
  // The app's branding, with its error text kept readable (flow/legible.ts).
  const branding = useMemo(() => legibleBranding(normalizeBranding(app?.branding as Partial<Branding> | undefined)), [app?.branding]);
  const [fontsLoaded, setFontsLoaded] = useState(false);
  const [fontsTimedOut, setFontsTimedOut] = useState(false);
  // Fonts load on demand; the step fades in once they are there (or after 1.5 s), so headings never jump.
  useEffect(() => {
    const timer = window.setTimeout(() => setFontsTimedOut(true), 1500);
    return () => window.clearTimeout(timer);
  }, []);
  const fontsReady = site || fontsLoaded || fontsTimedOut;

  // The browser chrome (mobile address bar) and the canvas behind the page (overscroll, the end of short pages)
  // follow the app's background while the page is open. Silicon Accounts' own pages keep the site's.
  const background = site ? null : branding[paint].background;
  useEffect(() => {
    if (!background) return;
    const meta = document.createElement("meta");
    meta.name = "theme-color";
    meta.content = background;
    document.head.prepend(meta);
    const root = document.documentElement;
    const body = document.body;
    const previous = { root: root.style.backgroundColor, body: body.style.backgroundColor };
    root.style.backgroundColor = background;
    body.style.backgroundColor = background;
    return () => {
      meta.remove();
      root.style.backgroundColor = previous.root;
      body.style.backgroundColor = previous.body;
    };
  }, [background]);

  const layout = site ? "card" : branding.layout;
  const stage = (
    <BrandStage>
      <BrandAside>
        <AppIdentity app={app} paint={paint} />
        <div className={styles.asideCopy} aria-hidden="true">
          <p className="sa-brand-title">{title}</p>
          {subtitle ? <p className="sa-brand-subtitle">{subtitle}</p> : null}
        </div>
      </BrandAside>
      <BrandPanel as="main" className={styles.panel} aria-busy={busy || undefined} data-fonts={fontsReady ? "ready" : "loading"}>
        {plain ? null : <AppIdentity app={app} paint={paint} hideName={hideName} />}
        {children}
        {footer}
      </BrandPanel>
    </BrandStage>
  );

  return (
    <div className={styles.hosted} data-paint={paint} data-layout={layout} data-site={site || undefined}>
      {site ? (
        // Silicon Accounts itself: the site's own brand tokens (styles/tokens.css), in the card layout.
        <div className={`sa-brand ${styles.scope}`} data-layout="card" data-bg="plain" data-density="comfortable">{stage}</div>
      ) : (
        <BrandingScope branding={branding} theme={paint} className={styles.scope} onFontsReady={() => setFontsLoaded(true)}>
          {stage}
        </BrandingScope>
      )}
      {poweredBy ? <PoweredBy theme={paint} overlay className={styles.powered} /> : null}
    </div>
  );
}
