"use client";

/**
 * Home's introduction for a new Carbon (Anil, 2026-10-31, direction B): three cards, You, Silicons and Apps, under
 * "One Account for Your Silicons & Apps" (an h3: a banner, not a section). They only present the account (a title and one line each); the actions
 * live in Home's sections below (home-sections.tsx). Shown until dismissed, which this browser remembers.
 *
 * - You: the Carbon's pixel avatar on a gradient of its own colours.
 * - Silicons: the white Silicon spark on the Silicon colours.
 * - Apps: the white apps grid on the blue accent.
 *
 * Each is a small card: words on its gradient's dark end, the picture standing at the lower right. The You card's
 * photo version is archived in redesign/archive/you-card-photo.md.
 */
import { useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { LayoutGrid, Sparkle, X } from "lucide-react";
import { Button } from "@teamofsilicons/silicon-ui/button";
import { useCarbonAvatar } from "@/lib/carbon-avatar";
import { usePicturePalette } from "@/lib/picture-colours";
import { useMe, useSession } from "@/lib/query/session";
import { glowYou } from "./home-identity";
import styles from "./home-cards.module.css";

const KEY = "accounts.home.welcome-dismissed";
const listeners = new Set<() => void>();
let dismissedThisVisit = false;

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

function dismiss() {
  try {
    window.localStorage.setItem(KEY, "1");
  } catch {
    // Storage blocked: the introduction goes for this visit only.
  }
  dismissedThisVisit = true;
  listeners.forEach(listener => listener());
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function HomeCards() {
  // Hidden on the server and until storage is read, so a dismissed introduction never flashes in.
  const dismissed = useSyncExternalStore(subscribe, () => dismissedThisVisit || readDismissed(), () => true);
  const { session } = useSession();
  const me = useMe();
  const account = me.data ?? session?.account;
  // The You card shows every Carbon as their pixel avatar, photo or not. Its gradient is the avatar's own palette, dark
  // to light (lib/picture-colours.ts); its words turn light when the colours behind them are dark. The Silicon colours
  // until the avatar is read.
  const src = useCarbonAvatar(account);
  const palette = usePicturePalette(src, 4);
  const youStyle = palette ? (Object.fromEntries(palette.map((colour, index) => [`--you-${index + 1}`, colour.css])) as CSSProperties) : undefined;
  const youOnDark = palette ? palette[1].lightness < 150 : false;
  if (dismissed || !account) return null;
  // eslint-disable-next-line @next/next/no-img-element -- the pixel avatar is a data URL, shown as is.
  const avatar = src ? <img className={styles.youPicture} src={src} alt="" decoding="async" /> : null;

  return (
    <section data-sq="surface" className={styles.banner} aria-labelledby="home-cards-title">
      <div className={styles.head}>
        <h3 id="home-cards-title" className={styles.title}>One Account for Your Silicons &amp; Apps</h3>
        <Button variant="soft" size="xs" className={styles.close} aria-label="Dismiss" onClick={dismiss}>
          <X size={16} strokeWidth={1.75} aria-hidden="true" />
        </Button>
      </div>
      <ul className={styles.items}>
        <Card className={styles.you} style={youStyle} onDark={youOnDark} picture={avatar} label="You" onClick={glowYou}
          line={account.id ? <>Your id across apps: <span className={styles.id}>{account.id}</span></> : "Your id across apps."} />
        <Card className={styles.silicons} onDark picture={<Sparkle className={styles.siliconsSpark} fill="currentColor" strokeWidth={1} aria-hidden="true" />}
          label="Silicons" line="Give an AI agent its own account." />
        <Card className={styles.apps} onDark picture={<LayoutGrid className={styles.appsGrid} fill="currentColor" strokeWidth={1} aria-hidden="true" />}
          label="Apps" line="Apps for delightful agent creation and interaction." />
      </ul>
    </section>
  );
}

function Card({ className, style, onDark, picture, label, line, onClick }: { className: string; style?: CSSProperties; onDark?: boolean; picture: ReactNode; label: string; line: ReactNode; onClick?: () => void }) {
  return (
    // The You card's click lights the ring around the picture above (a flourish: nothing else happens).
    <li data-sq="clip" className={`${styles.card} ${className}`} style={style} data-on-dark={onDark || undefined} data-clickable={onClick ? "" : undefined} onClick={onClick}>
      {picture}
      <span className={styles.cardWords}>
        <span className={styles.cardLabel}>{label}</span>
        <span className={styles.cardLine}>{line}</span>
      </span>
    </li>
  );
}
