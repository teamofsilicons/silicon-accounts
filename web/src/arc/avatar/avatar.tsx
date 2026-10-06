import { Show, createEffect, createSignal, on, splitProps, type JSX } from "solid-js";
import { cx } from "../lib/cx";
import { useSquircle } from "../lib/squircle";
import styles from "./avatar.module.css";

export type AvatarSize = "xs" | "sm" | "md" | "lg" | "xl" | "xxl";

export interface AvatarProps extends JSX.HTMLAttributes<HTMLSpanElement> {
  /** Display name; initials are drawn from it while the photo loads or when it fails. */
  name: string;
  src?: string | null;
  size?: AvatarSize;
  status?: "online" | "offline";
  /** Silicons get a subtle mark so Carbons and Silicons read differently at a glance. */
  kind?: "carbon" | "silicon";
}

/**
 * Arc Avatar as a squircle. A decoded photo shows at once; one still loading fades in from a soft blur. Initials stand
 * in when there is no photo or it fails to load.
 */
export function Avatar(props: AvatarProps) {
  const [local, rest] = splitProps(props, ["name", "src", "size", "status", "kind", "class"]);
  const [failed, setFailed] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);
  createEffect(on(() => local.src, () => setLoading(false)));
  const initials = () => local.name.trim().split(/\s+/).slice(0, 2).map(part => part[0]?.toUpperCase() ?? "").join("") || "?";
  const showImage = () => !!local.src && failed() !== local.src;
  return (
    <span
      {...rest}
      ref={el => useSquircle(el, { mode: "clip" })}
      class={cx(styles.avatar, styles[local.size ?? "md"], local.kind === "silicon" && styles.silicon, local.class)}
      role="img"
      aria-label={`${local.name}${local.status ? `, ${local.status}` : ""}`}
    >
      <Show when={showImage()} fallback={<span class={cx(styles.initials, local.src ? styles.fallback : undefined)} aria-hidden="true">{initials()}</span>}>
        <img
          ref={img => { if (!img.complete) setLoading(true); }}
          src={local.src ?? ""}
          alt=""
          decoding="async"
          data-loading={loading() ? "" : undefined}
          onLoad={() => setLoading(false)}
          onError={() => setFailed(local.src ?? null)}
          referrerPolicy="no-referrer"
        />
      </Show>
      <Show when={local.status}>
        <i class={cx(styles.status, styles[local.status ?? "offline"])} aria-hidden="true" />
      </Show>
    </span>
  );
}

export default Avatar;
