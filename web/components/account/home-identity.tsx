"use client";

/**
 * Home on the blank canvas (Anil, 2026-10-30): at the head of the page's column, the Carbon's picture as a large squircle
 * in a colour ring drawn from the picture's own colours (lib/picture-colours.ts), with "Welcome, <first name>" and
 * their Carbon id to its right, as a chip that copies it, and
 * under that when they joined ("Member since Oct 2026"). The picture is their photo or
 * their pixel avatar (lib/carbon-avatar.ts); the account comes from GET /v1/me, with the session's summary until it
 * arrives.
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Avatar } from "@teamofsilicons/silicon-ui/avatar";
import { Button } from "@teamofsilicons/silicon-ui/button";
import { useCopyFeedback } from "@teamofsilicons/silicon-ui/lib/use-copy-feedback";
import { useCarbonPicture } from "@/lib/carbon-avatar";
import { usePictureColours } from "@/lib/picture-colours";
import { useMe, useSession } from "@/lib/query/session";
import { isValidTimezone } from "@/lib/timezones";
import styles from "./home-identity.module.css";

/** Makes Home's ring glow for a moment (the picture and the introduction's You card call it). */
const GLOW_EVENT = "accounts:you-glow";
export function glowYou() {
  window.dispatchEvent(new Event(GLOW_EVENT));
}
const GLOW_MS = 1100;

/**
 * The ring's glow: on GLOW_EVENT the halo flares for a second (CSS, data-glow, alternating "a" and "b" so a click
 * during a glow starts it again) and the ring's spin runs six times as fast, then back, keeping its angle. Nothing moves when motion is reduced.
 */
function useGlow() {
  const ring = useRef<HTMLSpanElement>(null);
  const [glow, setGlow] = useState(0);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onGlow = () => {
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      setGlow(count => count + 1);
      const spin = ring.current?.getAnimations().find(animation => (animation as CSSAnimation).animationName?.includes("ring-turn"));
      spin?.updatePlaybackRate(6);
      clearTimeout(timer);
      timer = setTimeout(() => {
        spin?.updatePlaybackRate(1);
        setGlow(0);
      }, GLOW_MS);
    };
    window.addEventListener(GLOW_EVENT, onGlow);
    return () => {
      window.removeEventListener(GLOW_EVENT, onGlow);
      clearTimeout(timer);
    };
  }, []);
  return { ring, glow };
}

export function HomeIdentity() {
  const { ring, glow } = useGlow();
  const { session } = useSession();
  const me = useMe();
  const account = me.data ?? session?.account;
  const picture = useCarbonPicture(account);
  const src = picture?.src ?? account?.pfp_url;
  // The ring takes the picture's own colours when they can be read, else the Silicon colours (the CSS defaults).
  const colours = usePictureColours(src);
  const ringStyle = colours ? (Object.fromEntries(colours.map((colour, index) => [`--ring-${index + 1}`, colour])) as CSSProperties) : undefined;
  if (!account) return null;
  const first = account.display_name.trim().split(/\s+/)[0] || account.display_name;
  // GET /v1/me carries when the account was made (in its own time zone); the session's summary does not, so this waits.
  // An older browser may not know the account's (modern) zone name: then the browser's own zone, never a crash.
  const since = me.data ? new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: isValidTimezone(me.data.timezone) ? me.data.timezone : undefined }).format(new Date(me.data.created_at)) : null;

  // data-home: Home is drawn (the screens and checks wait for it; the old Home had it on its column).
  return (
    <section className={styles.identity} aria-label="Your profile" data-home="">
      {/* A click on the picture lights the ring (a flourish, not a control: nothing else happens). */}
      <span className={styles.halo} style={ringStyle} data-glow={glow ? (glow % 2 ? "a" : "b") : undefined} onClick={glowYou}>
        <span ref={ring} className={styles.ring} style={ringStyle}>
          <Avatar className={styles.picture} name={account.display_name} src={src} size="xl" />
        </span>
      </span>
      <div className={styles.text}>
        <h1 className={styles.name}>Welcome, {first}</h1>
        {account.id ? <CopyChip value={account.id} what="your CarbonID" /> : null}
        {since ? <p className={styles.since}>Member since {since}</p> : null}
      </div>
    </section>
  );
}

/** A small grey chip (the id) that copies its value on click and says so in place, with no separate copy control. */
export function CopyChip({ value, what }: { value: string; what: string }) {
  const { state, copy } = useCopyFeedback();
  const label = state === "copied" ? "Copied" : state === "error" ? "Couldn\u2019t copy" : value;
  return (
    <Button variant="soft" size="xs" className={styles.chip} onClick={() => void copy(value)} aria-label={state === "idle" ? `Copy ${what}, ${value}` : label}>
      {label}
    </Button>
  );
}
