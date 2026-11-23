"use client";

/**
 * /__silicon: a Silicon's page as its profile (Anil, 2026-11-21, "this page is like the profile page for silicon"):
 * a big photo, its name and si:id, when it was last active, its timezone and local time, then the apps it is signed in
 * to, each with Sign Out. No STK: it can't be seen once made. Sample data; Sign Out asks, then takes the app off the
 * list here (nothing is sent).
 *
 *   A  Beside: the photo on the left, name, id and a line of facts beside it; About and Apps as rows below.
 *   B  Centred: the photo, name and id centred, three facts in a row under them, then the apps.
 *   C  Its sky: a band painted with the sky over its timezone right now, the creature standing in it, then the apps.
 *
 * The photo is the Silicon's Alive avatar (Anil, 2026-11-21, "use their alive avatar design here"): the cards' moving
 * pixel creature (parts/silicon-avatar.tsx: shimmer, glances, blinks, a twinkling halo), on its own colours' wash in
 * A and B as on the cards, in its sky in C.
 *
 * What the API gives for each part: the photo, name, id, timezone and created_at are the Silicon's own fields; "last
 * active" is its newest successful sign-in (GET /v1/me/silicons/{uuid}/signins) or app sign-in; the apps are
 * GET /v1/me/silicons/{uuid}/apps; Sign Out is DELETE /v1/me/silicons/{uuid}/apps/{app_id}.
 */
import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Clock, HeartHandshake } from "lucide-react";
import { Button } from "@teamofsilicons/silicon-ui/button";
import { Dialog, DialogContent } from "@teamofsilicons/silicon-ui/dialog";
import { AppMark } from "@/components/account/parts/app-mark";
import { Row, Section, Strong, Tile } from "@/components/account/parts/rows";
import { SiliconAvatar } from "@/components/account/parts/silicon-avatar";
import { siliconChoiceFromSeed, siliconPalette } from "@/lib/silicon-avatar";
import { localMinutes, skyColor, skyInk } from "@/lib/sky";
import { offsetMinutes, timezoneLabel, utcOffset } from "@/lib/timezones";
import styles from "./silicon-profile-lab.module.css";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.now();

const SILICON = { uuid: "researcher", name: "Researcher", id: "si:researcher", timezone: "Asia/Kolkata", lastActive: NOW - 2 * HOUR, since: NOW - 41 * DAY };

interface SampleApp { app_id: string; name: string; logo_url: string | null; signedIn: number; sessions: number }
const APPS: SampleApp[] = [
  { app_id: "dm", name: "Silicon DM", logo_url: "/icons/dm/web/icon-192.png", signedIn: NOW - 2 * HOUR, sessions: 2 },
  { app_id: "briefcase", name: "Briefcase", logo_url: "/icons/briefcase/web/icon-192.png", signedIn: NOW - 1 * DAY, sessions: 1 },
  { app_id: "write", name: "Silicon Write", logo_url: "/icons/write/web/icon-192.png", signedIn: NOW - 19 * DAY, sessions: 1 },
];

const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
function ago(at: number) {
  const minutes = Math.round((at - NOW) / 60_000);
  if (Math.abs(minutes) < 60) return relative.format(minutes, "minute");
  if (Math.abs(minutes) < 24 * 60) return relative.format(Math.round(minutes / 60), "hour");
  return relative.format(Math.round(minutes / (24 * 60)), "day");
}
const localTime = (timeZone: string) => new Intl.DateTimeFormat("en", { timeZone, hour: "numeric", minute: "2-digit" }).format(NOW);
const sinceDate = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" }).format(SILICON.since);
const place = timezoneLabel(SILICON.timezone);

const VERSIONS: { id: string; name: string; note: string; render: () => ReactNode }[] = [
  { id: "beside", name: "A · Beside", note: "The Alive avatar on its colour wash, on the left at 96px; its name, si:id and one line of facts beside it (active when, its local time). About (timezone, in your care since) and the apps follow as the site's rows.", render: () => <Beside /> },
  { id: "centred", name: "B · Centred", note: "A profile in the middle: the Alive avatar on its wash at 144px, the name and si:id under it, three facts side by side (Last active, Local time, In your care since), then the apps.", render: () => <Centred /> },
  { id: "sky", name: "C · Its sky", note: "A band painted with the sky over its timezone right now (the colours of Sky bands), the Silicon standing in it, alive; then name, id and facts, then the apps. The timezone shows without being written twice.", render: () => <Sky /> },
];

export function SiliconProfileLab() {
  return (
    <main className={styles.lab}>
      <header className={styles.intro}>
        <h1 className={styles.title}>A Silicon&rsquo;s page as its profile</h1>
        <p className={styles.lede}>Three versions with one sample Silicon. Big photo, name, id, when it was last active, its timezone, then the apps it is signed in to, each with Sign Out. No STK. Sign Out asks first, then takes the app off this list (nothing is sent).</p>
      </header>
      {VERSIONS.map(version => (
        <section key={version.id} className={styles.version} aria-labelledby={`profile-${version.id}`}>
          <div className={styles.versionHead}>
            <h2 id={`profile-${version.id}`} className={styles.versionName}>{version.name}</h2>
            <p className={styles.versionNote}>{version.note}</p>
          </div>
          <div className={styles.stage}><div className={styles.column}>{version.render()}</div></div>
        </section>
      ))}
    </main>
  );
}

/* Shared --------------------------------------------------------------------------------------------------------- */

