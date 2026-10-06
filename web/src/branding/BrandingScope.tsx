/**
 * Components for branded hosted pages. `BrandingScope` paints an app's branding onto its subtree (applyBranding) and
 * loads the fonts it needs; `BrandStage`, `BrandAside` and `BrandPanel` give the layout structure branding.css styles;
 * `PoweredBy` renders the un-removable footer outside the branded subtree.
 *
 *   <div class="sa-hosted">
 *     <BrandingScope branding={flow.app.branding} theme={theme()}>
 *       <BrandStage>
 *         <BrandAside>…</BrandAside>          (shown by the split layout)
 *         <BrandPanel>…steps…</BrandPanel>
 *       </BrandStage>
 *     </BrandingScope>
 *     <PoweredBy theme={theme()} overlay />
 *   </div>
 */
import { Show, createRenderEffect, splitProps, type JSX } from "solid-js";
import type { Branding } from "../api/types";
import { cx } from "../arc/lib/cx";
import { refreshSquircles, useSquircle } from "../arc/lib/squircle";
import { applyBranding, type PaintTheme } from "./apply";
import { normalizeBranding } from "./defaults";
import { loadBrandingFonts } from "./fonts";
import "./branding.css";
import styles from "./powered-by.module.css";

export interface BrandingScopeProps extends Omit<JSX.HTMLAttributes<HTMLDivElement>, "style"> {
  /** The app's branding (a partial draft is fine: missing values use the Silicon Accounts defaults). */
  branding: Branding | Partial<Branding> | null | undefined;
  /** The theme to paint (resolve it with resolveBrandTheme(branding.theme, visitorTheme)). */
  theme: PaintTheme;
  /** Called once the fonts the branding uses are ready. */
  onFontsReady?: () => void;
  style?: JSX.CSSProperties;
  ref?: (el: HTMLDivElement) => void;
}

/** Paints `branding` in `theme` onto its own subtree. Live: change the props and the page follows. */
export function BrandingScope(props: BrandingScopeProps) {
  const [local, rest] = splitProps(props, ["branding", "theme", "onFontsReady", "class", "children", "ref", "style"]);
  const el = (
    <div {...rest} ref={node => local.ref?.(node)} class={cx("sa-brand", local.class)} style={local.style}>
      {local.children}
    </div>
  ) as HTMLDivElement;
  let lastCorner: string | undefined;
  createRenderEffect(() => {
    const branding = normalizeBranding(local.branding as Partial<Branding>);
    applyBranding(el, branding, local.theme);
    void loadBrandingFonts(branding).then(() => local.onFontsReady?.());
    // The squircle fallback (Safari/Firefox) computes paths once; a corner style change needs a repaint.
    if (lastCorner !== undefined && lastCorner !== branding.corner_style) queueMicrotask(() => refreshSquircles(el));
    lastCorner = branding.corner_style;
  });
  return el;
}

export function BrandStage(props: { class?: string; children: JSX.Element }) {
  return <div class={cx("sa-brand-stage", props.class)}>{props.children}</div>;
}

/** The app's side of the split layout (hidden in the card and minimal layouts, and on narrow screens). */
export function BrandAside(props: { class?: string; children: JSX.Element }) {
  return <aside class={cx("sa-brand-aside", props.class)}>{props.children}</aside>;
}

/** The sign-in card: a squircle surface that follows the branding's radius, colours and density. */
export function BrandPanel(props: JSX.HTMLAttributes<HTMLElement> & { as?: "main" | "section" | "div" }) {
  const [local, rest] = splitProps(props, ["as", "class", "children"]);
  const attach = (node: HTMLElement) => useSquircle(node);
  return (
    <Show
      when={(local.as ?? "main") === "main"}
      fallback={<section {...rest} ref={attach} class={cx("sa-brand-panel", local.class)}>{local.children}</section>}
    >
      <main {...rest} ref={attach} class={cx("sa-brand-panel", local.class)}>{local.children}</main>
    </Show>
  );
}

export interface PoweredByProps {
  /** Which fixed palette to use; match the painted theme. */
  theme?: PaintTheme;
  /** Pin it to the bottom of the nearest positioned ancestor, over the branded background. */
  overlay?: boolean;
}

const SITE = "https://account.teamofsilicons.com";

/**
 * "Powered by Silicon Accounts", linking to account.teamofsilicons.com. Render it OUTSIDE BrandingScope so branding
 * variables cannot reach it. It carries data-powered-by so tests can assert it is present and visible. Neither the
 * text nor the link is configurable (UNDERSTANDING: an app cannot remove it).
 */
export function PoweredBy(props: PoweredByProps) {
  return (
    <div class={cx(styles.powered, props.overlay && styles.overlay, props.theme === "dark" && styles.dark)} data-powered-by="">
      <p class={styles.pill}>
        <svg class={styles.mark} viewBox="0 0 64 64" aria-hidden="true">
          <path fill="#1F5FB8" d="M32 0c19.6 0 25.4 1.4 28.6 3.4C62.6 6.6 64 12.4 64 32s-1.4 25.4-3.4 28.6C57.4 62.6 51.6 64 32 64S6.6 62.6 3.4 60.6C1.4 57.4 0 51.6 0 32S1.4 6.6 3.4 3.4C6.6 1.4 12.4 0 32 0Z" />
          <circle cx="32" cy="25" r="9" fill="#FFFDF9" />
          <path fill="#FFFDF9" d="M15 49c2.6-8 9.2-12.5 17-12.5S46.4 41 49 49c-4.6 3-10.4 4.6-17 4.6S19.6 52 15 49Z" />
        </svg>
        <span>Powered by <a href={SITE} target="_blank" rel="noopener">Silicon Accounts</a></span>
      </p>
    </div>
  );
}

export const POWERED_BY_HREF = SITE;
