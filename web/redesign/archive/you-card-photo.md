# You card, photo version (archived 2026-10-30)

Home's introduction (components/account/home-intro.tsx) had its You card built on the Carbon's photo: a 135° gradient of the photo's own palette (`usePicturePalette`, k-means, dark to light, as Anil's gradient generator), the photo melting in from the lower right (masked left and top edges), and the words at the top left, light on a dark palette. Anil set it aside for the pixel avatar on 2026-10-30. `usePicturePalette` stays in lib/picture-colours.ts. To bring it back, restore these two files.

## home-intro.tsx

```tsx
"use client";

/**
 * Home's introduction for a new Carbon (Anil, 2026-10-30): the prototype's introduction ("One account for every Team of
 * Silicons app": You, Silicons, Apps, each with its picture and one line) in a new design, a soft grey tile under the
 * greeting. You is a small card on a gradient of the picture's own colours, the picture melting into it from the lower right
 * and the words on the gradient's dark end. It shows until it is dismissed, which this browser remembers.
 */
import { useSyncExternalStore, type CSSProperties } from "react";
import { LayoutGrid, X } from "lucide-react";
import { Button } from "@teamofsilicons/silicon-ui/button";
import { SiliconMark } from "@/components/account/parts/silicon-mark";
import { useCarbonPicture } from "@/lib/carbon-avatar";
import { usePicturePalette } from "@/lib/picture-colours";
import { useMe, useSession } from "@/lib/query/session";
import styles from "./home-intro.module.css";

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

export function HomeIntro() {
  // Hidden on the server and until storage is read, so a dismissed introduction never flashes in.
  const dismissed = useSyncExternalStore(subscribe, () => dismissedThisVisit || readDismissed(), () => true);
  const { session } = useSession();
  const me = useMe();
  const account = me.data ?? session?.account;
  const picture = useCarbonPicture(account);
  const src = picture?.src ?? account?.pfp_url;
  // The You card's gradient is the picture's own palette, dark to light (lib/picture-colours.ts); its words turn light
  // when the colours behind them are dark. The Silicon colours until the picture is read.
  const palette = usePicturePalette(src, 4);
  const youStyle = palette ? (Object.fromEntries(palette.map((colour, index) => [`--you-${index + 1}`, colour.css])) as CSSProperties) : undefined;
  const youOnDark = palette ? palette[1].lightness < 150 : false;
  if (dismissed || !account) return null;

  return (
    <section data-sq="surface" className={styles.intro} aria-labelledby="home-intro-title">
      <div className={styles.head}>
        <h2 id="home-intro-title" className={styles.title}>One account for every Team of Silicons app</h2>
        <Button variant="ghost" size="xs" className={styles.close} aria-label="Dismiss" onClick={dismiss}>
          <X size={16} strokeWidth={1.75} aria-hidden="true" />
        </Button>
      </div>
      <ul className={styles.items}>
        <li data-sq="clip" className={styles.you} style={youStyle} data-on-dark={youOnDark || undefined}>
          {/* eslint-disable-next-line @next/next/no-img-element -- the picture is a photo URL or a pixel avatar's data URL, shown as is. */}
          {src ? <img className={styles.youPicture} src={src} alt="" decoding="async" /> : null}
          <span className={styles.youWords}>
            <span className={styles.label}>You</span>
            <span className={styles.line}>{account.id ? <>Others find you by <span className={styles.id}>{account.id}</span>.</> : "Others find you by your id."}</span>
          </span>
        </li>
        <li className={styles.item}>
          <SiliconMark seed="scout" size={36} />
          <span className={styles.words}>
            <span className={styles.label}>Silicons</span>
            <span className={styles.line}>AI agents you can look after.</span>
          </span>
        </li>
        <li className={styles.item}>
          <span data-sq="surface" className={styles.apps} aria-hidden="true">
            <LayoutGrid size={18} strokeWidth={1.75} />
          </span>
          <span className={styles.words}>
            <span className={styles.label}>Apps</span>
            <span className={styles.line}>Each asks what it can see.</span>
          </span>
        </li>
      </ul>
    </section>
  );
}
```

