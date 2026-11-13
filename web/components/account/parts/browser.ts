/**
 * Which browser a session is (Anil, 2026-11-10), for its logo: read from the session's label ("Chrome on macOS") and
 * its user agent. The logos are the browsers' own, full colour, in public/browsers (github.com/alrra/browser-logos,
 * MIT, its LICENSE.txt beside them). Unknown browsers, terminals and developer sessions get no logo, and their row
 * keeps its icon.
 */
import type { SessionInfo } from "@/lib/api/types";

export type Browser = "edge" | "opera" | "samsung-internet" | "vivaldi" | "brave" | "firefox" | "chrome" | "safari";

const NAMES: Record<Browser, string> = {
  edge: "Edge", opera: "Opera", "samsung-internet": "Samsung Internet", vivaldi: "Vivaldi", brave: "Brave",
  firefox: "Firefox", chrome: "Chrome", safari: "Safari",
};

/** The browser, or null. Order matters: Edge, Opera and the rest also say "Chrome" and "Safari" in their user agent. */
export function browserOf(session: SessionInfo): Browser | null {
  if (session.kind !== "browser") return null;
  const label = session.label ?? "";
  const agent = session.user_agent ?? "";
  for (const browser of Object.keys(NAMES) as Browser[]) {
    if (new RegExp(`\\b${NAMES[browser]}\\b`, "i").test(label)) return browser;
  }
  if (/Edg(e|A|iOS)?\//.test(agent)) return "edge";
  if (/OPR\/|Opera/.test(agent)) return "opera";
  if (/SamsungBrowser\//.test(agent)) return "samsung-internet";
  if (/Vivaldi\//.test(agent)) return "vivaldi";
  if (/Firefox\/|FxiOS\//.test(agent)) return "firefox";
  if (/Chrome\/|CriOS\//.test(agent)) return "chrome";
  if (/Safari\//.test(agent)) return "safari";
  return null;
}

export const browserLogo = (browser: Browser) => `/browsers/${browser}.svg`;
