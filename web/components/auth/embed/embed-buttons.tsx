"use client";

/**
 * The embedded sign-in buttons, served at `/embed/v1/buttons` for apps to put in an iframe:
 *
 *   <iframe src="https://account.teamofsilicons.com/embed/v1/buttons?app_id=briefcase
 *     &redirect_uri=https%3A%2F%2Fbriefcase.example%2Fcallback&state=…&code_challenge=…&code_challenge_method=S256"
 *     title="Sign in with Silicon Accounts" style="border:0;width:100%"></iframe>
 *
 * The page reads the authorize parameters from its own query, loads the app's public sign-in config
 * (GET /v1/apps/{app_id}/public) and renders one button per enabled method in the app's branding. Each button is a
 * plain link with target=_top, so choosing a method takes the whole window to /authorize?…&method=<method>. The page
 * reports its height to the parent as {type: "silicon-accounts:resize", height} so the iframe can fit it exactly
 * (sdk/v1.js resizes every such frame on the page). A broken embed URL or app shows a configuration error inside the
 * frame, in the server's own words, with a data-error-code.
 *
 * proxy.ts sends `frame-ancestors 'self' <the app's allowed_origins>` with this page ('none' when the app lists none),
 * so other sites cannot frame it; opened on its own, the page then says why browsers refuse to show it in an iframe.
 *
 * Theme: `theme` (light | dark | auto) describes the app's page around the frame, and only it sets the frame
 * document's color-scheme: browsers paint an iframe's canvas opaque when its color scheme differs from the embedding
 * page's. Without `theme` the frame declares no scheme and stays transparent. The buttons paint in `theme` light or
 * dark when given, else in the branding's forced theme, else in the device's theme with theme=auto, else light.
 * Everything the frame draws is opaque, the "Powered by" pill included, so it reads on any page.
 *
 * (web-auth area: the web foundation ported this from the SolidJS embed; web-auth polishes it.)
 */
import { useEffect, useMemo, useRef, useSyncExternalStore, type CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AppPublic } from "@/lib/api/types";
import { brandingAttributes, brandingVariables, resolveBrandTheme, type PaintTheme } from "@/lib/branding/apply";
import { normalizeBranding } from "@/lib/branding/defaults";
import { loadBrandingFonts } from "@/lib/branding/fonts";
import { AUTHORIZE_PARAMS, METHOD_LABEL, METHOD_MARK, POWERED_BY_HREF, POWERED_MARK, primaryMethod, visibleMethods, type ButtonMethod } from "@/sdk/methods";
import styles from "./embed.module.css";

export interface EmbedButtonsProps {
  /** The page's query, as the server received it. */
  query: Record<string, string>;
  /** False when proxy.ts answered frame-ancestors 'none' (the app lists no allowed origins). */
  framingAllowed: boolean;
}

