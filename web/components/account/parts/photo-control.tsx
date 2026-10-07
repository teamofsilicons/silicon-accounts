"use client";

/**
 * A profile photo you can change: drop an image on it, or open the photo menu to choose one or go back to the default
 * photo. The new photo shows at once while it uploads (raw bytes, PNG, JPEG, WebP or GIF, at most 2 MB); a failure
 * puts the old one back and says why, in the menu and in a toast (the upload hooks toast with the server's words).
 * Used for your own photo on the identity card. Escape while "Remove photo?" is asked answers no and keeps the menu
 * open; the next one closes it.
 */
import { useEffect, useId, useRef, useState, type CSSProperties, type DragEvent } from "react";
import { Camera, ImageUp, LoaderCircle } from "lucide-react";
import { Avatar } from "@/components/arc/avatar/avatar";
import { Button } from "@/components/arc/button/button";
import { ConfirmMorph } from "@/components/arc/confirm-morph/confirm-morph";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/arc/popover/popover";
import { describeError, isDefaultPhoto, PHOTO_ACCEPT, photoProblem } from "./common";
import { FitPrompt } from "./fit-prompt";
import styles from "./photo.module.css";

export interface PhotoControlProps {
  /** Display name, for the initials and the accessible name. */
  name: string;
  src: string | null | undefined;
  /** Uploads the file; resolves once the new photo is in place. Rejects with the API error. */
  upload: (file: File) => Promise<unknown>;
  /** Goes back to the default photo. Rejects with the API error. */
  remove: () => Promise<unknown>;
  /** Pixel size of the portrait (112 on the identity card). */
  size?: number;
  /** One line for the menu: who sees the photo. */
  audience?: string;
  /** Accessible name of the camera button. */
  triggerLabel?: string;
}

const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes("Files");

export function PhotoControl({ name, src, upload, remove, size = 112, audience = "Every app that can see your profile sees it.", triggerLabel = "Change your photo" }: PhotoControlProps) {
  const [preview, setPreview] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const titleId = useId();
  // An object URL still showing when the control unmounts is released.
  const previewRef = useRef<string | null>(null);
  useEffect(() => () => {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
  }, []);

  const start = async (file: File) => {
    const problem = photoProblem(file);
    if (problem) {
      setError(problem);
      setOpen(true);
      return;
    }
    setError(null);
    const url = URL.createObjectURL(file);
    previewRef.current = url;
    setPreview(url);
    setUploading(true);
    try {
      await upload(file);
      setOpen(false);
    } catch (raw) {
      setError(describeError(raw));
      setOpen(true);
    } finally {
      setUploading(false);
      setPreview(null);
      URL.revokeObjectURL(url);
      previewRef.current = null;
    }
  };

  const onDragEnter = (event: DragEvent) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    depth.current += 1;
    setDragging(true);
  };
  const onDragOver = (event: DragEvent) => {
    if (hasFiles(event)) event.preventDefault();
  };
  const onDragLeave = () => {
    depth.current = Math.max(0, depth.current - 1);
    if (!depth.current) setDragging(false);
  };
  const onDrop = (event: DragEvent) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    depth.current = 0;
    setDragging(false);
    const file = event.dataTransfer?.files?.[0];
    if (file) void start(file);
  };
  const choose = () => fileInput.current?.click();
  const own = !isDefaultPhoto(src);

  return (
    <div
      className={styles.photo}
      data-dragging={dragging || undefined}
      data-busy={uploading || undefined}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      style={{ "--photo-size": `${size}px` } as CSSProperties}
    >
      <Avatar name={name} src={preview ?? src ?? undefined} size="xl" className={styles.portrait} />
      <span data-sq="surface" className={styles.dropHint} aria-hidden="true"><ImageUp size={24} strokeWidth={1.75} /></span>
      {uploading ? <span className={styles.busy} aria-hidden="true"><LoaderCircle className={styles.spinner} size={22} strokeWidth={1.75} /></span> : null}
      <span className="sr-only" role="status">{uploading ? "Uploading the photo" : ""}</span>
      <Popover open={open} onOpenChange={next => { setOpen(next); if (!next) setError(null); }}>
        <PopoverTrigger data-sq="surface" className={styles.trigger} aria-label={triggerLabel} disabled={uploading}>
          <Camera size={16} strokeWidth={1.75} aria-hidden="true" />
        </PopoverTrigger>
        <PopoverContent className={styles.menu} side="bottom" align="start" sideOffset={8} aria-labelledby={titleId}>
          <p id={titleId} className={styles.menuTitle}>Profile photo</p>
          <p className={styles.menuText}>PNG, JPEG, WebP or GIF, up to 2 MB. {audience}</p>
          <button
            data-sq="surface"
            type="button"
            className={styles.drop}
            data-dragging={dragging || undefined}
            onClick={choose}
            onDragEnter={onDragEnter}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
          >
            <ImageUp size={20} strokeWidth={1.75} aria-hidden="true" />
            <span>Drop an image here, or choose one</span>
          </button>
          {error ? <p className={styles.error} role="alert">{error}</p> : null}
          <div className={styles.menuActions}>
            {own ? (
              <ConfirmMorph
                label="Remove photo"
                prompt={<FitPrompt full="Remove photo?" short="Remove photo?" tiny="Remove?" />}
                confirmLabel="Remove"
                pendingLabel="Removing"
                doneLabel="Removed"
                resultTimeout={2400}
                onConfirm={async () => {
                  setError(null);
                  try {
                    await remove();
                  } catch (raw) {
                    setError(describeError(raw));
                    throw raw;
                  }
                }}
              />
            ) : <span className={styles.menuNote}>This is the default photo.</span>}
            <Button variant="secondary" size="sm" onClick={choose} loading={uploading}>Choose a photo</Button>
          </div>
        </PopoverContent>
      </Popover>
      <input
        ref={fileInput}
        type="file"
        accept={PHOTO_ACCEPT}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={event => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) void start(file);
        }}
      />
    </div>
  );
}
