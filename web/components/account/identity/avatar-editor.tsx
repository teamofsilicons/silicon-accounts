"use client";

/**
 * A Carbon's picture editor (Personal info › Photo), from Anil's avatar customizer v9: the pixel avatar, live and
 * animated, with arrows on either side to step through hair, face and clothing; Save avatar uploads it as the Carbon's
 * photo (so every app sees it) and remembers the look in this browser (lib/carbon-avatar.ts). Or a photo instead,
 * through Silicon UI's file upload.
 */
import { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@teamofsilicons/silicon-ui/button";
import { FileUpload } from "@teamofsilicons/silicon-ui/file-upload";
import { PixelAvatar } from "@/components/foundation/avatar/pixel-avatar";
import type { CarbonMe } from "@/lib/api/types";
import { rememberAvatar, useCarbonPicture } from "@/lib/carbon-avatar";
import { AVATAR_PARTS, avatarPng, choiceFromSeed, type AvatarChoice, type AvatarPart } from "@/lib/pixel-avatar";
import { useUploadPhoto } from "@/lib/query/account";
import { describeError, PHOTO_ACCEPT, PHOTO_MAX_BYTES, photoProblem } from "../parts/common";
import styles from "./identity.module.css";

const PARTS: Array<{ part: AvatarPart; noun: string }> = [
  { part: "hair", noun: "hair" },
  { part: "face", noun: "face" },
  { part: "clothing", noun: "clothing" },
];

export function AvatarEditor({ me, onDone }: { me: CarbonMe; onDone: () => void }) {
  const picture = useCarbonPicture(me);
  const upload = useUploadPhoto();
  const [choice, setChoice] = useState<AvatarChoice>(() => (picture?.kind === "avatar" ? picture.choice : choiceFromSeed(me.uuid)));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const step = (part: AvatarPart, by: number) => {
    const count = AVATAR_PARTS[part].length;
    setChoice(current => ({ ...current, [part]: Math.min(count - 1, Math.max(0, current[part] + by)) }));
    setError(null);
  };
  const unchanged = picture?.kind === "avatar" && picture.customised
    && picture.choice.hair === choice.hair && picture.choice.face === choice.face && picture.choice.clothing === choice.clothing;

  const save = async () => {
    setPending(true);
    setError(null);
    try {
      const png = await avatarPng(choice);
      const result = await upload.mutateAsync(new File([png], "avatar.png", { type: "image/png" }));
      if (result.me.pfp_url) rememberAvatar(me.uuid, choice, result.me.pfp_url);
      onDone();
    } catch (raw) {
      setError(describeError(raw));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className={styles.form}>
      <div className={styles.avatarStage}>
        <div className={styles.avatarArrows}>
          {PARTS.map(({ part, noun }) => (
            <Button key={part} variant="secondary" size="sm" aria-label={`Previous ${noun}`} disabled={choice[part] <= 0} onClick={() => step(part, -1)}>
              <ChevronLeft size={16} strokeWidth={1.75} aria-hidden="true" />
            </Button>
          ))}
        </div>
        <PixelAvatar choice={choice} size={168} animate label={`Your avatar: ${AVATAR_PARTS.hair[choice.hair]}, ${AVATAR_PARTS.face[choice.face]}, ${AVATAR_PARTS.clothing[choice.clothing]}`} />
        <div className={styles.avatarArrows}>
          {PARTS.map(({ part, noun }) => (
            <Button key={part} variant="secondary" size="sm" aria-label={`Next ${noun}`} disabled={choice[part] >= AVATAR_PARTS[part].length - 1} onClick={() => step(part, 1)}>
              <ChevronRight size={16} strokeWidth={1.75} aria-hidden="true" />
            </Button>
          ))}
        </div>
      </div>
      <p className={styles.srOnly} aria-live="polite">{`Hair: ${AVATAR_PARTS.hair[choice.hair]}. Face: ${AVATAR_PARTS.face[choice.face]}. Clothing: ${AVATAR_PARTS.clothing[choice.clothing]}.`}</p>
      <FileUpload
        label="Or use a photo"
        description="A PNG, JPEG, WebP or GIF, up to 2 MB. Apps show it instead of your avatar."
        accept={PHOTO_ACCEPT}
        maxSize={PHOTO_MAX_BYTES}
        onUpload={async file => {
          const problem = photoProblem(file);
          if (problem) throw new Error(problem);
          await upload.mutateAsync(file);
          onDone();
        }}
      />
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      <div className={styles.actions}>
        <Button type="button" variant="secondary" onClick={onDone} disabled={pending}>Cancel</Button>
        <Button type="button" loading={pending} disabled={unchanged} onClick={() => void save()}>Save avatar</Button>
      </div>
    </div>
  );
}