const subscribeNothing = () => () => undefined;
function subscribeDeviceTheme(onChange: () => void) {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

interface Problem {
  code: string;
  message: string;
  hint?: string | null;
}

/**
 * Waits between tries of a read the browser cut off. Safari (WebKit) cancels a frame's requests the moment the page
 * around it starts navigating away, while the frame is still alive (no pagehide yet), and networks blip. The cut can
 * come before the answer (the fetch rejects) or after its headers, while the body is still on its way (the status
 * says 200, but reading the body fails). Either way the embed tries twice more before it reports a problem: a page
 * that is really leaving is gone by then, and a real outage still shows after about two seconds.
 */
const NETWORK_RETRY_MS = [500, 1500];

type ConfigBody = (AppPublic & { error?: Partial<Problem> }) | null;
/** One GET of the app's public config: its status and JSON body, or `cut` (with the status, if one came). */
type ConfigRead = { cut: false; ok: boolean; status: number; body: ConfigBody } | { cut: true; status: number | null };

async function readConfig(url: string): Promise<ConfigRead> {
  let response: Response;
  try {
    response = await fetch(url, { headers: { Accept: "application/json" }, credentials: "omit" });
  } catch {
    return { cut: true, status: null };
  }
  try {
    return { cut: false, ok: response.ok, status: response.status, body: (await response.json()) as ConfigBody };
  } catch {
    // The headers came and the body did not: cut off on its way (or not JSON at all, which another try tells).
    return { cut: true, status: response.status };
  }
}

/** GET /v1/apps/{app_id}/public with a plain fetch; errors keep the server's own code, message and hint. */
async function loadApp(id: string): Promise<AppPublic> {
  const url = `/v1/apps/${encodeURIComponent(id)}/public`;
  let read = await readConfig(url);
  for (const wait of NETWORK_RETRY_MS) {
    if (!read.cut) break;
    await new Promise(done => setTimeout(done, wait));
    read = await readConfig(url);
  }
  const hint = "Reload the page. If it keeps happening, check the app's status in Developer.";
  if (read.cut) {
    if (read.status === null) throw { code: "network_error", message: "Silicon Accounts could not be reached.", hint: "Check the connection, then reload the page." } satisfies Problem;
    throw { code: `http_${read.status}`, message: `The sign-in config of "${id}" could not be read (HTTP ${read.status}, the answer was cut off or was not JSON).`, hint } satisfies Problem;
  }
  const { ok, status, body } = read;
  if (ok && body && Array.isArray(body.methods)) return body;
  const error = body?.error;
  throw {
    code: error?.code ?? `http_${status}`,
    message: error?.message ?? `The sign-in config of "${id}" could not be loaded (HTTP ${status}).`,
    hint: error?.hint ?? hint,
  } satisfies Problem;
}

const asProblem = (raw: unknown): Problem =>
  raw && typeof raw === "object" && "code" in raw && "message" in raw
    ? (raw as Problem)
    : { code: "embed_error", message: `The sign-in buttons failed to load: ${raw instanceof Error ? raw.message : String(raw)}`, hint: "Reload the page." };

function Mark({ svg }: { svg: string }) {
  // Trusted, static SVG markup from sdk/methods.ts (never anything from the query or the server).
  return <span className={styles.mark} dangerouslySetInnerHTML={{ __html: svg }} />;
}

function PoweredPill({ tone }: { tone: PaintTheme }) {
  return (
    <p className={styles.powered} data-powered-by="" data-tone={tone}>
      <Mark svg={POWERED_MARK} />
      <span>Powered by <a href={POWERED_BY_HREF} target="_blank" rel="noopener">Silicon Accounts</a></span>
    </p>
  );
}

export function EmbedButtons({ query, framingAllowed }: EmbedButtonsProps) {
  const appId = (query.app_id ?? query.client_id ?? "").trim();
  const redirectUri = (query.redirect_uri ?? "").trim();
  const themeParam = query.theme;
  const onlyMethod = query.method ?? null;
  const rootRef = useRef<HTMLElement>(null);
  // Read after hydration (the server cannot know): framed or opened on its own, and the device's theme.
  const framed = useSyncExternalStore(subscribeNothing, () => window.parent !== window, () => null);
  const deviceDark = useSyncExternalStore(subscribeDeviceTheme, () => window.matchMedia("(prefers-color-scheme: dark)").matches, () => false);

  const app = useQuery({ queryKey: ["embed", "public", appId], queryFn: () => loadApp(appId), enabled: !!appId && !!redirectUri, retry: false, refetchOnWindowFocus: false });

  // The frame document's color-scheme comes from `theme` alone; the device theme matters only for theme=auto.
  useEffect(() => {
    document.documentElement.style.colorScheme = themeParam === "light" || themeParam === "dark" ? themeParam : themeParam === "auto" ? "light dark" : "";
  }, [themeParam]);

  const paint: PaintTheme = themeParam === "light" || themeParam === "dark"
    ? themeParam
    : resolveBrandTheme(app.data?.branding?.theme, themeParam === "auto" && deviceDark ? "dark" : "light");
  const branding = useMemo(() => (app.data ? normalizeBranding(app.data.branding) : null), [app.data]);
  const vars = useMemo(() => (branding ? brandingVariables(branding, paint) : {}), [branding, paint]);
  const attrs = useMemo(() => (branding ? brandingAttributes(branding, paint) : { "data-theme": paint }), [branding, paint]);

  // Ready (and announced to tests) once the branding's fonts are in, so the first visible paint is the final one.
  const fonts = useQuery({ queryKey: ["embed", "fonts", branding?.font_family, branding?.heading_font_family], queryFn: () => loadBrandingFonts(branding!).then(() => true), enabled: !!branding, staleTime: Infinity });
  const fontsReady = fonts.data === true;

  // Height to the parent whenever it changes (the height is not a secret; frame-ancestors limits who embeds it).
  useEffect(() => {
    const root = rootRef.current;
    if (!root || window.parent === window || typeof ResizeObserver === "undefined") return;
    let last = -1;
    const report = () => {
      const height = Math.ceil(root.getBoundingClientRect().height);
      if (height === last) return;
      last = height;
      window.parent.postMessage({ type: "silicon-accounts:resize", height }, "*");
    };
    const observer = new ResizeObserver(report);
    observer.observe(root);
    report();
    return () => observer.disconnect();
  }, []);

  let problem: Problem | null = null;
  if (!appId) problem = { code: "missing_app_id", message: "The embed URL has no app_id.", hint: "Add app_id=<your app id> to the iframe src. Your app's Embed tab in Developer has the exact snippet." };
  else if (!redirectUri) problem = { code: "missing_redirect_uri", message: "The embed URL has no redirect_uri.", hint: "Add redirect_uri=<a callback URL registered for the app>, URL-encoded." };
  else if (app.error) problem = asProblem(app.error);

  const methods: ButtonMethod[] = app.data ? visibleMethods(app.data.methods, onlyMethod) : [];
  if (!problem && app.data && methods.length === 0) {
    problem = onlyMethod
      ? { code: "method_not_enabled", message: `${app.data.name} does not offer sign-in with "${onlyMethod}".`, hint: "Remove method= from the embed URL, or turn that method on in the app's sign-in settings." }
      : { code: "no_methods", message: `${app.data.name} has no sign-in methods turned on.`, hint: "Turn on at least one method in the app's sign-in settings." };
  }
  // Developers integrating the embed read the console too.
  useEffect(() => {
    if (problem) console.error(`Silicon Accounts embed: ${problem.message}${problem.hint ? ` ${problem.hint}` : ""} (${problem.code})`);
  }, [problem?.code]); // eslint-disable-line react-hooks/exhaustive-deps -- once per distinct problem

  const ready = !!problem || (!!app.data && (fontsReady || !branding));
  const authorizeHref = (method: ButtonMethod) => {
    const params = new URLSearchParams();
    for (const key of AUTHORIZE_PARAMS) {
      const value = query[key];
      if (value) params.set(key, value);
    }
    params.set("method", method);
    return `/authorize?${params.toString()}`;
  };
  const primary = primaryMethod(methods);

  return (
    <main
      ref={rootRef}
      id="silicon-accounts-embed"
      {...attrs}
      className={`${styles.embed} ${branding ? "sa-brand" : ""}`}
      style={{ ...(vars as CSSProperties), colorScheme: paint }}
      aria-busy={!ready || undefined}
      data-ready={ready || undefined}
    >
      {problem ? (
        <div data-sq="surface" className={styles.problem} role="alert" data-error-code={problem.code}>
          <strong>These sign-in buttons are not set up correctly</strong>
          <p>{problem.message}</p>
          {problem.hint ? <p className={styles.hint}>{problem.hint}</p> : null}
          <code>{problem.code}</code>
        </div>
      ) : !app.data ? (
        <div data-sq="surface" className={styles.skeleton} aria-hidden="true" />
      ) : (
        <div className={styles.buttons} role="group" aria-label={`Sign in to ${app.data.name}`}>
          {methods.map(method => (
            <a key={method} data-sq="surface" className={styles.button} href={authorizeHref(method)} target="_top" data-method={method} data-variant={method === primary ? "primary" : "secondary"}>
              <Mark svg={METHOD_MARK[method]} />
              <span>{METHOD_LABEL[method]}</span>
            </a>
          ))}
        </div>
      )}
      {!problem && app.data && framed === false && !framingAllowed ? (
        <div data-sq="surface" className={`${styles.problem} ${styles.note}`} role="status" data-error-code="no_allowed_origins">
          <strong>Other sites cannot show these buttons yet</strong>
          <p>{app.data.name} lists no allowed origins, so browsers refuse to show this page inside another site&apos;s iframe.</p>
          <p className={styles.hint}>Add your site&apos;s origin (for example https://app.example.com) to allowed_origins in the app&apos;s sign-in setup in Developer.</p>
          <code>no_allowed_origins</code>
        </div>
      ) : null}
      <PoweredPill tone={paint} />
    </main>
  );
}
