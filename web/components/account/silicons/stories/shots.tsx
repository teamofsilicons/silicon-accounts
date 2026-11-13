"use client";

/**
 * The Silicons stories' pictures (Anil, 2026-11-01): one small animated product shot per beat, built with the stageshow
 * kit, in the site's own look and with its own words, in the story card's top-right corner. Each plays once when its
 * beat starts; its still (reduced motion, before it plays) is the payoff. Filler bars stand in for the words a shot
 * doesn't need.
 *
 * 1. MeetShot: Scout's card arrives in Your Silicons, carrying New Silicon along.
 * 2. IdShot: "scout" is typed into the create form's Id field, and it comes back available.
 * 3. KeyShot: the STK card; the key is shown, then copied.
 * 4. AppsShot: the CLI signs Scout in, then asks for a short-lived token for Briefcase (a Silicon never sees an app's
 *    sign-in page: docs/start/silicon-sign-in-to-apps.md).
 * 5. CareShot: Scout's request to be looked after, accepted; its mark turns from waiting to active.
 */
import { Copy, Eye, EyeOff, KeyRound, Plus, Sparkle } from "lucide-react";
import { Bar, Check, Prompt, Stage, States, Window, type Act } from "@/components/foundation/stageshow/kit";
import { SiliconMark } from "../../parts/silicon-mark";
import styles from "./shots.module.css";

/** Every shot's design size; the stage scales it to its box. */
const W = 360;
const H = 210;
/** A made-up uuid for Scout, so its mark and card take one colour pair everywhere. */
const SCOUT = "5c0u7000-0000-4000-8000-000000000001";

// 1. Meet ------------------------------------------------------------------------------------------------------------

type Meet = { arrived: boolean };

async function meetScript(a: Act<Meet>) {
  await a.wait(900);
  a.put({ arrived: true });
  await a.wait(2600);
}

export function MeetShot() {
  return (
    <Stage width={W} height={H} initial={{ arrived: false }} poster={{ arrived: true }} script={meetScript} play="once" className={styles.shot}>
      {(s) => (
        <div className={styles.card}>
          <span className={styles.heading}>Your Silicons</span>
          <div className={styles.tiles} data-arrived={s.arrived || undefined}>
            <span className={styles.scout}>
              <Sparkle className={styles.scoutSpark} size={20} fill="currentColor" strokeWidth={1} />
              <span className={styles.scoutName}>Scout</span>
              <span className={styles.scoutId}>si:scout</span>
              <span className={styles.scoutFact}>Key never changed</span>
            </span>
            <span className={styles.newTile}>
              <span className={styles.newPlus}><Plus size={16} strokeWidth={1.75} /></span>
              <span className={styles.newLabel}>New Silicon</span>
            </span>
          </div>
        </div>
      )}
    </Stage>
  );
}

// 2. Its id ----------------------------------------------------------------------------------------------------------

type Id = { handle: string; checked: boolean };

async function idScript(a: Act<Id>) {
  await a.wait(700);
  await a.type("handle", "scout", { interval: 120 });
  await a.wait(450);
  a.put({ checked: true });
  await a.wait(2400);
}

export function IdShot() {
  return (
    <Stage width={W} height={H} initial={{ handle: "", checked: false }} poster={{ handle: "scout", checked: true }} script={idScript} play="once" className={styles.shot}>
      {(s) => (
        <div className={styles.card}>
          <span className={styles.label}>Display name</span>
          <span className={styles.field}>Scout</span>
          <span className={`${styles.label} ${styles.next}`}>Id</span>
          <span className={styles.field} data-focused={!s.checked || undefined}>
            <span className={styles.prefix}>si:</span>
            <span>{s.handle}</span>
            {s.checked ? null : <span className={styles.caret} />}
          </span>
          <span className={styles.status}>
            <States
              value={s.checked ? "available" : "hint"}
              align="start"
              states={{
                hint: <Bar w={220} className={styles.filler} />,
                available: <span className={styles.available}><Check on size={14} />si:scout is available.</span>,
              }}
            />
          </span>
        </div>
      )}
    </Stage>
  );
}

// 3. Its key ---------------------------------------------------------------------------------------------------------

type Key = { shown: boolean; copied: boolean };

/** A made-up key in the STK's shape; never a real one. */
const KEY = "stk-9fK2mQ7xL4vR8pN3wZ";

async function keyScript(a: Act<Key>) {
  await a.wait(700);
  await a.click({ at: "show", x: 0.5, y: 0.5 });
  a.put({ shown: true });
  await a.wait(1100);
  await a.click({ at: "copy", x: 0.5, y: 0.5 });
  a.put({ copied: true });
  await a.move({ at: "copy", x: -1.4, y: 1.8 });
  await a.wait(1600);
}

