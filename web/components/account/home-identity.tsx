"use client";

/**
 * Home on the blank canvas (Anil, 2026-10-30): at the head of the page's column, the Carbon's picture as a large squircle
 * in a colour ring drawn from the picture's own colours (lib/picture-colours.ts), with "Welcome, <first name>" and
 * their Carbon id to its right, as a chip that copies it, and
 * under that when they joined ("Member since Oct 2026"). The picture is their photo or
 * their pixel avatar (lib/carbon-avatar.ts); the account comes from GET /v1/me, with the session's summary until it
 * arrives.
 */
import type { CSSProperties } from "react";
import { Avatar } from "@teamofsilicons/silicon-ui/avatar";
import { Button } from "@teamofsilicons/silicon-ui/button";
import { useCopyFeedback } from "@teamofsilicons/silicon-ui/lib/use-copy-feedback";
import { useCarbonPicture } from "@/lib/carbon-avatar";
import { usePictureColours } from "@/lib/picture-colours";
import { useMe, useSession } from "@/lib/query/session";
import styles from "./home-identity.module.css";

export function HomeIdentity() {
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
  const since = me.data ? new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: me.data.timezone }).format(new Date(me.data.created_at)) : null;

  return (
    <section className={styles.identity} aria-label="Your account">
      <span className={styles.ring} style={ringStyle}>
        <Avatar className={styles.picture} name={account.display_name} src={src} size="xl" />
      </span>
      <div className={styles.text}>
        <h1 className={styles.name}>Welcome, {first}</h1>
        {account.id ? <CopyChip value={account.id} what="your id" /> : null}
        {since ? <p className={styles.since}>Member since {since}</p> : null}
      </div>
    </section>
  );
}

/** A small grey chip (the id) that copies its value on click and says so in place, with no separate copy control. */
function CopyChip({ value, what }: { value: string; what: string }) {
  const { state, copy } = useCopyFeedback();
  const label = state === "copied" ? "Copied" : state === "error" ? "Couldn\u2019t copy" : value;
  return (
    <Button variant="soft" size="xs" className={styles.chip} onClick={() => void copy(value)} aria-label={state === "idle" ? `Copy ${what}, ${value}` : label}>
      {label}
    </Button>
  );
}
