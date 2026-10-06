/**
 * Embed: everything needed to add sign-in to the app, ready to paste. Three ways in (the hosted link, the iframe, the
 * SDK snippet), the callback's code exchange, refresh and userinfo calls, Silicon sign-in with a short-lived token,
 * OIDC discovery, and a live preview of the buttons the iframe and SDK render from the app's saved configuration.
 */
import { Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import { ArrowUpRight, RefreshCw, TriangleAlert } from "lucide-solid";
import { api, type OidcDiscovery, type SigninMethod } from "../../../api";
import { Alert } from "../../../arc/alert/alert";
import { Button, LinkButton } from "../../../arc/button/button";
import { ChipGroup } from "../../../arc/chip-group/chip-group";
import { CodeBlock } from "../../../arc/code-block/code-block";
import { JsonViewer } from "../../../arc/json-viewer/json-viewer";
import { SegmentedControl } from "../../../arc/segmented-control/segmented-control";
import { Select } from "../../../arc/select/select";
import { Switch as Toggle } from "../../../arc/switch/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../../arc/tabs/tabs";
import { useSquircle } from "../../../arc/lib/squircle";
import { Section, Surface } from "../../../app/layout/layout";
import { theme as siteTheme } from "../../../theme/theme";
import { useDeveloperApp } from "../lib/context";
import { METHOD_LABEL } from "../lib/labels";
import { CopyField } from "../parts/CopyField";
import styles from "./embed.module.css";

type Way = "hosted" | "iframe" | "sdk";
type ServerStep = "exchange" | "refresh" | "silicons";
type Sdk = { renderButtons: (target: Element, options: Record<string, unknown>) => Promise<{ destroy(): void }> };

const SCOPES = [
  { value: "openid", label: "openid (an id_token)" },
  { value: "email", label: "email" },
  { value: "phone", label: "phone" },
  { value: "dob", label: "dob" },
  { value: "timezone", label: "timezone" },
];

/**
 * The SDK reads an app's public setup once per page and keeps it (sdk/v1.ts), so its buttons show the version that was
 * stored when they first rendered on this page. This remembers that version per app for exactly as long (one page
 * load), so the preview can say when a newer one is saved.
 */
const previewedVersion = new Map<string, number>();

function randomState(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

/** The app's buttons as the SDK renders them (in a Shadow DOM), on a stand-in page of the app. Clicks stay here. */
function ButtonsPreview(props: { appId: string; redirectUri: string; theme: "light" | "dark" | "auto"; method: string; version: number; onShown: (version: number) => void }) {
  let host: HTMLDivElement | undefined;
  const [error, setError] = createSignal<string | null>(null);
  createEffect(on(() => [props.appId, props.redirectUri, props.theme, props.method] as const, ([appId, redirectUri, theme, method]) => {
    let rendered: { destroy(): void } | undefined;
    let cancelled = false;
    const version = props.version;
    setError(null);
    void import("../../../../sdk/v1").then(() => {
      const sdk = (window as unknown as { SiliconAccounts?: Sdk }).SiliconAccounts;
      if (cancelled || !sdk || !host) return;
      return sdk.renderButtons(host, { appId, redirectUri, theme, ...(method ? { method } : {}) }).then(result => {
        // The first render that succeeds is the one the SDK keeps for the rest of the page.
        if (!previewedVersion.has(appId)) previewedVersion.set(appId, version);
        props.onShown(previewedVersion.get(appId) ?? version);
        if (cancelled) result.destroy();
        else rendered = result;
      });
    }).catch(failure => {
      if (!cancelled) setError(failure instanceof Error ? failure.message : String(failure));
    });
    onCleanup(() => {
      cancelled = true;
      rendered?.destroy();
    });
  }));
  // The preview never leaves the page: a capturing listener stops the click before the SDK's own handler.
  const stop = (event: MouseEvent) => {
    if ((event.target as Element | null)?.closest?.("[data-preview-host]")) {
      event.stopPropagation();
      event.preventDefault();
    }
  };
  return (
    <div ref={el => { useSquircle(el); el.addEventListener("click", stop, true); onCleanup(() => el.removeEventListener("click", stop, true)); }} class={styles.previewWrap}>
      <div ref={el => useSquircle(el)} class={styles.hostPage} data-theme={props.theme === "auto" ? siteTheme() : props.theme}>
        <span class={styles.hostBar} aria-hidden="true"><i /><i /><i /><span>{props.appId}.example</span></span>
        <div class={styles.hostBody}>
          <p class={styles.hostTitle}>Sign in to continue</p>
          <div ref={host} class={styles.sdkHost} data-preview-host="" />
        </div>
      </div>
      <Show when={error()}>{message => <p class={styles.previewError}>{message()}</p>}</Show>
    </div>
  );
}

export default function EmbedTab() {
  const ctx = useDeveloperApp();
  const config = () => ctx.editor.base();
  const base = () => ctx.publicUrl();
  const [redirect, setRedirect] = createSignal(config().redirect_uris[0] ?? "");
  const [scopes, setScopes] = createSignal<string[]>([]);
  const [pkce, setPkce] = createSignal(true);
  const [method, setMethod] = createSignal<string>("any");
  const [previewTheme, setPreviewTheme] = createSignal<"light" | "dark" | "auto">("auto");
  const [way, setWay] = createSignal<Way>("hosted");
  const [serverStep, setServerStep] = createSignal<ServerStep>("exchange");
  const [discovery, setDiscovery] = createSignal<OidcDiscovery | null>(null);
  const [discoveryError, setDiscoveryError] = createSignal<string | null>(null);
  const [shownVersion, setShownVersion] = createSignal<number | undefined>(previewedVersion.get(ctx.appId));
  const previewBehind = () => {
    const shown = shownVersion();
    return shown !== undefined && shown < ctx.editor.version() ? shown : null;
  };

  onMount(() => {
    api.meta.oidcDiscovery().then(setDiscovery).catch(error => setDiscoveryError(error instanceof Error ? error.message : String(error)));
  });
  createEffect(on(() => config().redirect_uris, uris => { if (!uris.includes(redirect())) setRedirect(uris[0] ?? ""); }, { defer: true }));

  const methods = createMemo<SigninMethod[]>(() => config().method_order.filter(item => config().methods[item]));
  const redirectUri = () => redirect() || "https://your-app.example/auth/callback";
  const scope = () => scopes().join(" ");
  const params = (state: string, extra: Record<string, string> = {}) => {
    const query = new URLSearchParams({ app_id: ctx.appId, redirect_uri: redirectUri(), state, ...(scope() ? { scope: scope() } : {}), ...(method() !== "any" ? { method: method() } : {}), ...extra });
    return query.toString();
  };
  const hostedUrl = () => `${base()}/authorize?${params("STATE", pkce() ? { code_challenge: "CHALLENGE", code_challenge_method: "S256" } : {})}`;
  const iframeSrc = () => `${base()}/embed/v1/buttons?${params("STATE", { theme: "auto", ...(pkce() ? { code_challenge: "CHALLENGE", code_challenge_method: "S256" } : {}) })}`;
  const tryUrl = () => `${base()}/authorize?${params(randomState())}`;

  const hostedSnippet = () => `<a href="${hostedUrl().replace(/&/g, "&amp;")}">\n  Sign in with Silicon Accounts\n</a>`;
  const pkceSnippet = () => `// Before sending the browser: a fresh state and PKCE pair per sign-in, kept for the callback.
const b64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
const state = b64(crypto.getRandomValues(new Uint8Array(16)));
const verifier = b64(crypto.getRandomValues(new Uint8Array(32)));
const challenge = b64(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
sessionStorage.setItem("signin", JSON.stringify({ state, verifier }));
location.assign(\`${base()}/authorize?app_id=${ctx.appId}&redirect_uri=\${encodeURIComponent("${redirectUri()}")}&state=\${state}&code_challenge=\${challenge}&code_challenge_method=S256\`);`;
  const iframeSnippet = () => `<iframe
  title="Sign in to ${ctx.app().name}"
  src="${iframeSrc().replace(/&/g, "&amp;")}"
  style="width: 100%; height: 200px; border: 0"
></iframe>
<script>
  // The buttons report their height so the frame never scrolls.
  addEventListener("message", event => {
    if (event.origin !== "${base()}" || event.data?.type !== "silicon-accounts:resize") return;
    document.querySelector('iframe[title="Sign in to ${ctx.app().name}"]').style.height = event.data.height + "px";
  });
</script>`;
  const sdkSnippet = () => `<div id="silicon-accounts"></div>
<script
  src="${base()}/sdk/v1.js"
  data-app-id="${ctx.appId}"
  data-redirect-uri="${redirectUri()}"
  data-target="#silicon-accounts"${pkce() ? `\n  data-pkce="S256"` : ""}${scope() ? `\n  data-scope="${scope()}"` : ""}${method() !== "any" ? `\n  data-method="${method()}"` : ""}
  async
></script>`;
  const sdkApiSnippet = () => `// Or from your own button, once the script has loaded:
SiliconAccounts.signIn({ appId: "${ctx.appId}", redirectUri: "${redirectUri()}"${pkce() ? `, pkce: "S256"` : ""}${method() !== "any" ? `, method: "${method()}"` : ""} });

// The SDK keeps { state, code_verifier, nonce, redirect_uri, app_id } in
// sessionStorage["silicon-accounts:auth:<state>"] for your callback page.`;
  const exchangeSnippet = () => `# Your server, on ${redirectUri()}?code=…&state=…
# Check the state first, then exchange the code (valid 2 minutes, once):
curl -u ${ctx.appId}:$APP_SECRET \\
  -d grant_type=authorization_code \\
  -d code=sac_… \\
  --data-urlencode redirect_uri=${redirectUri()}${pkce() ? ` \\\n  -d code_verifier=$VERIFIER` : ""} \\
  ${base()}/v1/oauth/token

# → { "access_token": "eyJ…", "expires_in": 1800, "refresh_token": "sar_…",
#     "membership_id": "${ctx.appId}:a8K", "account": { "uuid": "a8K", "id": "c:saket", … } }
# Store the account's uuid: ids like c:saket can change, the uuid never does.`;
  const refreshSnippet = () => `# Access tokens last 30 minutes; refresh tokens 900 days and rotate on every use.
curl -u ${ctx.appId}:$APP_SECRET \\
  -d grant_type=refresh_token -d refresh_token=sar_… \\
  ${base()}/v1/oauth/token

# Who is this? (the details the account shares with ${ctx.appId})
curl -H "Authorization: Bearer $ACCESS_TOKEN" ${base()}/v1/userinfo

# Sign the account out of ${ctx.appId}
curl -u ${ctx.appId}:$APP_SECRET -d token=sar_… ${base()}/v1/oauth/revoke`;
  const siliconSnippet = () => `# Silicons never see a sign-in page. The Silicon gets a short-lived token for ${ctx.appId}:
accounts login --app ${ctx.appId} -q          # prints slt_… (valid 2 minutes, once)

# …and ${ctx.appId}'s server exchanges it for the Silicon's tokens:
curl -u ${ctx.appId}:$APP_SECRET \\
  -d grant_type=urn:silicon:params:oauth:grant-type:slt -d slt=slt_… \\
  ${base()}/v1/oauth/token`;

  return (
    <div class={styles.embed}>
      <Surface class={styles.options}>
        <div class={styles.optionsGrid}>
          <Show
            when={config().redirect_uris.length}
            fallback={
              <Alert tone="warning" title="No redirect URI is registered" action={<Button size="sm" variant="secondary" onClick={() => ctx.openTab("sign-in")}>Add one in Sign-in</Button>}>
                Sign-in sends people back only to a registered redirect URI. The snippets below use a placeholder until you add one.
              </Alert>
            }
          >
            <Select label="Redirect URI" description="Where the browser comes back with the code." value={redirect()} onValueChange={setRedirect} options={config().redirect_uris.map(uri => ({ value: uri, label: uri }))} />
          </Show>
          <Select
            label="Sign-in method"
            description="Jump straight to one method, or let them choose."
            value={method()}
            onValueChange={setMethod}
            options={[{ value: "any", label: "Let them choose" }, ...methods().map(item => ({ value: item, label: METHOD_LABEL[item] }))]}
          />
        </div>
        <div class={styles.optionsRow}>
          <div class={styles.scopeField}>
            <span class={styles.fieldLabel}>Extra scopes</span>
            <ChipGroup label="Extra scopes" options={SCOPES} value={scopes()} onValueChange={setScopes} multiple />
            <span class={styles.fieldHint}>Profile is always shared. What else is shared follows the app's required and optional details; openid adds an id_token.</span>
          </div>
          <label class={styles.pkce}>
            <Toggle aria-label="Use PKCE" checked={pkce()} onChange={setPkce} />
            <span><strong>PKCE</strong> for browser-only and mobile apps (recommended everywhere)</span>
          </label>
        </div>
      </Surface>

      <Section title="Add sign-in" description="Three ways in; all of them end on your redirect URI with ?code= and your state.">
        <Tabs value={way()} onValueChange={value => setWay(value as Way)}>
          <TabsList aria-label="Ways to add sign-in">
            <TabsTrigger value="hosted">Hosted link</TabsTrigger>
            <TabsTrigger value="iframe">Iframe</TabsTrigger>
            <TabsTrigger value="sdk">SDK</TabsTrigger>
          </TabsList>
          <TabsContent value="hosted">
            <div class={styles.way}>
              <p class={styles.fieldHint}>Send the browser to the hosted sign-in page. Works without any allowed origin. Generate a fresh state for every sign-in, keep it, and compare it on your callback.</p>
              <CodeBlock filename="Sign-in link" language="html" code={hostedSnippet()} wrap />
              <Show when={pkce()}><CodeBlock filename="State and PKCE in the browser" language="js" code={pkceSnippet()} maxLines={8} wrap /></Show>
              <div class={styles.inlineActions}>
                <LinkButton href={tryUrl()} target="_blank" rel="noopener" variant="secondary" size="sm">Open the hosted page<ArrowUpRight size={14} stroke-width={1.75} aria-hidden="true" /></LinkButton>
                <span class={styles.fieldHint}>A real sign-in to {ctx.app().name} in a new tab, with a random state.</span>
              </div>
            </div>
          </TabsContent>
          <TabsContent value="iframe">
            <div class={styles.way}>
              <p class={styles.fieldHint}>The app's buttons inside your page; a click takes the whole window to the hosted sign-in.</p>
              <Show when={!config().allowed_origins.length}>
                <Alert tone="warning" title="The iframe needs an allowed origin" action={<Button size="sm" variant="secondary" onClick={() => ctx.openTab("sign-in")}>Add one in Sign-in</Button>}>
                  Browsers only show it on pages whose origin is listed in Allowed origins. With none listed, it shows a configuration error.
                </Alert>
              </Show>
              <CodeBlock filename="Iframe" language="html" code={iframeSnippet()} wrap />
            </div>
          </TabsContent>
          <TabsContent value="sdk">
            <div class={styles.way}>
              <p class={styles.fieldHint}>One script renders the same buttons in a Shadow DOM, so your styles and theirs never mix. It creates and keeps the state (and PKCE) for you. Its buttons work on any site without an allowed origin; only its iframe mode, SiliconAccounts.mountFrame(), needs the page's origin in Allowed origins, like the iframe.</p>
              <CodeBlock filename="SDK" language="html" code={sdkSnippet()} wrap />
              <CodeBlock filename="SDK from JavaScript" language="js" code={sdkApiSnippet()} wrap />
            </div>
          </TabsContent>
        </Tabs>
      </Section>

      <Section
        title="Live preview"
        description="The buttons the iframe and the SDK render, from the saved setup. Clicks do nothing here."
        actions={<SegmentedControl label="Preview theme" size="sm" value={previewTheme()} onValueChange={setPreviewTheme} options={[{ value: "auto", label: "Auto" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} />}
      >
        <Show when={ctx.editor.dirty("signin") || ctx.editor.dirty("branding")}>
          <p class={styles.dirtyNote}><TriangleAlert size={14} stroke-width={1.75} aria-hidden="true" />You have unsaved Sign-in or Branding changes; the preview shows the saved setup.</p>
        </Show>
        <Show when={previewBehind()}>
          {shown => (
            <div class={styles.staleNote} role="status">
              <span><TriangleAlert size={14} stroke-width={1.75} aria-hidden="true" />The preview shows version {shown()}, the one the SDK read when it first ran on this page; version {ctx.editor.version()} is saved now. The SDK reads an app's setup once per page, so reload the page to see it.</span>
              <Button size="sm" variant="secondary" onClick={() => window.location.reload()}><RefreshCw size={14} stroke-width={1.75} aria-hidden="true" />Reload the page</Button>
            </div>
          )}
        </Show>
        <ButtonsPreview appId={ctx.appId} redirectUri={redirectUri()} theme={previewTheme()} method={method() === "any" ? "" : method()} version={ctx.editor.version()} onShown={setShownVersion} />
      </Section>

      <Section title="On your server" description="With the app's credentials (app id and secret, HTTP Basic). Store each account's uuid: ids such as c:saket can change, the uuid never does.">
        <Tabs value={serverStep()} onValueChange={value => setServerStep(value as ServerStep)}>
          <TabsList aria-label="Server calls">
            <TabsTrigger value="exchange">Exchange the code</TabsTrigger>
            <TabsTrigger value="refresh">Refresh and sign out</TabsTrigger>
            <TabsTrigger value="silicons">Silicons</TabsTrigger>
          </TabsList>
          <TabsContent value="exchange"><div class={styles.way}><CodeBlock filename="POST /v1/oauth/token" language="bash" code={exchangeSnippet()} wrap /></div></TabsContent>
          <TabsContent value="refresh"><div class={styles.way}><CodeBlock filename="Refresh, userinfo and sign-out" language="bash" code={refreshSnippet()} wrap /></div></TabsContent>
          <TabsContent value="silicons">
            <div class={styles.way}>
              <p class={styles.fieldHint}>A Silicon signs in with its si:id and STK, never on a page, and hands your app a short-lived token.</p>
              <CodeBlock filename="Short-lived token" language="bash" code={siliconSnippet()} wrap />
            </div>
          </TabsContent>
        </Tabs>
      </Section>

      <Section title="OpenID Connect" description="Generic OIDC libraries configure themselves from the discovery document. Access and id tokens are EdDSA JWTs signed with the keys at jwks_uri.">
        <div class={styles.urls}>
          <CopyField label="Discovery URL" value={`${base()}/.well-known/openid-configuration`} copyLabel="Copy URL" />
          <CopyField label="JWKS" value={discovery()?.jwks_uri ?? `${base()}/.well-known/jwks.json`} copyLabel="Copy URL" />
          <CopyField label="Issuer" value={discovery()?.issuer ?? base()} copyLabel="Copy issuer" />
          <CopyField label="Client id" value={ctx.appId} copyLabel="Copy id" description="The client secret is the app secret from Silicon Apps." />
        </div>
        <Show when={discovery()} fallback={<Show when={discoveryError()}>{message => <Alert tone="danger" title="The discovery document could not be loaded">{message()}</Alert>}</Show>}>
          {document => <JsonViewer data={document()} rootName="openid-configuration" defaultExpandDepth={1} maxHeight={320} label="OpenID Connect discovery document" />}
        </Show>
      </Section>
    </div>
  );
}
