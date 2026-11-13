"use client";

/**
 * /__silicon-cards: a Silicon's card (components/account/parts/silicon-card.tsx) with its pixel avatar
 * (lib/silicon-avatar.ts), in each of the four blends, at Home's column under "Your Silicons". The Silicons are
 * samples, each drawn from its uuid as a real one would be; "New Silicons" draws another set. Under them, a wall of
 * avatars to see the range the generator gives.
 */
import { useEffect, useState } from "react";
import { Button } from "@teamofsilicons/silicon-ui/button";
import { SiliconCard, type SiliconCardBlend } from "@/components/account/parts/silicon-card";
import { SiliconAvatar } from "@/components/account/parts/silicon-avatar";
import { siliconAvatarGif } from "@/lib/silicon-avatar-gif";
import { siliconAvatarPng, siliconChoiceFromSeed, siliconFormName, siliconPaletteName } from "@/lib/silicon-avatar";
import styles from "./silicon-cards-lab.module.css";

const BLENDS: { blend: SiliconCardBlend; name: string; note: string }[] = [
  { blend: "wash", name: "A  Wash", note: "The creature's own colours blend behind it and fade into the card's white where the words begin." },
  { blend: "glow", name: "B  Glow", note: "A white card; a light in the avatar's colours glows behind it and fades before the words. The quietest." },
  { blend: "pixels", name: "C  Pixels", note: "The wash, plus faint pixels of the avatar's colours scattered around it, thinning towards the words: the pixel world spilling into the card." },
  { blend: "tint", name: "D  Tint", note: "The whole card wears the palette's lightest tint, words included, with a soft glow behind the avatar. No seam at all." },
];

const NAMES = ["zap", "Atlas", "Juniper", "Scout", "Mochi", "Relay"];
const uuidFor = (round: number, index: number) => `sample-${round}-${index}-silicon`;

/** A photo data URL, for the development lab's examples without uploading anything. */
function photoDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Cannot read the avatar sample."));
    reader.readAsDataURL(blob);
  });
}

export function SiliconCardsLab() {
  const [round, setRound] = useState(0);
  const [savedPhotos, setSavedPhotos] = useState<Record<string, string>>({});
  useEffect(() => {
    let active = true;
    const build = async () => {
      const originals = await Promise.all([0, 1].map(async index => {
        const seed = uuidFor(round, index);
        const png = await siliconAvatarPng(siliconChoiceFromSeed(seed), 32, 1);
        return [seed, await photoDataUrl(png)] as const;
      }));
      const gifSeed = uuidFor(round, 2);
      const gifUrl = await photoDataUrl(siliconAvatarGif(siliconChoiceFromSeed(gifSeed)));
      if (active) setSavedPhotos(Object.fromEntries([...originals, [gifSeed, gifUrl]]));
    };
    void build();
    return () => { active = false; };
  }, [round]);
  const silicons = NAMES.map((name, index) => ({ uuid: uuidFor(round, index), name, id: `si:${name.toLowerCase()}` }));
  const wall = Array.from({ length: 24 }, (_, index) => {
    const choice = siliconChoiceFromSeed(`wall-${round}-${index}`);
    return { key: index, seed: `wall-${round}-${index}`, choice, label: `${siliconFormName(choice.form)} · ${siliconPaletteName(choice.palette)}` };
  });
  return (
    <main className={styles.lab}>
      <header className={styles.intro}>
        <h1 className={styles.title}>Silicon cards</h1>
        <p className={styles.lede}>Every Silicon gets a pixel avatar from its uuid (Anil&rsquo;s mosaic generator, the Silicons tab). Each card has 3:2 artwork over a short name strip. Four ways to blend the two.</p>
        <div className={styles.tools}>
          <Button variant="secondary" size="sm" onClick={() => setRound(value => value + 1)}>New Silicons</Button>
        </div>
      </header>
      <section className={styles.design} aria-label="Older saved avatars">
        <div>
          <h2 className={styles.name}>Older saved avatars</h2>
          <p className={styles.note}>Older opaque PNG uploads and a new transparent GIF, as seen from another browser without local avatar settings. Each card&rsquo;s wash follows its saved creature&rsquo;s colours.</p>
        </div>
        <div className={styles.stage}>
          <div className={styles.column}>
            <h3 className={styles.sectionTitle}>Your Silicons</h3>
            <ul className={styles.grid}>
              {silicons.slice(0, 3).map(silicon => <li key={silicon.uuid}><SiliconCard uuid={silicon.uuid} name={silicon.name} id={silicon.id} href="/silicons" photo={savedPhotos[silicon.uuid]} /></li>)}
            </ul>
          </div>
        </div>
      </section>
      {BLENDS.map(({ blend, name, note }) => (
        <section key={blend} className={styles.design} aria-label={name}>
          <div>
            <h2 className={styles.name}>{name}</h2>
            <p className={styles.note}>{note}</p>
          </div>
          <div className={styles.stage}>
            <div className={styles.column}>
              <h3 className={styles.sectionTitle}>Your Silicons</h3>
              <ul className={styles.grid}>
                {silicons.map(silicon => <li key={silicon.uuid}><SiliconCard uuid={silicon.uuid} name={silicon.name} id={silicon.id} href="/silicons" blend={blend} /></li>)}
              </ul>
            </div>
          </div>
        </section>
      ))}
      <section className={styles.design} aria-label="The range">
        <div>
          <h2 className={styles.name}>The range</h2>
          <p className={styles.note}>Twenty-four Silicons&rsquo; avatars, alive as on Home: the mosaic shimmers, the eyes glance and blink, and the halo twinkles. Reduced motion keeps them still.</p>
        </div>
        <ul className={styles.wall}>
          {wall.map(item => <li key={item.key} className={styles.wallItem}><SiliconAvatar seed={item.seed} choice={item.choice} animate className={styles.wallAvatar} />{item.label}</li>)}
        </ul>
      </section>
    </main>
  );
}
