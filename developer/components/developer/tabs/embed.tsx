"use client";

/**
 * Embed: everything needed to add sign-in to the app, ready to paste (UNDERSTANDING "Adding sign-in to an app"). Three
 * ways in (the hosted link, the iframe, the SDK snippet), direct buttons for the app's own site ("Continue with Google",
 * "Continue with email"…, each opening our pages on that method; Google and Apple pass through the Opening page first)
 * or just "Sign in" and "Sign up" (intent), the callback's code exchange, refresh and userinfo calls, Silicon sign-in
 * with a short-lived token, OIDC discovery, and a live preview of the buttons the SDK renders from the saved setup.
 *
 * An app never takes a Carbon's email or phone itself: there is no login hint, the Carbon always types it on our pages.
 *
 * The preview runs the real SDK from the accounts site ({public_url}/sdk/v1.js). The SDK reads an app's public setup
 * once per page load and keeps it, so each saved version loads its own copy of the script (?v=<version>).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, TriangleAlert } from "lucide-react";
import { Alert } from "@/components/arc/alert/alert";
import { Button } from "@/components/arc/button/button";
import { ChipGroup } from "@/components/arc/chip-group/chip-group";
import { CodeBlock } from "@/components/arc/code-block/code-block";
import { JsonViewer } from "@/components/arc/json-viewer/json-viewer";
import SegmentedControl from "@/components/arc/segmented-control/segmented-control";
import { Select } from "@/components/arc/select/select";
import { Switch } from "@/components/arc/switch/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/arc/tabs/tabs";
import { ButtonLink } from "@/components/foundation/button-link";
import { Section, Surface } from "@/components/foundation/layout/layout";
import { useTheme } from "@/components/foundation/theme/use-theme";
import { api } from "@/lib/api/endpoints";
import type { SigninMethod } from "@/lib/api/types";
import { useDeveloperApp } from "../lib/context";
import { useEditor } from "../lib/editor";
import { METHOD_LABEL } from "../lib/labels";
import { CopyField } from "../parts/copy-field";
import { MethodMark } from "../parts/provider-marks";
import styles from "./embed.module.css";

type FrameTheme = "none" | "dark" | "auto";
type PreviewTheme = "light" | "dark" | "auto";
type ButtonSet = "methods" | "intents";
type Intent = "signin" | "signup";

const SCOPES = [
  { value: "openid", label: "openid (an id_token)" },
  { value: "email", label: "email" },
  { value: "phone", label: "phone" },
  { value: "dob", label: "dob" },
  { value: "timezone", label: "timezone" },
];

const DIRECT_LABEL: Record<SigninMethod, string> = {
  google: "Continue with Google",
  apple: "Continue with Apple",
  email: "Continue with email",
  phone: "Continue with phone number",
};

const DIRECT_NOTE: Record<SigninMethod, string> = {
  google: "Our Opening page (“Opening Google to sign you in…”, in your style) shows first, then Google.",
  apple: "Our Opening page shows first, then Apple.",
  email: "Our pages open straight on the email field; the Carbon types it there.",
  phone: "Our pages open straight on the phone number field.",
};

interface Sdk {
  renderButtons: (target: Element, options: Record<string, unknown>) => Promise<{ destroy(): void }>;
}

/** One copy of the SDK per saved setup version (each copy reads the app's public setup afresh). */
const sdkCopies = new Map<string, Promise<Sdk>>();
function loadSdk(base: string, version: number): Promise<Sdk> {
  const src = `${base}/sdk/v1.js?v=${version}`;
  let pending = sdkCopies.get(src);
  if (!pending) {
    pending = new Promise<Sdk>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = src;
      script.async = true;
      script.dataset.preview = "developer";
      script.onload = () => {
        const sdk = (window as unknown as { SiliconAccounts?: Sdk }).SiliconAccounts;
        if (sdk) resolve(sdk);
        else reject(new Error("The SDK loaded but did not define window.SiliconAccounts."));
      };
      script.onerror = () => reject(new Error(`The SDK could not be loaded from ${base}/sdk/v1.js; check that the accounts site is up and serves it.`));
      document.head.append(script);
    });
    pending.catch(() => sdkCopies.delete(src));
    sdkCopies.set(src, pending);
  }
  return pending;
}

