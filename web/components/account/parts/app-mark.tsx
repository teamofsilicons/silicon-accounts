"use client";

/**
 * An app's mark: its logo in a squircle (the dark logo on dark surfaces when the app has one), or its initials when it
 * has no logo or the logo fails to load.
 */
import { useState, type CSSProperties } from "react";
import { useTheme } from "@/components/foundation/theme/use-theme";
import { appLogo } from "./common";
import styles from "./parts.module.css";

export interface AppMarkApp {
  app_id: string;
  name: string;
  logo_url: string | null;
  logo_dark_url?: string | null;
}

export function AppMark({ app, size = 40, className, decorative }: { app: AppMarkApp; size?: number; className?: string; decorative?: boolean }) {
  const { theme } = useTheme();
  const src = appLogo(app, theme);
  const [failed, setFailed] = useState<string | null>(null);
  const initials = app.name.split(/\s+/).filter(Boolean).slice(0, 2).map(word => word[0]?.toUpperCase() ?? "").join("") || app.app_id.slice(0, 2).toUpperCase();
  return (
    <span
      data-sq="clip"
      className={[styles.appMark, className].filter(Boolean).join(" ")}
      style={{ "--mark-size": `${size}px` } as CSSProperties}
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : app.name}
      aria-hidden={decorative ? "true" : undefined}
    >
      {src && failed !== src ? (
        // eslint-disable-next-line @next/next/no-img-element -- app logos are arbitrary https or data URLs, shown as they are.
        <img src={src} alt="" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(src)} />
      ) : (
        <span className={styles.appInitials}>{initials}</span>
      )}
    </span>
  );
}
