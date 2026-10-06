"use client";

/**
 * The embed page and the SDK, each on a stand-in for an app's page. The iframe loads /embed/v1/buttons (same origin,
 * so frame-ancestors 'self' lets the style guide frame it); the SDK is the built /sdk/v1.js, loaded once with a script
 * element (trusted through the page's nonce and 'strict-dynamic'), rendering through window.SiliconAccounts.
 */
import { useEffect, useRef } from "react";
import { useTheme } from "@/components/foundation/theme/use-theme";
import { kitchenStyles as styles } from "../specimen";

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

const REDIRECT = "http://127.0.0.1:8593/callback";

type Sdk = { renderButtons: (target: Element, options: Record<string, unknown>) => Promise<{ destroy(): void }> };

let sdkLoad: Promise<Sdk> | null = null;
function loadSdk(): Promise<Sdk> {
  sdkLoad ??= new Promise<Sdk>((resolve, reject) => {
    const ready = () => {
      const sdk = (window as unknown as { SiliconAccounts?: Sdk }).SiliconAccounts;
      if (sdk) resolve(sdk);
      else reject(new Error("The SDK loaded but did not define window.SiliconAccounts."));
    };
    if ((window as unknown as { SiliconAccounts?: Sdk }).SiliconAccounts) return ready();
    const script = document.createElement("script");
    script.src = "/sdk/v1.js";
    script.async = true;
    script.onload = ready;
    script.onerror = () => reject(new Error("/sdk/v1.js could not be loaded (run pnpm build:sdk)."));
    document.head.append(script);
  });
  return sdkLoad;
}

function EmbedFrame({ appId }: { appId: string }) {
  const { theme } = useTheme();
  const frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; height?: number } | null;
      const node = frame.current;
      if (!node || event.source !== node.contentWindow || data?.type !== "silicon-accounts:resize" || typeof data.height !== "number") return;
      node.style.height = `${Math.max(48, Math.ceil(data.height))}px`;
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);
  const src = `/embed/v1/buttons?${new URLSearchParams({ app_id: appId, redirect_uri: REDIRECT, response_type: "code", state: "kitchen", theme }).toString()}`;
  return <iframe ref={frame} className={styles.embedFrame} src={src} title={`Sign in to ${appId} (embedded)`} />;
}

function SdkButtons({ appId }: { appId: string }) {
  const { theme } = useTheme();
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let rendered: { destroy(): void } | undefined;
    let cancelled = false;
    loadSdk()
      .then(sdk => (cancelled || !host.current ? undefined : sdk.renderButtons(host.current, { appId, redirectUri: REDIRECT, theme })))
      .then(result => {
        if (!result) return;
        if (cancelled) result.destroy();
        else rendered = result;
      })
      .catch(error => console.warn(`Style guide: the SDK sample for ${appId} did not render: ${error instanceof Error ? error.message : String(error)}`));
    return () => {
      cancelled = true;
      rendered?.destroy();
    };
  }, [appId, theme]);
  return <div ref={host} className={styles.sdkHost} />;
}

export function Embeds() {
  return (
    <div className={styles.embedGrid}>
      {SAMPLES.map(sample => (
        <figure key={sample.appId} className={styles.embedCell}>
          <div data-sq="surface" className={styles.hostPage}>
            <span className={styles.hostBar} aria-hidden="true"><i /><i /><i /><span>{sample.appId}.example</span></span>
            <div className={styles.hostBody}>
              <p className={styles.hostTitle}>Sign in to continue</p>
              {sample.kind === "Iframe" ? <EmbedFrame appId={sample.appId} /> : <SdkButtons appId={sample.appId} />}
            </div>
          </div>
          <figcaption className={styles.brandCaption}><span>{sample.kind} · {sample.appId}</span><span>{sample.note}</span></figcaption>
        </figure>
      ))}
    </div>
  );
}
