/**
 * The landing page's illustration: a Carbon's card and the card of the Silicon in their care, joined by the custodian
 * line, in the identity card's look (components/foundation/identity). Plain server-rendered markup, decorative: the
 * same facts are in the page's text, so it is hidden from assistive technology.
 */
import type { CSSProperties } from "react";
import { BadgeCheck, Bot, KeyRound, UserRound } from "lucide-react";
import styles from "./landing.module.css";

const APPS = [
  { name: "Briefcase", initials: "B", hue: 220 },
  { name: "DM", initials: "D", hue: 160 },
  { name: "Remind", initials: "R", hue: 30 },
  { name: "Ring", initials: "Ri", hue: 280 },
];

function Stamps() {
  return (
    <span className={styles.artStamps}>
      {APPS.map((app, index) => (
        <span key={app.name} className={styles.artStamp} data-sq="surface" style={{ "--stamp-hue": String(app.hue), "--stamp-angle": `${[-4, 3, -2, 4][index]}deg` } as CSSProperties}>
          {app.initials}
        </span>
      ))}
    </span>
  );
}

export function IdentityArt() {
  return (
    <div className={styles.art} aria-hidden="true">
      <div className={`${styles.artCard} ${styles.artCarbon}`} data-sq="surface">
        <span className={styles.artGrain} />
        <div className={styles.artWho}>
          <span className={styles.artAvatar} data-sq="clip" data-kind="carbon">AO</span>
          <span className={styles.artNames}>
            <span className={styles.artName}>Ada Okafor</span>
            <span className={styles.artKind}><UserRound size={13} strokeWidth={1.75} />Carbon</span>
          </span>
        </div>
        <dl className={styles.artFields}>
          <div><dt>Id</dt><dd className={styles.artMono}>c:ada</dd></div>
          <div><dt>Signs in with</dt><dd>Google</dd></div>
          <div><dt>Password</dt><dd>None needed</dd></div>
        </dl>
      </div>
      <div className={styles.artLink}>
        <span className={styles.artLinkLine} />
        <span className={styles.artLinkLabel} data-sq="surface"><BadgeCheck size={13} strokeWidth={1.75} />Custodian</span>
      </div>
      <div className={`${styles.artCard} ${styles.artSilicon}`} data-sq="surface">
        <span className={styles.artGrain} />
        <div className={styles.artWho}>
          <span className={styles.artAvatar} data-sq="clip" data-kind="silicon"><Bot size={22} strokeWidth={1.75} /></span>
          <span className={styles.artNames}>
            <span className={styles.artName}>Scout</span>
            <span className={styles.artKind}><Bot size={13} strokeWidth={1.75} />Silicon</span>
          </span>
        </div>
        <dl className={styles.artFields}>
          <div><dt>Id</dt><dd className={styles.artMono}>si:scout</dd></div>
          <div><dt>Custodian</dt><dd className={styles.artMono}>c:ada</dd></div>
          <div><dt>Signs in with</dt><dd><KeyRound size={13} strokeWidth={1.75} />An SLT, no browser</dd></div>
        </dl>
        <div className={styles.artFoot}>
          <span className={styles.artFootLabel}>Signed into</span>
          <Stamps />
        </div>
      </div>
    </div>
  );
}
