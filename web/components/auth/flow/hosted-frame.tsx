"use client";

/**
 * The page every hosted sign-in step renders in: the app's branding painted on its own subtree (BrandingScope), the
 * layout the app chose (card, split or minimal), its logo and name, and "Powered by Silicon Accounts", which lives
 * outside the branded subtree so no branding can restyle or hide it.
 *
 * Silicon Accounts' own pages (device approval, the account site's sign-in, problems with no app, the first-party
 * flow) wear the site's brand tokens instead of an app's branding. So does an app that kept the default colours and
 * fonts and the visitor's theme (isSiliconLook): its pages look like Silicon Accounts' own, with its logo, its layout
 * and "Powered by" (Anil, 2026-11-18: "two very different designs, we need to make this uniform").
 */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { AccountsGlyph } from "@/components/foundation/shell/brand-mark";
import { BrandAside, BrandPanel, BrandStage, BrandingScope, PoweredBy } from "@/components/foundation/branding/branding";
import { useTheme } from "@/components/foundation/theme/use-theme";
import type { BrandLayout, Branding } from "@/lib/api/types";
import { brandLogo, resolveBrandTheme, type PaintTheme } from "@/lib/branding/apply";
import { isSiliconLook, normalizeBranding } from "@/lib/branding/defaults";
import { legibleBranding } from "./legible";
import type { FrameApp } from "./model";
import styles from "./flow.module.css";

/**
 * Team of Silicons' default sign-in (Anil, 2026-11-19, /__accounts-signin, Default style, vertical, Painted): an app
 * that kept the default look signs in on a narrow card headed "Sign in with Team of Silicons", over the cloud painting,
 * with Powered by at the foot. Steps read it to head themselves the card's way (choose_method: "Sign in" and "to
 * continue to {app}"). Team of Silicons' Help, Privacy and Terms go under the card once those pages exist (they 404 on
 * teamofsilicons.com as of 2026-11-19).
 */
const TosFrameContext = createContext(false);
export const useTosFrame = () => useContext(TosFrameContext);

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
  // Our own first-party apps (the account site, the developer site) wear the Silicon Accounts mark.
  const logo = own ?? (app?.app_id === "silicon-accounts" || app?.first_party ? "/icon.svg" : null);
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
  /** This page's own layout (a flow step can choose one); null or missing follows the branding's. */
  layout?: BrandLayout | null;
}

export function HostedFrame({ app, site: siteProp, title, subtitle, children, footer, busy, poweredBy = true, plain, hideName, layout: pageLayout }: HostedFrameProps) {
  // The app's branding, with its error text kept readable (flow/legible.ts), in this page's layout.
  const branding = useMemo(() => {
    const base = legibleBranding(normalizeBranding(app?.branding as Partial<Branding> | undefined));
    return pageLayout && pageLayout !== base.layout ? { ...base, layout: pageLayout } : base;
  }, [app?.branding, pageLayout]);
  // The site's own tokens: Silicon Accounts' pages, and apps that kept the default look (checked on the stored
  // branding, before legibleBranding adjusts its error colour).
  const defaultLook = useMemo(() => {
    const stored = normalizeBranding(app?.branding as Partial<Branding> | undefined);
    return isSiliconLook(stored) && stored.theme === "auto";
  }, [app?.branding]);
  const site = !!siteProp || !app || defaultLook;
  const paint = usePaint(app, site);
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

  // Silicon Accounts' own pages are cards; an app in the default look keeps its own layout, background and density.
  const own = !!siteProp || !app;
  // An app in the default look: Team of Silicons' own sign-in card (TosFrameContext).
  const tos = defaultLook && !own;
  const layout = own || tos ? "card" : branding.layout;
  const panel = (
    <BrandPanel as="main" className={styles.panel} aria-busy={busy || undefined} data-fonts={fontsReady ? "ready" : "loading"} data-frame={tos ? "tos" : undefined}>
      {tos ? (
        <div className={styles.tosBar}>
          <span className={styles.tosGlyph} aria-hidden="true"><AccountsGlyph /></span>
          Sign in with Team of Silicons
        </div>
      ) : null}
      {tos ? (
        <div className={styles.tosBody}>{children}{footer}</div>
      ) : (
        <>
          {plain ? null : <AppIdentity app={app} paint={paint} hideName={hideName} />}
          {children}
          {footer}
        </>
      )}
    </BrandPanel>
  );
  const stage = tos ? (
    <BrandStage>
      <div className={styles.tosColumn}>
        {panel}
      </div>
    </BrandStage>
  ) : (
    <BrandStage>
      <BrandAside>
        <AppIdentity app={app} paint={paint} />
        <div className={styles.asideCopy} aria-hidden="true">
          <p className="sa-brand-title">{title}</p>
          {subtitle ? <p className="sa-brand-subtitle">{subtitle}</p> : null}
        </div>
      </BrandAside>
      {panel}
    </BrandStage>
  );

  return (
    <TosFrameContext.Provider value={tos}>
    <div className={styles.hosted} data-paint={paint} data-layout={layout} data-site={site || undefined} data-frame={tos ? "tos" : undefined}>
      {site ? (
        // The site's own brand tokens (styles/tokens.css): Silicon Accounts itself in the card layout, an app in the
        // default look in its own.
        <div className={`sa-brand ${styles.scope}`} data-layout={layout} data-bg={own ? "plain" : branding.background_style} data-density={own ? "comfortable" : branding.density} data-look="silicon">{stage}</div>
      ) : (
        <BrandingScope branding={branding} theme={paint} className={styles.scope} onFontsReady={() => setFontsLoaded(true)}>
          {stage}
        </BrandingScope>
      )}
      {poweredBy ? <PoweredBy theme={paint} overlay className={styles.powered} /> : null}
    </div>
    </TosFrameContext.Provider>
  );
}
