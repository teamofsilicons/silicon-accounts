/**
 * The embed page and the SDK in the style guide, each on a stand-in for an app's page. In development the embed's
 * source is served at /embed/buttons.html (production serves the build at /embed/v1/buttons), and the SDK module is
 * imported directly, so it renders through window.SiliconAccounts.renderButtons rather than a script tag.
 */
import { For, createEffect, onCleanup, onMount } from "solid-js";
import { useSquircle } from "../../arc/lib/squircle";
import { theme } from "../../theme/theme";
import styles from "./kitchen.module.css";

interface Sample {
  kind: "Iframe" | "SDK";
  appId: string;
  note: string;
}

const SAMPLES: Sample[] = [
  { kind: "Iframe", appId: "briefcase", note: "Default look, every method; email is the one primary" },
  { kind: "Iframe", appId: "pixel-studio", note: "Sharp corners, outline primary, Space Grotesk" },
  { kind: "SDK", appId: "acme-notes", note: "Shadow DOM buttons, radius 28" },
  { kind: "SDK", appId: "orbit-games", note: "Apple only, compact, soft" },
];

const REDIRECT = "https://app.example/callback";

type Sdk = { renderButtons: (target: Element, options: Record<string, unknown>) => Promise<{ destroy(): void }> };

function EmbedFrame(props: { appId: string }) {
  let frame: HTMLIFrameElement | undefined;
  const src = () =>
    `/embed/buttons.html?${new URLSearchParams({ app_id: props.appId, redirect_uri: REDIRECT, response_type: "code", state: "kitchen", theme: theme() }).toString()}`;
  onMount(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; height?: number } | null;
      if (!frame || event.source !== frame.contentWindow || data?.type !== "silicon-accounts:resize" || typeof data.height !== "number") return;
      frame.style.height = `${Math.max(48, Math.ceil(data.height))}px`;
    };
    window.addEventListener("message", onMessage);
    onCleanup(() => window.removeEventListener("message", onMessage));
  });
  return <iframe ref={frame} class={styles.embedFrame} src={src()} title={`Sign in to ${props.appId} (embedded)`} />;
}

function SdkButtons(props: { appId: string }) {
  let host: HTMLDivElement | undefined;
  createEffect(() => {
    const current = theme();
    let rendered: { destroy(): void } | undefined;
    let cancelled = false;
    void import("../../../sdk/v1").then(() => {
      const sdk = (window as unknown as { SiliconAccounts?: Sdk }).SiliconAccounts;
      if (cancelled || !sdk || !host) return;
      return sdk.renderButtons(host, { appId: props.appId, redirectUri: REDIRECT, theme: current }).then(result => {
        if (cancelled) result.destroy();
        else rendered = result;
      });
    }).catch(() => {
      // The SDK shows its own error inside the host and logs it.
    });
    onCleanup(() => {
      cancelled = true;
      rendered?.destroy();
    });
  });
  return <div ref={host} class={styles.sdkHost} />;
}

export function Embeds() {
  return (
    <div class={styles.embedGrid}>
      <For each={SAMPLES}>
        {sample => (
          <figure class={styles.embedCell}>
            <div ref={el => useSquircle(el)} class={styles.hostPage}>
              <span class={styles.hostBar} aria-hidden="true"><i /><i /><i /><span>{sample.appId}.example</span></span>
              <div class={styles.hostBody}>
                <p class={styles.hostTitle}>Sign in to continue</p>
                {sample.kind === "Iframe" ? <EmbedFrame appId={sample.appId} /> : <SdkButtons appId={sample.appId} />}
              </div>
            </div>
            <figcaption class={styles.brandCaption}><span>{sample.kind} · {sample.appId}</span><span>{sample.note}</span></figcaption>
          </figure>
        )}
      </For>
    </div>
  );
}