## home-intro.module.css

```css
/* Home's introduction: a soft grey tile (the canvas grey, no edge, the container corner as a squircle) with its title
   and a dismiss button in one row, then You, Silicons and Apps side by side, each a 36px picture beside a medium label
   over one secondary line. One column under 640px. */
.intro { --sq-r: var(--radius-container); --sq-fill: var(--canvas); display: grid; gap: var(--space-section); padding: var(--space-section); background: var(--sq-fill); }
.head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-group); }
.title { margin: 0; color: var(--foreground); font-size: var(--text-base); font-weight: 500; line-height: var(--leading-body); }
/* The dismiss button's own padding sits outside the tile's corner, so the X lines up with the content edge. */
.close { margin: calc(var(--space-tight) * -1) calc(var(--space-tight) * -1) calc(var(--space-tight) * -1) 0; }

.items { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-section); margin: 0; padding: 0; list-style: none; }
.item { display: flex; min-width: 0; align-items: flex-start; gap: var(--space-group); }
.words { display: grid; min-width: 0; gap: var(--space-hair); }
.label { color: var(--foreground); font-size: var(--text-sm); font-weight: 500; line-height: var(--leading-body); }
.line { color: var(--text-secondary); font-size: var(--text-sm); line-height: var(--leading-body); }
.id { font-family: var(--font-mono); letter-spacing: 0; }

/* You: a small card (clipped to the container squircle) on a 135° gradient of the picture's own palette, dark to light
   (--you-1 to 4, set by home-intro.tsx; the Silicon colours until the picture is read). The picture sits in the lower
   right and melts into the gradient: a mask fades its left and top edges to nothing. The words sit at the top left, on
   the gradient's dark end, light on a dark palette (data-on-dark) and ink on a light one. */
.you {
  --sq-r: var(--radius-container);
  --you-1: var(--silicon-mark-1-from); --you-2: var(--silicon-mark-3-from); --you-3: var(--silicon-mark-1-to); --you-4: var(--silicon-mark-2-to);
  position: relative; display: grid; min-width: 0; min-height: 140px; overflow: hidden; isolation: isolate;
  background: linear-gradient(135deg, var(--you-1), var(--you-2) 40%, var(--you-3) 72%, var(--you-4));
  transition: background var(--duration-considered) var(--ease-standard);
}
.youPicture {
  position: absolute; z-index: -1; right: 0; bottom: 0; width: 64%; height: 86%; object-fit: cover; object-position: 50% 20%;
  -webkit-mask-image: linear-gradient(to left, #000 45%, transparent), linear-gradient(to top, #000 70%, transparent);
  -webkit-mask-composite: source-in;
  mask-image: linear-gradient(to left, #000 45%, transparent), linear-gradient(to top, #000 70%, transparent);
  mask-composite: intersect;
}
.youWords { display: grid; min-width: 0; width: 60%; justify-self: start; align-content: start; gap: var(--space-hair); padding: var(--space-group); }
.you[data-on-dark] .label { color: var(--neutral-0); }
.you[data-on-dark] .line { color: color-mix(in oklab, var(--neutral-0) 82%, transparent); }

/* Apps: a white squircle with a hairline edge and the apps grid icon, 36px like the other pictures. */
.apps { --sq-r: var(--radius-control); --sq-fill: var(--surface); --sq-stroke: var(--border); display: grid; width: 36px; height: 36px; flex: none; place-items: center; border: 1px solid var(--sq-stroke); background: var(--sq-fill); color: var(--text-secondary); }

@media (max-width: 639px) {
  .items { grid-template-columns: minmax(0, 1fr); gap: var(--space-inset); }
}
```
