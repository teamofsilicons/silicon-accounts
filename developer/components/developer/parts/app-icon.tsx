"use client";

/** An app's logo as a squircle (Arc's Avatar), with its initials while the logo loads or when it has none. */
import { Avatar } from "@/components/arc/avatar/avatar";
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

export function AppIcon({ name, src, size = 40, className, decorative }: AppIconProps) {
  return (
    <Avatar
      name={name}
      src={src ?? undefined}
      size="md"
      aria-hidden={decorative || undefined}
      className={[styles.appIcon, styles[`icon${size}`], className].filter(Boolean).join(" ")}
    />
  );
}
