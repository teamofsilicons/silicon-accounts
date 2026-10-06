"use client";

/**
 * A style-guide specimen: a squircle surface with a caption. In side-by-side mode (/__kitchen?compare=1) it renders
 * its content twice, in a light and a dark pane (tokens apply to any subtree with data-theme). Overlays that portal to
 * <body> (menus, dialogs, toasts) follow the page theme in both panes.
 */
import { createContext, useContext, type ReactNode } from "react";
import styles from "./kitchen.module.css";

export const CompareContext = createContext(false);

export function Specimen({ title, children, wide, single }: { title: string; children: ReactNode; wide?: boolean; single?: boolean }) {
  const compare = useContext(CompareContext) && !single;
  return (
    <section data-sq="surface" className={styles.specimen} aria-label={title} data-wide={wide || undefined}>
      <h3 className={styles.specimenTitle}>{title}</h3>
      {compare ? (
        <div className={styles.panes}>
          {(["light", "dark"] as const).map(theme => (
            <div key={theme} data-theme={theme} data-sq="surface" className={styles.pane}>
              <span className={styles.paneLabel}>{theme}</span>
              <div className={styles.specimenBody}>{children}</div>
            </div>
          ))}
        </div>
      ) : (
        <div className={styles.specimenBody}>{children}</div>
      )}
    </section>
  );
}

/** A row of specimens laid out in balanced columns. */
export function Specimens({ children }: { children: ReactNode }) {
  return <div className={styles.specimens}>{children}</div>;
}

/** Specimens that take the full width, one per row. */
export function Wide({ children }: { children: ReactNode }) {
  return <div className={styles.wide}>{children}</div>;
}

export const kitchenStyles = styles;
