"use client";

/**
 * Home's introduction for a new Carbon: "One Account for Your Silicons & Apps" and three things it covers (You,
 * Silicons, Apps), a title and one line each. Each card does what it names (Anil, 2026-11-13): You lights the ring
 * around the photo above (glowYou), Silicons goes to Create a Silicon (to Silicons once there is one), Apps goes to
 * Connected Apps. Shown
 * while it is useful: until the account has a Silicon and has signed in to an app (Anil, 2026-11-11), or until
 * dismissed, which this browser remembers.
 *
 * Since 2026-11-11 (Anil, picked in /__banner) it is the picture cards (parts/picture-cards.tsx): no background or box,
 * an h3, three cards of one design in Home's column, each a 16:9 Super Visuals picture (BG 110, 102, 127) over its
 * words. The gradient cards it replaced (2026-10-31, direction B: the pixel avatar on its own colours, the Silicon
 * spark, the apps grid) stay below as HomeCardsView, for the lab's record; the You card's photo version is archived in
 * redesign/archive/you-card-photo.md.
 */
import { useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { LayoutGrid, Sparkle, X } from "lucide-react";
import { Button } from "@teamofsilicons/silicon-ui/button";
import { useCarbonAvatar } from "@/lib/carbon-avatar";
import { usePicturePalette } from "@/lib/picture-colours";
import { useMe, useSession } from "@/lib/query/session";
import { paths } from "@/lib/navigation";
import { glowYou } from "./home-identity";
import { PictureCards } from "./parts/picture-cards";
import { useEveryApp, useEverySilicon } from "./parts/queries";
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
  const silicons = useEverySilicon();
  const apps = useEveryApp();
  if (dismissed || !account) return null;
  // Only while it's useful (Anil, 2026-11-11): gone once the account has a Silicon and signs in to an app, the two
  // things it introduces. Hidden until both lists are read, so it never shows and then vanishes.
  if (!silicons.data || !apps.data) return null;
  const hasSilicon = silicons.data.items.length > 0;
  const usesAnApp = apps.data.items.some(item => item.status === "active");
  if (hasSilicon && usesAnApp) return null;
  return (
    <PictureCards className={styles.place} title="One Account for Your Silicons & Apps" onDismiss={dismiss} cards={[
      { id: "you", picture: { src: "/banner/bg-110.webp" }, title: "You", line: account.id ? `Your CarbonID across apps: ${account.id}` : "Your CarbonID across apps.", onSelect: glowYou },
      { id: "silicons", picture: { src: "/banner/bg-102.webp", focus: "right center" }, title: "Silicons", line: "Give an AI agent its own account.", href: hasSilicon ? paths.silicons : `${paths.silicons}/new` },
      { id: "apps", picture: { src: "/banner/bg-127.webp", focus: "center 70%" }, title: "Apps", line: "Apps for delightful agent creation and interaction.", href: paths.apps },
    ]} />
  );
}

/**
 * The gradient-card banner Home showed until 2026-11-11, kept for the banner lab (/__banner), which draws it with a
 * sample account as the record of what came before the picture cards.
 */
export function HomeCardsView({ account, onDismiss, onYou }: { account: { uuid: string; id?: string | null }; onDismiss?: () => void; onYou?: () => void }) {
  // The You card shows every Carbon as their pixel avatar, photo or not. Its gradient is the avatar's own palette, dark
  // to light (lib/picture-colours.ts); its words turn light when the colours behind them are dark. The Silicon colours
  // until the avatar is read.
  const src = useCarbonAvatar(account);
  const palette = usePicturePalette(src, 4);
  const youStyle = palette ? (Object.fromEntries(palette.map((colour, index) => [`--you-${index + 1}`, colour.css])) as CSSProperties) : undefined;
  const youOnDark = palette ? palette[1].lightness < 150 : false;
  // eslint-disable-next-line @next/next/no-img-element -- the pixel avatar is a data URL, shown as is.
  const avatar = src ? <img className={styles.youPicture} src={src} alt="" decoding="async" /> : null;

  return (
    <section data-sq="surface" className={styles.banner} aria-labelledby="home-cards-title">
      <div className={styles.head}>
        <h3 id="home-cards-title" className={styles.title}>One Account for Your Silicons &amp; Apps</h3>
        <Button variant="soft" size="xs" className={styles.close} aria-label="Dismiss" onClick={onDismiss}>
          <X size={16} strokeWidth={2} aria-hidden="true" />
        </Button>
      </div>
      <ul className={styles.items}>
        <Card className={styles.you} style={youStyle} onDark={youOnDark} picture={avatar} label="You" onClick={onYou}
          line={account.id ? <>Your CarbonID across apps: <span className={styles.id}>{account.id}</span></> : "Your CarbonID across apps."} />
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