export function KeyShot() {
  return (
    <Stage width={W} height={H} initial={{ shown: false, copied: false }} poster={{ shown: true, copied: true }} script={keyScript} play="once" cursor={{ at: { x: 120, y: 196 } }} className={styles.shot}>
      {(s) => (
        <div className={styles.card}>
          <div className={styles.head}>
            <span className={styles.icon}><KeyRound size={16} strokeWidth={1.75} /></span>
            <span className={styles.titles}>
              <span className={styles.title}>si:scout is ready. Store its STK now</span>
              <Bar w="78%" className={styles.filler} />
            </span>
          </div>
          <span className={styles.label}>STK</span>
          <div className={styles.well}>
            <span className={styles.key}>
              <States
                value={s.shown ? "shown" : "hidden"}
                align="start"
                states={{ hidden: <span>{"•".repeat(KEY.length)}</span>, shown: <span>{KEY}</span> }}
              />
            </span>
            <span className={styles.action} data-target="show" data-cursor="pointer">
              {s.shown ? <EyeOff size={14} strokeWidth={1.75} /> : <Eye size={14} strokeWidth={1.75} />}
            </span>
            <span className={styles.action} data-target="copy" data-cursor="pointer" data-copied={s.copied || undefined}>
              <span className={styles.layer} data-on={!s.copied || undefined}><Copy size={14} strokeWidth={1.75} /></span>
              <span className={styles.layer} data-on={s.copied || undefined}><Check on={s.copied} size={14} />Copied</span>
            </span>
          </div>
          <div className={styles.foot}>
            <Bar w="46%" className={styles.filler} />
            <span className={styles.primary}>I&apos;ve stored it</span>
          </div>
        </div>
      )}
    </Stage>
  );
}

// 4. Apps ------------------------------------------------------------------------------------------------------------

type Apps = { first: string; signedIn: boolean; second: string; token: boolean };

const SIGN_IN = "silicon-accounts login --silicon si:scout";
const FOR_APP = "silicon-accounts login --app briefcase -q";

async function appsScript(a: Act<Apps>) {
  await a.wait(500);
  await a.type("first", SIGN_IN, { interval: 32 });
  await a.wait(350);
  a.put({ signedIn: true });
  await a.wait(700);
  await a.type("second", FOR_APP, { interval: 32 });
  await a.wait(350);
  a.put({ token: true });
  await a.wait(2200);
}

export function AppsShot() {
  return (
    <Stage
      width={W}
      height={H}
      initial={{ first: "", signedIn: false, second: "", token: false }}
      poster={{ first: SIGN_IN, signedIn: true, second: FOR_APP, token: true }}
      script={appsScript}
      play="once"
      className={styles.shot}
    >
      {(s) => (
        <Window chrome="terminal" className={styles.terminal}>
          <Prompt>{s.first}</Prompt>
          <div data-on={s.signedIn || undefined} className={styles.out}>Signed in as si:scout (Scout), a Silicon.</div>
          <Prompt data-on={s.signedIn || undefined} className={styles.out}>{s.second}</Prompt>
          {/* A made-up short-lived token in its shape: one app, one use, 2 minutes. */}
          <div data-on={s.token || undefined} className={`${styles.out} ok`}>slt_9Hc2Lq7mWx4R</div>
        </Window>
      )}
    </Stage>
  );
}

// 5. You look after it -----------------------------------------------------------------------------------------------

type Care = { accepting: boolean; done: boolean };

async function careScript(a: Act<Care>) {
  await a.wait(900);
  await a.click({ at: "accept", x: 0.5, y: 0.5 });
  a.put({ accepting: true });
  await a.wait(900);
  a.put({ done: true });
  await a.move({ at: "accept", x: 0.3, y: 2.4 });
  await a.wait(2000);
}

export function CareShot() {
  return (
    <Stage width={W} height={H} initial={{ accepting: false, done: false }} poster={{ accepting: true, done: true }} script={careScript} play="once" cursor={{ at: { x: 90, y: 200 } }} className={styles.shot}>
      {(s) => (
        <div className={styles.card}>
          <div className={styles.head}>
            <SiliconMark seed={SCOUT} size={36} pending={!s.done} />
            <span className={styles.titles}>
              <span className={styles.title}>Scout wants you to look after it</span>
              <span className={styles.detail}>14 days left</span>
            </span>
          </div>
          <Bar w="92%" className={styles.filler} />
          <Bar w="64%" className={styles.filler} />
          <div className={`${styles.foot} ${styles.buttons}`}>
            <span className={styles.secondary}>Decline</span>
            <span className={styles.primary} data-target="accept" data-cursor="pointer" data-busy={s.accepting || undefined}>
              <span className={styles.layer} data-on={!s.accepting || undefined}>Accept and become custodian</span>
              <span className={styles.layer} data-on={s.accepting || undefined}><Check on={s.done} pending={s.accepting && !s.done} size={14} /></span>
            </span>
          </div>
        </div>
      )}
    </Stage>
  );
}
