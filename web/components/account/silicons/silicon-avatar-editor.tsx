"use client";

/**
 * Making a Silicon's avatar (Anil, 2026-11-13: "what if the user doesn't want to upload but create a new avatar?"), in
 * the Silicon page's Photo dialog, from the mosaic generator's Silicons tab: the avatar large and alive, its form and
 * colour stepped with arrows (each named), its eyes and facing as segmented controls, and Shuffle for a new grain of
 * pixels. Save Avatar uploads a transparent animated GIF as the Silicon's photo (so every app sees it), embeds the
 * editable settings in that file, and remembers the look in this browser. Nothing is saved until then.
 */
import { useEffect, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Shuffle } from "lucide-react";
import { Button } from "@teamofsilicons/silicon-ui/button";
import SegmentedControl from "@teamofsilicons/silicon-ui/segmented-control";
import type { ManagedSilicon } from "@/lib/api/types";
import { SILICON_EYES, SILICON_FORMS, SILICON_PALETTES, siliconChoiceFromSeed, siliconFormName, siliconPaletteName, type SiliconAvatarChoice, type SiliconEyes } from "@/lib/silicon-avatar";
import { siliconAvatarGif } from "@/lib/silicon-avatar-gif";
import { siliconPhotoAsset } from "@/lib/silicon-photo-asset";
import { rememberSiliconAvatar, useSiliconPicture } from "@/lib/silicon-picture";
import { useUploadSiliconPhoto } from "@/lib/query/silicons";
import { describeError } from "../parts/common";
import { SiliconAvatar } from "../parts/silicon-avatar";
import styles from "./silicon-avatar-editor.module.css";

const EYES: Record<SiliconEyes, string> = { right: "Right", left: "Left", inward: "Inward" };

/** `children`: the dialog's other ways (a photo, a link, the default), between the maker and its actions. */
export function SiliconAvatarEditor({ silicon, onDone, children }: { silicon: ManagedSilicon; onDone: () => void; children?: ReactNode }) {
  const picture = useSiliconPicture(silicon);
  const upload = useUploadSiliconPhoto();
  const [choice, setChoice] = useState<SiliconAvatarChoice>(() => (picture.kind === "avatar" ? picture.choice : siliconChoiceFromSeed(silicon.uuid)));
  const [savedGif, setSavedGif] = useState<{ photo: string; choice: SiliconAvatarChoice } | null>(null);
  const photoSrc = picture.kind === "photo" ? picture.src : null;
  useEffect(() => {
    if (!photoSrc) return;
    let active = true;
    void siliconPhotoAsset(photoSrc).then(asset => {
      if (active && asset.kind === "avatar" && asset.choice) {
        setChoice(asset.choice);
        setSavedGif({ photo: photoSrc, choice: asset.choice });
      }
    });
    return () => { active = false; };
  }, [photoSrc]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = silicon.display_name || silicon.id || "this Silicon";

  const cycle = (list: string[], current: string, by: number) => list[(list.indexOf(current) + by + list.length) % list.length];
  const change = (patch: Partial<SiliconAvatarChoice>) => { setChoice(current => ({ ...current, ...patch })); setError(null); };
  const unchanged = (picture.kind === "avatar" && picture.customised && JSON.stringify(picture.choice) === JSON.stringify(choice)) ||
    (picture.kind === "photo" && savedGif?.photo === picture.src && JSON.stringify(savedGif.choice) === JSON.stringify(choice));

  const save = async () => {
    setPending(true);
    setError(null);
    try {
      // The GIF's first frame is the still image; its transparent frames carry the look to every browser.
      const gif = siliconAvatarGif(choice);
      const result = await upload.mutateAsync({ uuid: silicon.uuid, file: new File([gif], "avatar.gif", { type: "image/gif" }) });
      if (result.silicon.pfp_url) rememberSiliconAvatar(silicon.uuid, choice, result.silicon.pfp_url);
      onDone();
    } catch (raw) {
      setError(describeError(raw));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className={styles.maker}>
      <div data-sq="surface" className={styles.stage}>
        <SiliconAvatar seed={silicon.uuid} choice={choice} animate className={styles.avatar} label={`${name}'s avatar: ${siliconFormName(choice.form)} in ${siliconPaletteName(choice.palette)}`} />
      </div>
      <div className={styles.controls}>
        <Stepper label="Form" value={siliconFormName(choice.form)} onStep={by => change({ form: cycle(SILICON_FORMS, choice.form, by) })} />
        <Stepper label="Colour" value={siliconPaletteName(choice.palette)} onStep={by => change({ palette: cycle(SILICON_PALETTES, choice.palette, by) })} />
        <div className={styles.row}>
          <span className={styles.rowLabel}>Eyes</span>
          <SegmentedControl size="sm" label="Eyes" options={SILICON_EYES.map(value => ({ value, label: EYES[value] }))} value={choice.eyes} onValueChange={value => change({ eyes: value as SiliconEyes })} />
        </div>
        <div className={styles.row}>
          <span className={styles.rowLabel}>Facing</span>
          <SegmentedControl size="sm" label="Facing" options={[{ value: "original", label: "Original" }, { value: "mirrored", label: "Mirrored" }]} value={choice.mirror ? "mirrored" : "original"} onValueChange={value => change({ mirror: value === "mirrored" })} />
        </div>
        <Button variant="link" size="sm" className={styles.shuffle} onClick={() => change({ seed: Math.round(Math.random() * 998) + 1 })}>
          <Shuffle size={14} strokeWidth={2} aria-hidden="true" />Shuffle Pixels
        </Button>
      </div>
      {children}
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      <div className={styles.actions}>
        <Button type="button" variant="ghost" onClick={onDone} disabled={pending}>Cancel</Button>
        <Button type="button" loading={pending} disabled={unchanged} onClick={() => void save()}>Save Avatar</Button>
      </div>
    </div>
  );
}

function Stepper({ label, value, onStep }: { label: string; value: string; onStep: (by: number) => void }) {
  return (
    <div className={styles.row}>
      <span className={styles.rowLabel}>{label}</span>
      <span className={styles.stepper}>
        <Button variant="secondary" size="xs" aria-label={`Previous ${label.toLowerCase()}`} onClick={() => onStep(-1)}><ChevronLeft size={14} strokeWidth={2} aria-hidden="true" /></Button>
        <span className={styles.value} aria-live="polite">{value}</span>
        <Button variant="secondary" size="xs" aria-label={`Next ${label.toLowerCase()}`} onClick={() => onStep(1)}><ChevronRight size={14} strokeWidth={2} aria-hidden="true" /></Button>
      </span>
    </div>
  );
}
