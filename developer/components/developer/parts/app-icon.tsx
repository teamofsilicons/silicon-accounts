"use client";

/**
 * An app's mark, drawn as the Silicon Apps store draws it: its logo in a squircle with a one-pixel line, or, with no
 * logo (or while one fails to load), the first letter of its own name past a leading "Silicon", in the serif on quiet
 * beige. AppIconUpload is the same mark with a way to set the logo: hovering or focusing it offers "Upload".
 */
import { useState } from "react";
import { ImageUp, LoaderCircle } from "lucide-react";
import { publishingMediaUrl } from "@/lib/apps-media";
import styles from "./parts.module.css";

export type AppIconSize = 24 | 32 | 40 | 48 | 56 | 64;

export interface AppIconProps {
  name: string;
  src?: string | null;
  size?: AppIconSize;
  className?: string;
  /** The name is written right beside it: hide the icon from assistive tech so it is not read twice. */
  decorative?: boolean;
}

/** The letter for an app without a logo: past a leading "Silicon" (a shelf of S tiles tells apps apart from nothing). */
export function monogramOf(name: string): string {
  const own = name.trim().replace(/^silicon\s+(?=\S)/i, "") || name;
  const letter = [...own].find(char => /\p{L}|\p{N}/u.test(char));
  return (letter ?? "?").toUpperCase();
}

export function AppIcon({ name, src, size = 40, className, decorative }: AppIconProps) {
  const url = publishingMediaUrl(src);
  const [broken, setBroken] = useState<string | null>(null);
  const logo = url && broken !== url ? url : null;
  const classes = [styles.appIcon, styles[`icon${size}`], className].filter(Boolean).join(" ");
  const label = decorative ? undefined : `${name} logo`;
  return (
    <span data-sq="clip" className={classes} data-logo={logo ? "" : undefined} role={decorative ? undefined : "img"} aria-label={label} aria-hidden={decorative || undefined}>
      {logo
        // eslint-disable-next-line @next/next/no-img-element -- app logos are the authors' own images (https or data:), shown as they are.
        ? <img src={logo} alt="" decoding="async" referrerPolicy="no-referrer" onError={() => setBroken(logo)} />
        : <span className={styles.monogram}>{monogramOf(name)}</span>}
    </span>
  );
}

/** What an icon can be: raster images become a 256 px square PNG; SVG is kept as drawn. */
const ACCEPT = "image/png,image/jpeg,image/webp,image/gif,image/svg+xml";
const MAX_SVG_BYTES = 256 * 1024;
const SIDE = 256;

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("The file could not be read."));
    reader.readAsDataURL(file);
  });
}

/**
 * The chosen file as a self-contained data: URL, so the logo shows the same everywhere it travels (the store, Silicon
 * Accounts, hosted sign-in) with nothing else to host: SVG as drawn, anything else drawn into a 256 px square (cover).
 */
export async function iconDataUrl(file: File): Promise<string> {
  if (file.type === "image/svg+xml") {
    if (file.size > MAX_SVG_BYTES) throw new Error("Choose an SVG of 256 KB or less.");
    return readAsDataUrl(file);
  }
  if (!ACCEPT.split(",").includes(file.type)) throw new Error("Choose a PNG, JPEG, WebP, GIF or SVG image.");
  const bitmap = await createImageBitmap(file).catch(() => { throw new Error("That image could not be opened."); });
  const canvas = document.createElement("canvas");
  canvas.width = SIDE;
  canvas.height = SIDE;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser cannot prepare the image.");
  const scale = Math.max(SIDE / bitmap.width, SIDE / bitmap.height);
  const width = bitmap.width * scale;
  const height = bitmap.height * scale;
  context.drawImage(bitmap, (SIDE - width) / 2, (SIDE - height) / 2, width, height);
  bitmap.close();
  return canvas.toDataURL("image/png");
}

export interface AppIconUploadProps extends AppIconProps {
  /** Saves the logo (a data: URL); a rejection's message is shown under the mark. */
  onUpload: (logo: string) => Promise<unknown>;
}

/** The app's mark with "Upload" on hover or focus: one click opens the file picker, and the new icon saves at once. */
export function AppIconUpload({ onUpload, ...icon }: AppIconUploadProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The file picker, made only when asked for, so the page carries no second file field (publishing has its own). */
  const pick = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ACCEPT;
    input.addEventListener("change", () => void choose(input.files?.[0]), { once: true });
    input.click();
  };
  const choose = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      await onUpload(await iconDataUrl(file));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The icon could not be saved.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className={styles.iconUpload}>
      <button type="button" data-sq="clip" className={styles.iconUploadButton} onClick={pick} disabled={busy} aria-label={`Upload an icon for ${icon.name}`} aria-describedby={error ? "app-icon-error" : undefined}>
        <AppIcon {...icon} decorative />
        <span className={styles.iconUploadHint} data-busy={busy || undefined} aria-hidden="true">
          {busy ? <LoaderCircle className={styles.iconUploadSpinner} size={20} strokeWidth={1.75} /> : <ImageUp size={20} strokeWidth={1.75} />}
          <span>{busy ? "Saving" : "Upload"}</span>
        </span>
      </button>
      <span className="sr-only" role="status">{busy ? "Saving the icon" : ""}</span>
      {error ? <span id="app-icon-error" className={styles.iconUploadError} role="alert">{error}</span> : null}
    </span>
  );
}