function randomState(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

/** The app's buttons as the SDK renders them (in a Shadow DOM), on a stand-in page of the app. Clicks stay here. */
function ButtonsPreview({ base, appId, redirectUri, theme, method, buttons, intent, version }: { base: string; appId: string; redirectUri: string; theme: PreviewTheme; method: string; buttons: ButtonSet; intent: Intent; version: number }) {
  const host = useRef<HTMLDivElement>(null);
  const { theme: siteTheme } = useTheme();
  const key = `${base} ${appId} ${redirectUri} ${theme} ${method} ${buttons} ${intent} ${version}`;
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  useEffect(() => {
    const container = host.current;
    if (!container) return;
    // Each render gets its own element: an earlier render that finishes late can only clear its own buttons.
    const target = document.createElement("div");
    container.append(target);
    let cancelled = false;
    let rendered: { destroy(): void } | undefined;
    loadSdk(base, version)
      .then(sdk => sdk.renderButtons(target, { appId, redirectUri, theme, buttons, ...(intent === "signup" ? { intent } : {}), ...(method && buttons === "methods" ? { method } : {}) }))
      .then(result => {
        if (cancelled) result.destroy();
        else rendered = result;
      })
      .catch(raw => {
        if (!cancelled) setFailure({ key, message: raw instanceof Error ? raw.message : String(raw) });
      });
    return () => {
      cancelled = true;
      rendered?.destroy();
      target.remove();
    };
  }, [base, appId, redirectUri, theme, method, buttons, intent, version, key]);
  return (
    <div
      data-sq="surface"
      className={styles.previewWrap}
      // The preview never leaves the page: capturing here stops the click before the SDK's own handler.
      onClickCapture={event => {
        if ((event.target as Element).closest("[data-preview-host]")) {
          event.stopPropagation();
          event.preventDefault();
        }
      }}
    >
      <div data-sq="surface" className={styles.hostPage} data-theme={theme === "auto" ? siteTheme : theme}>
        <span className={styles.hostBar} aria-hidden="true"><i /><i /><i /><span>{appId}.example</span></span>
        <div className={styles.hostBody}>
          <p className={styles.hostTitle}>{intent === "signup" ? "Create your account" : "Sign in to continue"}</p>
          <div ref={host} className={styles.sdkHost} data-preview-host="" />
        </div>
      </div>
      {failure && failure.key === key ? <p className={styles.previewError} role="alert">{failure.message}</p> : null}
    </div>
  );
}

export function EmbedTab() {
  const ctx = useDeveloperApp();
  const view = useEditor(ctx.editor);
  const { appId } = ctx;
  const config = view.base;
  const base = ctx.publicUrl;
  const [chosenRedirect, setRedirect] = useState<string | null>(null);
  const [scopes, setScopes] = useState<string[]>([]);
  const [pkce, setPkce] = useState(true);
  const [method, setMethod] = useState("any");
  const [buttons, setButtons] = useState<ButtonSet>("methods");
  const [intent, setIntent] = useState<Intent>("signin");
  const [frameTheme, setFrameTheme] = useState<FrameTheme>("none");
  const [previewTheme, setPreviewTheme] = useState<PreviewTheme>("auto");
  const [way, setWay] = useState("hosted");
  const [serverStep, setServerStep] = useState("exchange");
  const [tryState] = useState(randomState);
  const discovery = useQuery({ queryKey: ["oidc-discovery"], queryFn: () => api.meta.oidcDiscovery(), staleTime: Infinity });

  // A registered redirect URI that was removed since it was picked falls back to the first one.
  const redirect = chosenRedirect && config.redirect_uris.includes(chosenRedirect) ? chosenRedirect : config.redirect_uris[0] ?? "";
  const methods = useMemo<SigninMethod[]>(() => config.method_order.filter(item => config.methods[item]), [config]);
  const chosenMethod = buttons === "methods" && method !== "any" && methods.includes(method as SigninMethod) ? method : "any";
  const redirectUri = redirect || "https://your-app.example/auth/callback";
  const scope = scopes.join(" ");
  const params = (state: string, extra: Record<string, string> = {}) => new URLSearchParams({
    app_id: appId,
    redirect_uri: redirectUri,
    state,
    ...(scope ? { scope } : {}),
    ...(intent === "signup" ? { intent } : {}),
    ...(chosenMethod !== "any" ? { method: chosenMethod } : {}),
    ...extra,
  }).toString();
  const pkceParams: Record<string, string> = pkce ? { code_challenge: "CHALLENGE", code_challenge_method: "S256" } : {};
  const hostedUrl = `${base}/authorize?${params("STATE", pkceParams)}`;
  const frameParams: Record<string, string> = { ...(frameTheme !== "none" ? { theme: frameTheme } : {}), ...(buttons === "intents" ? { buttons } : {}) };
  const iframeSrc = `${base}/embed/v1/buttons?${params("STATE", { ...frameParams, ...pkceParams })}`;
  const tryUrl = `${base}/authorize?${params(tryState)}`;
  const linkFor = (extra: Record<string, string>) => {
    const query = new URLSearchParams({ app_id: appId, redirect_uri: redirectUri, state: "STATE", ...(pkce ? pkceParams : {}), ...extra });
    return `${base}/authorize?${query.toString()}`;
  };

  const hostedSnippet = `<a href="${hostedUrl.replace(/&/g, "&amp;")}">\n  ${intent === "signup" ? "Sign up" : "Sign in"} with Silicon Accounts\n</a>`;
  const directSnippet = [
    ...methods.map(item => `<a href="${linkFor({ method: item }).replace(/&/g, "&amp;")}">${DIRECT_LABEL[item]}</a>`),
    "",
    "<!-- Or just two buttons, and our pages show every method: -->",
    `<a href="${linkFor({}).replace(/&/g, "&amp;")}">Sign in</a>`,
    `<a href="${linkFor({ intent: "signup" }).replace(/&/g, "&amp;")}">Sign up</a>`,
  ].join("\n");
  const pkceSnippet = `// Before sending the browser: a fresh state and PKCE pair per sign-in, kept for the callback.
const b64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
const state = b64(crypto.getRandomValues(new Uint8Array(16)));
const verifier = b64(crypto.getRandomValues(new Uint8Array(32)));
const challenge = b64(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
sessionStorage.setItem("signin", JSON.stringify({ state, verifier }));
location.assign(\`${base}/authorize?app_id=${appId}&redirect_uri=\${encodeURIComponent("${redirectUri}")}&state=\${state}&code_challenge=\${challenge}&code_challenge_method=S256${intent === "signup" ? "&intent=signup" : ""}\`);`;
  const iframeSnippet = `<iframe
  title="Sign in to ${ctx.app.name}"
  src="${iframeSrc.replace(/&/g, "&amp;")}"
  style="width: 100%; height: 200px; border: 0"
></iframe>
<script>
  // The buttons report their height so the frame never scrolls.
  addEventListener("message", event => {
    if (event.origin !== "${base}" || event.data?.type !== "silicon-accounts:resize") return;
    document.querySelector('iframe[title="Sign in to ${ctx.app.name}"]').style.height = event.data.height + "px";
  });
</script>`;
  const sdkSnippet = `<div id="silicon-accounts"></div>
<script
  src="${base}/sdk/v1.js"
  data-app-id="${appId}"
  data-redirect-uri="${redirectUri}"
  data-target="#silicon-accounts"${buttons === "intents" ? `\n  data-buttons="intents"` : ""}${intent === "signup" ? `\n  data-intent="signup"` : ""}${pkce ? `\n  data-pkce="S256"` : ""}${scope ? `\n  data-scope="${scope}"` : ""}${chosenMethod !== "any" ? `\n  data-method="${chosenMethod}"` : ""}
  async
></script>`;
  const sdkApiSnippet = `// Your own buttons, once the script has loaded:
document.querySelector("#sign-in").onclick = () =>
  SiliconAccounts.signIn({ appId: "${appId}", redirectUri: "${redirectUri}"${pkce ? `, pkce: "S256"` : ""} });
document.querySelector("#sign-up").onclick = () =>
  SiliconAccounts.signIn({ appId: "${appId}", redirectUri: "${redirectUri}", intent: "signup"${pkce ? `, pkce: "S256"` : ""} });
${methods.includes("google") ? `document.querySelector("#google").onclick = () =>
  SiliconAccounts.signIn({ appId: "${appId}", redirectUri: "${redirectUri}", method: "google"${pkce ? `, pkce: "S256"` : ""} });
` : ""}
// Or let the SDK draw them: one button per method, or just Sign in and Sign up.
SiliconAccounts.renderButtons("#silicon-accounts", { appId: "${appId}", redirectUri: "${redirectUri}", buttons: "intents" });

// The SDK keeps { state, code_verifier, nonce, redirect_uri, app_id } in
// sessionStorage["silicon-accounts:auth:<state>"] for your callback page:
const { code, codeVerifier } = await SiliconAccounts.handleCallback();`;
  const exchangeSnippet = `# Your server, on ${redirectUri}?code=…&state=…
# Check the state first, then exchange the code (valid 2 minutes, once):
curl -u ${appId}:$APP_SECRET \\
  -d grant_type=authorization_code \\
  -d code=sac_… \\
  --data-urlencode redirect_uri=${redirectUri}${pkce ? ` \\\n  -d code_verifier=$VERIFIER` : ""} \\
  ${base}/v1/oauth/token

# → { "access_token": "eyJ…", "expires_in": 1800, "refresh_token": "sar_…",
#     "membership_id": "${appId}:a8K", "account": { "uuid": "a8K", "id": "c:saket", … } }
# Store the account's uuid: ids like c:saket can change, the uuid never does.`;
  const refreshSnippet = `# Access tokens last 30 minutes; refresh tokens 900 days and rotate on every use.
curl -u ${appId}:$APP_SECRET \\
  -d grant_type=refresh_token -d refresh_token=sar_… \\
  ${base}/v1/oauth/token

# Who is this? (the details the account shares with ${appId})
curl -H "Authorization: Bearer $ACCESS_TOKEN" ${base}/v1/userinfo

# Sign the account out of ${appId}
curl -u ${appId}:$APP_SECRET -d token=sar_… ${base}/v1/oauth/revoke`;
  const siliconSnippet = `# Silicons never see a sign-in page. The Silicon gets a short-lived token for ${appId}:
silicon-accounts login --app ${appId} -q          # prints slt_… (valid 2 minutes, once)

# …and ${appId}'s server exchanges it for the Silicon's tokens:
curl -u ${appId}:$APP_SECRET \\
  -d grant_type=urn:silicon:params:oauth:grant-type:slt -d slt=slt_… \\
  ${base}/v1/oauth/token`;

  const code = (filename: string, language: string, source: string, maxLines?: number) => (
    <div className={styles.wrapCode}><CodeBlock filename={filename} language={language} code={source} maxLines={maxLines} /></div>
  );

  return (
    <div className={styles.embed}>
      <Surface className={styles.options}>
        <div className={styles.optionsGrid}>
          {config.redirect_uris.length ? (
            <Select label="Redirect URI" description="Where the browser comes back with the code." value={redirect} onValueChange={setRedirect} options={config.redirect_uris.map(uri => ({ value: uri, label: uri }))} />
          ) : (
            <Alert tone="warning" title="No redirect URI is registered">
              Sign-in sends people back only to a registered redirect URI. The snippets below use a placeholder until you add one.
              <span className={styles.alertActions}><Button size="sm" variant="secondary" onClick={() => ctx.openTab("sign-in")}>Add one in Sign-in</Button></span>
            </Alert>
          )}
          <Select
            label="Buttons"
            description="A button per method, or just Sign in and Sign up (our pages then show every method)."
            value={buttons}
            onValueChange={value => setButtons(value as ButtonSet)}
            options={[{ value: "methods", label: "One per method (Continue with Google…)" }, { value: "intents", label: "Sign in and Sign up" }]}
          />
          <Select
            label="Opens"
            description="Which version of our pages opens: the sign-in or the sign-up one. A first-time Carbon signs up either way."
            value={intent}
            onValueChange={value => setIntent(value as Intent)}
            options={[{ value: "signin", label: "The sign-in page (intent=signin)" }, { value: "signup", label: "The sign-up page (intent=signup)" }]}
          />
          {buttons === "methods" ? (
            <Select
              label="Sign-in method"
              description="Go straight to one method, or let them choose."
              value={chosenMethod}
              onValueChange={setMethod}
              options={[{ value: "any", label: "Let them choose" }, ...methods.map(item => ({ value: item, label: METHOD_LABEL[item] }))]}
            />
          ) : null}
        </div>
        <div className={styles.optionsRow}>
          <div className={styles.scopeField}>
            <span className={styles.fieldLabel}>Extra scopes</span>
            <ChipGroup label="Extra scopes" options={SCOPES} value={scopes} onValueChange={setScopes} multiple />
            <span className={styles.fieldHint}>Profile is always shared. What else is shared follows the app&apos;s required and optional details; openid adds an id_token.</span>
          </div>
          <div className={styles.pkce}>
            <Switch aria-labelledby="embed-pkce" checked={pkce} onCheckedChange={setPkce} />
            <span id="embed-pkce"><strong>PKCE</strong> for browser-only and mobile apps (recommended everywhere)</span>
          </div>
        </div>
      </Surface>

      <Section title="Add sign-in" description="Three ways in; all of them end on your redirect URI with ?code= and your state. Your app never takes a Carbon's email or phone itself: they always type it on our pages.">
        <Tabs value={way} onValueChange={setWay} className={styles.tabsRoot}>
          <TabsList aria-label="Ways to add sign-in">
            <TabsTrigger value="hosted">Hosted link</TabsTrigger>
            <TabsTrigger value="iframe">Iframe</TabsTrigger>
            <TabsTrigger value="sdk">SDK</TabsTrigger>
          </TabsList>
          <TabsContent value="hosted">
            <div className={styles.way}>
              <p className={styles.fieldHint}>Send the browser to the hosted sign-in page. Works on any site, without an allowed origin. Generate a fresh state for every sign-in, keep it, and compare it on your callback.</p>
              {code("Sign-in link", "html", hostedSnippet)}
              {pkce ? code("State and PKCE in the browser", "js", pkceSnippet, 8) : null}
              <div className={styles.inlineActions}>
                {redirect ? (
                  <>
                    <ButtonLink href={tryUrl} external target="_blank" rel="noopener" variant="secondary" size="sm">Open the hosted page<ArrowUpRight size={14} strokeWidth={1.75} aria-hidden="true" /></ButtonLink>
                    <span className={styles.fieldHint}>A real {intent === "signup" ? "sign-up" : "sign-in"} to {ctx.app.name} in a new tab, with a random state.</span>
                  </>
                ) : (
                  <>
                    {/* The placeholder redirect URI is not registered, so Silicon Accounts would refuse the sign-in before it starts. */}
                    <Button variant="secondary" size="sm" disabled aria-describedby="embed-try-hint">Open the hosted page<ArrowUpRight size={14} strokeWidth={1.75} aria-hidden="true" /></Button>
                    <span id="embed-try-hint" className={styles.fieldHint}>Add a redirect URI in Sign-in to try a real sign-in.</span>
                  </>
                )}
              </div>
            </div>
          </TabsContent>
          <TabsContent value="iframe">
            <div className={styles.way}>
              <p className={styles.fieldHint}>The app&apos;s buttons inside your page; a click takes the whole window to the hosted sign-in.</p>
              {!config.allowed_origins.length ? (
                <Alert tone="warning" title="The iframe needs an allowed origin">
                  Browsers only show it on pages whose origin is listed in Allowed origins. With none listed, it shows a configuration error.
                  <span className={styles.alertActions}><Button size="sm" variant="secondary" onClick={() => ctx.openTab("sign-in")}>Add one in Sign-in</Button></span>
                </Alert>
              ) : null}
              <div className={styles.themeField}>
                <span className={styles.fieldLabel}>Your page</span>
                <SegmentedControl label="Your page's colour scheme" value={frameTheme} onValueChange={value => setFrameTheme(value as FrameTheme)} options={[{ value: "none", label: "Light" }, { value: "dark", label: "Dark" }, { value: "auto", label: "Follows the device" }]} />
                <span className={styles.fieldHint}>
                  {frameTheme === "none"
                    ? "No theme parameter: the buttons paint light (or in the theme your branding forces) on a transparent frame."
                    : frameTheme === "dark"
                      ? "theme=dark paints the buttons for a dark page; declare color-scheme: dark on it."
                      : "theme=auto follows the visitor's device; your page must declare color-scheme: light dark, or browsers paint an opaque frame."}
                </span>
              </div>
              {code("Iframe", "html", iframeSnippet)}
            </div>
          </TabsContent>
          <TabsContent value="sdk">
            <div className={styles.way}>
              <p className={styles.fieldHint}>One script renders the buttons in a Shadow DOM, so your styles and theirs never mix. It creates and keeps the state (and PKCE) for you, and picks light or dark from your page. Its buttons work on any site without an allowed origin; only its iframe mode, SiliconAccounts.mountFrame(), needs the page&apos;s origin in Allowed origins, like the iframe.</p>
              {code("SDK", "html", sdkSnippet)}
              {code("SDK from JavaScript: Sign in, Sign up and direct buttons", "js", sdkApiSnippet)}
            </div>
          </TabsContent>
        </Tabs>
      </Section>

      <Section title="Buttons on your own site" description="Put direct buttons where you like; each opens our pages on that method. Or just Sign in and Sign up, and our pages show every method.">
        <ul data-sq="surface" className={styles.direct} role="list">
          {methods.map(item => (
            <li key={item}>
              <span className={styles.directMark} aria-hidden="true"><MethodMark method={item} /></span>
              <span className={styles.directText}>
                <span className={styles.directLabel}>{DIRECT_LABEL[item]}</span>
                <span className={styles.fieldHint}>{DIRECT_NOTE[item]}</span>
              </span>
              <code className={styles.directParam}>{`method=${item}`}</code>
            </li>
          ))}
          <li>
            <span className={styles.directMark} aria-hidden="true">↗</span>
            <span className={styles.directText}>
              <span className={styles.directLabel}>Sign in · Sign up</span>
              <span className={styles.fieldHint}>The sign-in or the sign-up version of our pages, with every method you turned on.</span>
            </span>
            <code className={styles.directParam}>intent=signup</code>
          </li>
        </ul>
        {code("Direct buttons as links", "html", directSnippet)}
      </Section>

      <Section
        title="Live preview"
        description="The buttons the SDK renders, from the saved setup. Clicks do nothing here."
        actions={<SegmentedControl label="Preview page" value={previewTheme} onValueChange={value => setPreviewTheme(value as PreviewTheme)} options={[{ value: "auto", label: "Auto" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} />}
      >
        {view.anyDirty ? (
          <p className={styles.dirtyNote}><TriangleAlert size={14} strokeWidth={1.75} aria-hidden="true" />You have unsaved changes; the preview shows the saved setup (version {view.version}).</p>
        ) : null}
        <ButtonsPreview base={base} appId={appId} redirectUri={redirectUri} theme={previewTheme} method={chosenMethod === "any" ? "" : chosenMethod} buttons={buttons} intent={intent} version={view.version} />
      </Section>

      <Section title="On your server" description="With the app's credentials (app id and secret, HTTP Basic). Store each account's uuid: ids such as c:saket can change, the uuid never does.">
        <Tabs value={serverStep} onValueChange={setServerStep} className={styles.tabsRoot}>
          <TabsList aria-label="Server calls">
            <TabsTrigger value="exchange">Exchange the code</TabsTrigger>
            <TabsTrigger value="refresh">Refresh and sign out</TabsTrigger>
            <TabsTrigger value="silicons">Silicons</TabsTrigger>
          </TabsList>
          <TabsContent value="exchange"><div className={styles.way}>{code("POST /v1/oauth/token", "bash", exchangeSnippet)}</div></TabsContent>
          <TabsContent value="refresh"><div className={styles.way}>{code("Refresh, userinfo and sign-out", "bash", refreshSnippet)}</div></TabsContent>
          <TabsContent value="silicons">
            <div className={styles.way}>
              <p className={styles.fieldHint}>A Silicon signs in with its si:id and STK, never on a page, and hands your app a short-lived token.</p>
              {code("Short-lived token", "bash", siliconSnippet)}
            </div>
          </TabsContent>
        </Tabs>
      </Section>

      <Section title="OpenID Connect" description="Generic OIDC libraries configure themselves from the discovery document. Access and id tokens are EdDSA JWTs signed with the keys at jwks_uri.">
        <div className={styles.urls}>
          <CopyField label="Discovery URL" value={`${base}/.well-known/openid-configuration`} copyLabel="Copy URL" />
          <CopyField label="JWKS" value={discovery.data?.jwks_uri ?? `${base}/.well-known/jwks.json`} copyLabel="Copy URL" />
          <CopyField label="Issuer" value={discovery.data?.issuer ?? base} copyLabel="Copy issuer" />
          <CopyField label="Client id" value={appId} copyLabel="Copy id" description="The client secret is the app's secret (from Silicon Apps)." />
        </div>
        {discovery.data ? (
          <JsonViewer data={discovery.data} rootName="openid-configuration" defaultExpandDepth={1} maxHeight={320} label="OpenID Connect discovery document" />
        ) : discovery.error ? (
          <Alert tone="danger" title="The discovery document could not be loaded">{discovery.error.message} {discovery.error.hint}</Alert>
        ) : null}
      </Section>
    </div>
  );
}
