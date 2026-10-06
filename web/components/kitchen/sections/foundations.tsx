"use client";

import { useEffect, useRef, type CSSProperties } from "react";
import { useTheme } from "@/components/foundation/theme/use-theme";
import { Specimen, Wide, kitchenStyles as styles } from "../specimen";

const SWATCHES = ["--background", "--surface", "--surface-muted", "--foreground", "--text-secondary", "--border", "--accent", "--accent-ink", "--primary", "--success", "--warning", "--danger", "--control-on"];
const SIZES: Array<[string, string, boolean]> = [
  ["--text-5xl", "Display", true],
  ["--text-3xl", "Section", true],
  ["--text-xl", "Title", false],
  ["--text-base", "Body", false],
  ["--text-sm", "Controls", false],
  ["--text-xs", "Small", false],
];
const RADII: Array<[string, string]> = [
  ["var(--radius-control)", "--radius-control · buttons, fields"],
  ["var(--radius-panel)", "--radius-panel · menus, cards"],
  ["var(--radius-surface)", "--radius-surface · dialogs, sections"],
  ["30%", "30 % · avatars, app icons"],
];

/** One colour chip with its live computed value (re-read when the theme changes). */
function Swatch({ name }: { name: string }) {
  const { theme } = useTheme();
  const chip = useRef<HTMLSpanElement>(null);
  const value = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (chip.current && value.current) value.current.textContent = getComputedStyle(chip.current).backgroundColor;
    });
    return () => cancelAnimationFrame(frame);
  }, [theme]);
  return (
    <div className={styles.swatch}>
      <span ref={chip} data-sq="surface" className={styles.swatchChip} style={{ "--sq-fill": `var(${name})`, background: `var(${name})` } as CSSProperties} />
      <span className={styles.swatchName}>{name}</span>
      <span ref={value} className={styles.swatchValue} />
    </div>
  );
}

export function Foundations() {
  return (
    <Wide>
      <Specimen title="Semantic colours (live values for the theme they sit in)">
        <div className={styles.swatchRow}>
          {SWATCHES.map(name => <Swatch key={name} name={name} />)}
        </div>
      </Specimen>
      <Specimen title="Type: Instrument Serif for display moments, Geist for the interface, JetBrains Mono for ids">
        <div className={styles.typeScale}>
          {SIZES.map(([token, label, serif]) => (
            <div key={token} className={styles.typeRow}>
              <span className={styles.typeLabel}>{label}</span>
              <span style={{ fontSize: `var(${token})`, fontFamily: serif ? "var(--font-serif)" : "var(--font-body)", lineHeight: 1.1 }}>One account for every Carbon and Silicon</span>
            </div>
          ))}
          <div className={styles.typeRow}>
            <span className={styles.typeLabel}>Mono</span>
            <span className={styles.mono}>c:saket · si:head_of_growth · a8K · briefcase:a8K</span>
          </div>
        </div>
      </Specimen>
      <Specimen title="Squircles: every rounded surface (top) against a plain rounded rectangle of the same radius (bottom)">
        <div className={styles.radii}>
          {RADII.map(([radius, label]) => (
            <div key={radius} className={styles.radius}>
              <span data-sq="surface" className={styles.radiusTile} style={{ "--sq-r": radius } as CSSProperties} />
              <span className={styles.radiusTile} data-round="" style={{ "--tile-r": radius } as CSSProperties} />
              <span>{label}</span>
            </div>
          ))}
        </div>
      </Specimen>
    </Wide>
  );
}
