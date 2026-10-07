"use client";

/**
 * React components for branded hosted pages (the runtime is lib/branding):
 *
 *   <div className="sa-hosted">                                   (positioned: PoweredBy overlay pins to it)
 *     <BrandingScope branding={flow.app.branding} theme={paint}>   (paints the app's tokens on its own subtree)
 *       <BrandStage>
 *         <BrandAside>…</BrandAside>                               (the split layout's app side)
 *         <BrandPanel>                                             (the sign-in card, a squircle)
 *           <div className="sa-brand-header">logo + name</div>
 *           <h1 className="sa-brand-title">…</h1> <p className="sa-brand-subtitle">…</p>
 *           <div className="sa-brand-body">step content</div>
 *           <p className="sa-brand-legal">terms and privacy</p>
 *         </BrandPanel>
 *       </BrandStage>
 *     </BrandingScope>
 *     <PoweredBy theme={paint} overlay />                          (OUTSIDE the branded subtree, always)
 *   </div>
 *
 * Resolve `theme` with resolveBrandTheme(branding.theme, visitorTheme). The scope renders its variables inline (also
 * on the server, so a branded page paints right on its first frame) and loads the fonts the branding needs.
 */
import { useEffect, useMemo, useRef, type CSSProperties, type HTMLAttributes, type ReactNode } from "react";
import type { Branding } from "@/lib/api/types";
import { brandingAttributes, brandingVariables, type PaintTheme } from "@/lib/branding/apply";
import { normalizeBranding } from "@/lib/branding/defaults";
import { loadBrandingFonts } from "@/lib/branding/fonts";
import { refreshSquircles } from "@/lib/squircle/core";
import styles from "./powered-by.module.css";

const cx = (...names: Array<string | false | null | undefined>) => names.filter(Boolean).join(" ");

export interface BrandingScopeProps extends Omit<HTMLAttributes<HTMLDivElement>, "style"> {
  /** The app's branding (a partial draft is fine: missing values use the Silicon Accounts defaults). */
  branding: Branding | Partial<Branding> | null | undefined;
  /** The theme to paint (resolveBrandTheme(branding.theme, visitorTheme)). */
  theme: PaintTheme;
  /** Called once the fonts the branding uses are ready. */
  onFontsReady?: () => void;
  style?: CSSProperties;
  children?: ReactNode;
}

/** Paints `branding` in `theme` onto its own subtree. Live: change the props and the page follows. */
export function BrandingScope({ branding, theme, onFontsReady, className, style, children, ...rest }: BrandingScopeProps) {
  const ref = useRef<HTMLDivElement>(null);
  const normalized = useMemo(() => normalizeBranding(branding as Partial<Branding>), [branding]);
  const vars = useMemo(() => brandingVariables(normalized, theme), [normalized, theme]);
  const attrs = useMemo(() => brandingAttributes(normalized, theme), [normalized, theme]);
  const fontsReady = useRef(onFontsReady);
  useEffect(() => {
    fontsReady.current = onFontsReady;
  });

  const body = normalized.font_family;
  const heading = normalized.heading_font_family;
  useEffect(() => {
    let live = true;
    void loadBrandingFonts({ font_family: body, heading_font_family: heading }).then(() => {
      if (live) fontsReady.current?.();
    });
    return () => {
      live = false;
    };
  }, [body, heading]);

  // The squircle fallback (Firefox) computes paths once; a corner style change needs a repaint.
  const corner = normalized.corner_style;
  const lastCorner = useRef(corner);
  useEffect(() => {
    if (lastCorner.current === corner) return;
    lastCorner.current = corner;
    const node = ref.current;
    if (node) queueMicrotask(() => refreshSquircles(node));
  }, [corner]);

  return (
    <div ref={ref} {...rest} {...attrs} className={cx("sa-brand", className)} style={{ ...(vars as CSSProperties), colorScheme: theme, ...style }}>
      {children}
    </div>
  );
}

export function BrandStage({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx("sa-brand-stage", className)}>{children}</div>;
}

/** The app's side of the split layout (hidden in the card and minimal layouts, and on narrow branded areas). */
export function BrandAside({ className, children }: { className?: string; children: ReactNode }) {
  // The inner block is what stays in view while a long step scrolls the page (styles/branding.css, split layout).
  return <aside className={cx("sa-brand-aside", className)}><div className="sa-brand-aside-inner">{children}</div></aside>;
}

export interface BrandPanelProps extends HTMLAttributes<HTMLElement> {
  as?: "main" | "section" | "div";
}

/** The sign-in card: a squircle surface that follows the branding's radius, colours and density. */
export function BrandPanel({ as = "main", className, children, ...rest }: BrandPanelProps) {
  const Tag = as;
  return <Tag {...rest} data-sq="surface" className={cx("sa-brand-panel", className)}>{children}</Tag>;
}

export interface PoweredByProps {
  /** Which fixed palette to use; match the painted theme. */
  theme?: PaintTheme;
  /** Pin it to the bottom of the nearest positioned ancestor, over the branded background. */
  overlay?: boolean;
  className?: string;
}

/** Where "Powered by Silicon Accounts" links. Not configurable. */
export const POWERED_BY_HREF = "https://accounts.teamofsilicons.com";

/**
 * "Powered by Silicon Accounts", linking to accounts.teamofsilicons.com. Render it OUTSIDE BrandingScope so branding
 * variables cannot reach it. It carries data-powered-by so tests can assert it is present and visible. Neither the
 * text nor the link is configurable (UNDERSTANDING: an app cannot remove it).
 */
export function PoweredBy({ theme, overlay, className }: PoweredByProps) {
  return (
    <div className={cx(styles.powered, overlay && styles.overlay, theme === "dark" && styles.dark, className)} data-powered-by="">
      <p className={styles.pill}>
        <svg className={styles.mark} viewBox="0 0 64 64" aria-hidden="true">
          <path fill="#1F5FB8" d="M32 0c19.6 0 25.4 1.4 28.6 3.4C62.6 6.6 64 12.4 64 32s-1.4 25.4-3.4 28.6C57.4 62.6 51.6 64 32 64S6.6 62.6 3.4 60.6C1.4 57.4 0 51.6 0 32S1.4 6.6 3.4 3.4C6.6 1.4 12.4 0 32 0Z" />
          <circle cx="32" cy="25" r="9" fill="#FFFDF9" />
          <path fill="#FFFDF9" d="M15 49c2.6-8 9.2-12.5 17-12.5S46.4 41 49 49c-4.6 3-10.4 4.6-17 4.6S19.6 52 15 49Z" />
        </svg>
        <span>Powered by <a href={POWERED_BY_HREF} target="_blank" rel="noopener">Silicon Accounts</a></span>
      </p>
    </div>
  );
}
