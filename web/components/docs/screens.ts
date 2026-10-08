/**
 * Screens of the docs (/docs) for `pnpm screens --only docs`: the landing page, a page of each group, a group page,
 * the parts that need a close look (a callout, a table, code), search with results and the phone menu.
 * Docs pages read no API, so the mock API is never asked; they render the same signed in or out.
 *
 * The docs 404 (/docs/no-such-page) is not here: a notFound() below the root layout renders on the client in this
 * app (see web/README.md, Docs), and in `next dev` React logs a warning about the root layout's theme script while it
 * does, which would fail the run. Check it against a production server instead.
 */
import { expect, type Page } from "@playwright/test";
import type { ScreenSpec } from "@/scripts/screens-types";

/** Scrolls so the element is just below the sticky docs header, for viewport shots of the middle of a page. */
const scrollTo = (selector: string) => async (page: Page) => {
  await page.locator(selector).first().evaluate(element => {
    const top = element.getBoundingClientRect().top + window.scrollY - 88;
    window.scrollTo({ top, behavior: "instant" as ScrollBehavior });
  });
  await page.waitForTimeout(400);
};

export const screens: ScreenSpec[] = [
  { name: "docs-app-verification", path: "/docs/start/app-verification", as: "signed-out", fullPage: false },
  {
    name: "docs-verification-search", path: "/docs", as: "signed-out", fullPage: false,
    prepare: async page => {
      await page.keyboard.press("/");
      await page.getByRole("combobox").fill("App verification");
      await expect(page.getByRole("option").filter({ hasText: "App verification" }).first()).toBeVisible();
      await page.waitForTimeout(700);
    },
  },
  { name: "docs-home", path: "/docs", as: "signed-out", fullPage: false },
  { name: "docs-home-every-page", path: "/docs", as: "signed-out", fullPage: false, prepare: scrollTo("#every-page") },
  { name: "docs-start-page", path: "/docs/start/add-sign-in", as: "signed-out", fullPage: false },
  { name: "docs-start-page-end", path: "/docs/start/add-sign-in", as: "signed-out", fullPage: false, prepare: scrollTo("#related-pages") },
  { name: "docs-learn-page", path: "/docs/learn/proofs", as: "signed-out", fullPage: false },
  { name: "docs-reference-table", path: "/docs/reference/errors", as: "signed-out", fullPage: false, prepare: scrollTo("main h2") },
  { name: "docs-callout", path: "/docs/start/sign-in-config", as: "signed-out", fullPage: false, prepare: scrollTo("aside[data-kind]") },
  { name: "docs-code", path: "/docs/start/hosted-pages", as: "signed-out", fullPage: false, prepare: scrollTo("figure[data-long]") },
  { name: "docs-group", path: "/docs/reference", as: "signed-out", fullPage: false },
  {
    name: "docs-search",
    path: "/docs/start/tokens",
    as: "signed-out",
    fullPage: false,
    prepare: async page => {
      await page.keyboard.press("/");
      await page.waitForSelector("[role='listbox']");
      await page.keyboard.type("refresh token reuse", { delay: 20 });
      await page.waitForTimeout(700);
    },
  },
  {
    name: "docs-menu",
    path: "/docs/learn/webhooks",
    as: "signed-out",
    widths: [390],
    fullPage: false,
    prepare: async page => {
      await page.getByRole("button", { name: "Open the docs menu" }).click();
      await page.waitForTimeout(900);
    },
  },
  {
    name: "docs-toc-open",
    path: "/docs/reference/cli",
    as: "signed-out",
    widths: [390],
    fullPage: false,
    prepare: async page => {
      await page.getByRole("button", { name: /On this page/ }).click();
      await page.waitForTimeout(400);
    },
  },
];