function Apps({ id }: { id: string }) {
  const [apps, setApps] = useState(APPS);
  const [asking, setAsking] = useState<SampleApp | null>(null);
  return (
    <Section id={`${id}-apps`} title="Apps" count={apps.length}>
      {apps.map(app => (
        <Row key={app.app_id} lead={<AppMark app={{ app_id: app.app_id, name: app.name, logo_url: app.logo_url, logo_dark_url: null }} size={28} decorative />} title={app.name}
          detail={<>Signed in <Strong>{ago(app.signedIn)}</Strong> · {app.sessions === 1 ? "1 active session" : `${app.sessions} active sessions`}</>}>
          <Button variant="secondary" size="sm" onClick={() => setAsking(app)}>Sign Out</Button>
        </Row>
      ))}
      {apps.length === 0 ? <Row lead={null} title="Not signed in to any apps" detail={`${SILICON.name} signs in to apps itself, with its STK.`} /> : null}
      <Dialog open={!!asking} onOpenChange={open => { if (!open) setAsking(null); }}>
        <DialogContent title={`Sign ${SILICON.name} out of ${asking?.name ?? "the app"}?`}
          description={<>Its sessions in <strong>{asking?.name}</strong> end, and the app no longer sees its details. {SILICON.name} can sign in again on its own, with its STK.</>}>
          <div className={styles.actions}>
            <Button variant="ghost" onClick={() => setAsking(null)}>Cancel</Button>
            <Button variant="danger" onClick={() => { setApps(list => list.filter(app => app.app_id !== asking?.app_id)); setAsking(null); }}>Sign Out</Button>
          </div>
        </DialogContent>
      </Dialog>
    </Section>
  );
}

/** The Alive avatar on a wash of its own colours, as the Silicon cards draw it (parts/silicon-card.module.css). */
function Portrait({ size }: { size: "md" | "lg" }) {
  const colours = useMemo(() => siliconPalette(siliconChoiceFromSeed(SILICON.uuid)), []);
  const style = { "--avatar-1": colours[0], "--avatar-2": colours[Math.floor(colours.length / 2)], "--avatar-3": colours[colours.length - 1] } as CSSProperties;
  return (
    <span data-sq="clip" className={styles.portrait} data-size={size} style={style}>
      <SiliconAvatar seed={SILICON.uuid} animate label={SILICON.name} className={styles.portraitAvatar} />
    </span>
  );
}

function Identity({ centred }: { centred?: boolean }) {
  return (
    <div className={styles.identity} data-centred={centred || undefined}>
      <h3 className={styles.name}>{SILICON.name}</h3>
      <span className={`${styles.id} mono`}>{SILICON.id}</span>
    </div>
  );
}

/* A · Beside ----------------------------------------------------------------------------------------------------- */

function Beside() {
  return (
    <div className={styles.page}>
      <div className={styles.beside}>
        <Portrait size="md" />
        <div className={styles.besideText}>
          <Identity />
          <p className={styles.facts}>Active <Strong>{ago(SILICON.lastActive)}</Strong> · {localTime(SILICON.timezone)} in {place.split(",")[0]}</p>
        </div>
      </div>
      <Section id="beside-about" title="About">
        <Row lead={<Tile><Clock size={16} strokeWidth={2} /></Tile>} title="Timezone" detail={`${place} · UTC${utcOffset(SILICON.timezone)}`} />
        <Row lead={<Tile><HeartHandshake size={16} strokeWidth={2} /></Tile>} title="In your care since" detail={sinceDate} />
      </Section>
      <Apps id="beside" />
    </div>
  );
}

/* B · Centred ---------------------------------------------------------------------------------------------------- */

function Centred() {
  return (
    <div className={styles.page}>
      <div className={styles.centred}>
        <Portrait size="lg" />
        <Identity centred />
        <dl className={styles.stats}>
          <div><dt>Last active</dt><dd>{ago(SILICON.lastActive)}</dd></div>
          <div><dt>Local time</dt><dd>{localTime(SILICON.timezone)} · {place.split(",")[0]}</dd></div>
          <div><dt>In your care since</dt><dd>{sinceDate}</dd></div>
        </dl>
      </div>
      <Apps id="centred" />
    </div>
  );
}

/* C · Its sky ---------------------------------------------------------------------------------------------------- */

function Sky() {
  const offset = offsetMinutes(SILICON.timezone, new Date(NOW));
  const at = new Date(NOW);
  const minutes = localMinutes(offset, at);
  // The sky an hour either side, so the band reads as a stretch of sky, not one flat colour.
  const band = `linear-gradient(90deg, ${skyColor(minutes - 90)}, ${skyColor(minutes)}, ${skyColor(minutes + 90)})`;
  return (
    <div className={styles.page}>
      <div data-sq="surface" className={styles.sky}>
        <div className={styles.skyBand} style={{ backgroundImage: band }}>
          <SiliconAvatar seed={SILICON.uuid} animate label={SILICON.name} className={styles.skyAvatar} />
          <span className={styles.skyTime} style={{ color: skyInk(minutes) }}><Clock size={14} strokeWidth={2} aria-hidden="true" /> {localTime(SILICON.timezone)} in {place.split(",")[0]}</span>
        </div>
        <div className={styles.skyBody}>
          <Identity />
          <p className={styles.facts}>Active <Strong>{ago(SILICON.lastActive)}</Strong> · UTC{utcOffset(SILICON.timezone)} · In your care since {sinceDate}</p>
        </div>
      </div>
      <Apps id="sky" />
    </div>
  );
}
