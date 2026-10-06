/** An app's logo as a squircle, with its initials while the logo loads or when it has none. */
import { Avatar } from "../../../arc/avatar/avatar";
import { cx } from "../../../arc/lib/cx";
import styles from "./parts.module.css";

export function AppIcon(props: { name: string; src?: string | null; size?: 24 | 32 | 40 | 48 | 56 | 64; class?: string }) {
  return <Avatar name={props.name} src={props.src ?? undefined} size="md" class={cx(styles.appIcon, styles[`icon${props.size ?? 40}`], props.class)} />;
}
