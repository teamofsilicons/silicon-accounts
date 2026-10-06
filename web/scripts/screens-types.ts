/**
 * Screen specs for scripts/screens.ts. Each area may export `screens: ScreenSpec[]` from
 * `components/<area>/screens.ts` (account, auth, developer); the runner picks them up automatically.
 */
import type { Page } from "@playwright/test";
import type { MockRoute } from "./mock/api";

export type { MockHandler, MockReply, MockRequest, MockRoute } from "./mock/api";

export interface ScreenSpec {
  /** File name stem, unique across areas, for example "account-identity" or "auth-flow-acme-notes-signup". */
  name: string;
  /** Path to open, for example "/" or "/authorize/flow/flow_acme-notes". */
  path: string;
  /** The HTTP status the page answers with (default 200; a not-found screen expects 404). */
  status?: number;
  /** Who is signed in for the mock API (default "carbon"). Ignored with --live. */
  as?: "carbon" | "signed-out";
  /** Extra or overriding mock routes (later entries win). Ignored with --live. */
  routes?: MockRoute[];
  /** Waits for this selector before preparing and shooting. */
  waitFor?: string;
  /** Runs after the page settles and before the screenshot: open a dialog, flip the card, type into a field. */
  prepare?: (page: Page) => Promise<void>;
  /** Capture the whole page (default) or just the viewport. */
  fullPage?: boolean;
  /** Capture only this element (a CSS selector), for close-ups such as the identity card. */
  element?: string;
  /** Limit to some widths or themes (defaults: every width and theme the run asks for). */
  widths?: number[];
  themes?: Array<"light" | "dark">;
  /** Extra milliseconds to wait for animations before the shot (default 700). */
  settle?: number;
  /** Scroll through the page first so in-view animations (counters, reveals) have run (default true). */
  scroll?: boolean;
}
