/**
 * An app's mark: its logo in a squircle (the dark logo on dark surfaces when the app has one), or its initials when
 * it has no logo or the logo fails to load.
 */
import { Show, createEffect, createSignal, on } from "solid-js";
import { cx } from "../../../arc/lib/cx";
import { useSquircle } from "../../../arc/lib/squircle";
import { theme } from "../../../theme/theme";
import styles from "./parts.module.css";

export interface AppMarkApp {
  app_id: string;
  name: string;
  logo_url: string | null;
  logo_dark_url?: string | null;
}

export function AppMark(props: { app: AppMarkApp; size?: number; class?: string; decorative?: boolean }) {
  const src = () => (theme() === "dark" && props.app.logo_dark_url ? props.app.logo_dark_url : props.app.logo_url);
  const [failed, setFailed] = createSignal<string | null>(null);
  createEffect(on(src, () => setFailed(null), { defer: true }));
  const initials = () => props.app.name.split(/\s+/).filter(Boolean).slice(0, 2).map(word => word[0]?.toUpperCase() ?? "").join("") || props.app.app_id.slice(0, 2).toUpperCase();
  return (
    <span
      ref={el => useSquircle(el, { mode: "clip" })}
      class={cx(styles.appMark, props.class)}
      style={{ "--mark-size": `${props.size ?? 40}px` }}
      role={props.decorative ? undefined : "img"}
      aria-label={props.decorative ? undefined : props.app.name}
      aria-hidden={props.decorative ? "true" : undefined}
    >
      <Show when={src() && failed() !== src()} fallback={<span class={styles.appInitials}>{initials()}</span>}>
        <img src={src() ?? ""} alt="" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(src() ?? null)} />
      </Show>
    </span>
  );
}
