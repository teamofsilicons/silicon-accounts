/**
 * The page every hosted sign-in step renders in: the app's branding painted on its own subtree (BrandingScope), the
 * layout the app chose (card, split or minimal), its logo and name, and the "Powered by Silicon Accounts" line,
 * which lives outside the branded subtree so no branding can restyle or hide it.
 */
import { Show, createEffect, createSignal, onCleanup, type JSX } from "solid-js";
import type { Branding, SigninCopy } from "../../../api";
import { BrandAside, BrandPanel, BrandStage, BrandingScope, DEFAULT_DARK, PoweredBy, brandLogo, normalizeBranding, resolveBrandTheme, type PaintTheme } from "../../../branding";
import { theme } from "../../../theme/theme";
import styles from "./flow.module.css";

/** What the frame needs to know about the app (a FlowView's `app`, or a remembered look while it loads). */
export interface FrameApp {
  app_id: string;
  name: string;
  logo_url?: string | null;
  logo_dark_url?: string | null;
  branding?: Partial<Branding> | null;
  copy?: Partial<SigninCopy> | null;
}

export interface HostedFrameProps {
  /** The app being signed into; null paints the Silicon Accounts look. */
  app: FrameApp | null;
  /** The app's title, shown large beside the form in the split layout. */
  title: string;
  subtitle?: string | null;
  /** The panel's content (steps). */
  children: JSX.Element;
  /** Under the step: terms, privacy and help. */
  footer?: JSX.Element;
  busy?: boolean;
  /** "Powered by Silicon Accounts" (on by default; off only for pages that are Silicon Accounts itself). */
  poweredBy?: boolean;
  /** Hide the app's logo and name in the panel (error pages without an app). */
  plain?: boolean;
  /** The step's title already says the app's name: show the logo alone. */
  hideName?: boolean;
  /**
   * A page of Silicon Accounts itself (device approval, the account site's own sign-in, a problem with no app): it
   * wears the site's brand tokens instead of an app's branding.
   */
  site?: boolean;
}

/** The paint theme of a branding for this visitor: the app's forced theme, else the visitor's own. */
export function paintFor(branding: Partial<Branding> | null | undefined): PaintTheme {
  return resolveBrandTheme(normalizeBranding(branding as Partial<Branding>).theme, theme());
}

/** The Silicon Accounts mark, for the account site's own sign-in (the first-party app has no logo of its own). */
const SILICON_ACCOUNTS_MARK = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path fill="#1F5FB8" d="M32 0c19.6 0 25.4 1.4 28.6 3.4C62.6 6.6 64 12.4 64 32s-1.4 25.4-3.4 28.6C57.4 62.6 51.6 64 32 64S6.6 62.6 3.4 60.6C1.4 57.4 0 51.6 0 32S1.4 6.6 3.4 3.4C6.6 1.4 12.4 0 32 0Z"/><circle cx="32" cy="25" r="9" fill="#FFFDF9"/><path fill="#FFFDF9" d="M15 49c2.6-8 9.2-12.5 17-12.5S46.4 41 49 49c-4.6 3-10.4 4.6-17 4.6S19.6 52 15 49Z"/></svg>')}`;

/** The app's logo and name, as its branding asks. */
export function AppIdentity(props: { app: FrameApp | null; paint: PaintTheme; class?: string; hideName?: boolean }) {
  const branding = () => normalizeBranding(props.app?.branding as Partial<Branding>);
  const logo = () => {
    if (!props.app) return null;
    const own = brandLogo(branding(), { logo_url: props.app.logo_url ?? null, logo_dark_url: props.app.logo_dark_url ?? null }, props.paint);
    return own ?? (props.app.app_id === "accounts" ? SILICON_ACCOUNTS_MARK : null);
  };
  const [broken, setBroken] = createSignal<string | null>(null);
  return (
    <Show when={props.app && (logo() || branding().show_app_name)}>
      <div class={`sa-brand-header ${props.class ?? ""}`}>
        <Show when={logo() && broken() !== logo()}>
          <img class="sa-brand-logo" src={logo() ?? ""} alt={branding().show_app_name ? "" : props.app?.name ?? ""} decoding="async" referrerPolicy="no-referrer" onError={() => setBroken(logo())} />
        </Show>
        <Show when={(branding().show_app_name && !props.hideName) || !logo() || broken() === logo()}>
          <span class="sa-brand-name">{props.app?.name}</span>
        </Show>
      </div>
    </Show>
  );
}

export function HostedFrame(props: HostedFrameProps) {
  const branding = () => normalizeBranding(props.app?.branding as Partial<Branding>);
  const site = () => !!props.site;
  const paint = () => (site() ? theme() : resolveBrandTheme(branding().theme, theme()));
  /** Dark, solid buttons and the default dark palette: fill them with the brand blue (see flow.module.css). */
  const siteFill = () => {
    if (site() || paint() !== "dark") return false;
    const look = branding();
    return look.button_style === "solid" && look.dark.primary === DEFAULT_DARK.primary && look.dark.primary_foreground === DEFAULT_DARK.primary_foreground;
  };
  const [fontsReady, setFontsReady] = createSignal(false);
  // Fonts load on demand; the step fades in once they are there (or after 1.5 s), so headings never jump.
  const fallback = window.setTimeout(() => setFontsReady(true), 1500);
  onCleanup(() => window.clearTimeout(fallback));
  // The browser chrome (mobile address bar) and the canvas behind the page (overscroll, the bottom of short pages)
  // follow the app's background while the page is open. Silicon Accounts' own pages keep the site's.
  createEffect(() => {
    if (site()) return;
    const background = branding()[paint()].background;
    const meta = document.createElement("meta");
    meta.name = "theme-color";
    meta.content = background;
    document.head.prepend(meta);
    const root = document.documentElement;
    const previous = root.style.backgroundColor;
    root.style.backgroundColor = background;
    onCleanup(() => {
      meta.remove();
      root.style.backgroundColor = previous;
    });
  });

  const stage = () => (
    <BrandStage>
      <BrandAside>
        <AppIdentity app={props.app} paint={paint()} />
        <div class={styles.asideCopy} aria-hidden="true">
          <p class="sa-brand-title">{props.title}</p>
          <Show when={props.subtitle}>{subtitle => <p class="sa-brand-subtitle">{subtitle()}</p>}</Show>
        </div>
      </BrandAside>
      <BrandPanel as="main" class={styles.panel} aria-busy={props.busy || undefined} data-fonts={fontsReady() || site() ? "ready" : "loading"}>
        <Show when={!props.plain}><AppIdentity app={props.app} paint={paint()} hideName={props.hideName} /></Show>
        {props.children}
        {props.footer}
      </BrandPanel>
    </BrandStage>
  );

  return (
    <div class={styles.hosted} data-paint={paint()} data-site-fill={siteFill() || undefined}>
      <Show
        when={!site()}
        fallback={
          // Silicon Accounts itself: the site's own brand tokens (src/styles/tokens.css), in the card layout.
          <div class={`sa-brand ${styles.scope}`} data-layout="card" data-bg="plain" data-density="comfortable">{stage()}</div>
        }
      >
        <BrandingScope branding={branding()} theme={paint()} class={styles.scope} onFontsReady={() => setFontsReady(true)}>
          {stage()}
        </BrandingScope>
      </Show>
      <Show when={props.poweredBy !== false}><PoweredBy theme={paint()} overlay /></Show>
    </div>
  );
}
