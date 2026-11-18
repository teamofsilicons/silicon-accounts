import { expect } from "@playwright/test";
import type { ScreenSpec, MockRoute } from "../../scripts/screens-types";
import { carbon, carbonSummary, portrait } from "../../scripts/mock/fixtures";
import { FIRST_PARTY, sampleFlow } from "../auth/mocks/flows";
const org = { org_id: "studio", name: "The Design Studio", logo_url: null };
const choices = [
  { ...carbonSummary, org: null, is_main: true, allowed: true, reason: null },
  {
    ...carbonSummary,
    uuid: "wrk",
    id: "c:alex.studio",
    display_name: "Alex Rivera",
    pfp_url: portrait("Alex Rivera", 158),
    org: { ...org, logo_url: "/icon-192.png" },
    is_main: false,
    allowed: true,
    reason: null,
  },
  {
    ...carbonSummary,
    uuid: "blocked",
    id: "c:alex.research",
    display_name: "Alex Rivera",
    pfp_url: "",
    org: { ...org, org_id: "research", name: "Research Collective" },
    is_main: false,
    allowed: false,
    reason: "Research Collective does not allow this app.",
  },
];
const studioColleague = {
  ...choices[1], uuid: "morgan-work", id: "c:morgan.studio", display_name: "Morgan Lee", pfp_url: portrait("Morgan Lee", 274),
};
const linked: MockRoute[] = [
  ["GET /v1/session/accounts", () => ({ json: { accounts: [choices[0], choices[1], studioColleague, choices[2]] } })],
  ["GET /v1/me/linked-accounts/requests", () => ({ json: { items: [] } })],
  [
    "GET /v1/me/linked-accounts",
    () => ({ json: { main_uuid: carbon.uuid, accounts: choices } }),
  ],
];
const specs: ScreenSpec[] = [
  {
    name: "account-profile-menu", path: "/", waitFor: "[data-home]",
    element: '[role="menu"]:has([role="group"][aria-label="Signed-in accounts"]), [role="dialog"]:has(nav[aria-label="Signed-in accounts"])',
    routes: [["GET /v1/session/accounts", () => ({ json: { accounts: [
      choices[0], choices[1],
      { ...carbonSummary, display_name: "Morgan Lee", id: "c:morgan", uuid: "second", pfp_url: "", org: null },
      { ...carbonSummary, display_name: "Morgan Lee", id: "c:morgan.studio", uuid: "second-work", pfp_url: "", org },
    ] } })]],
    prepare: async page => {
      const trigger = page.getByRole("button", { name: /^Account menu/ });
      await trigger.click();
      const phone = (page.viewportSize()?.width ?? 1440) < 640;
      const panel = phone ? page.getByRole("dialog", { name: "Switch accounts" }) : page.getByRole("menu", { name: /^Account menu/ });
      const profiles = phone ? panel.getByRole("navigation", { name: "Signed-in accounts" }).getByRole("button") : panel.getByRole("menuitemradio");
      await expect(profiles).toHaveCount(4);
      await expect(profiles.first()).toHaveAttribute(phone ? "aria-current" : "aria-checked", phone ? "page" : "true");
      await expect(profiles.nth(1)).toContainText("c:alex.studio");
      await expect(profiles.last()).toContainText("c:morgan.studio");
      await expect(panel.getByRole(phone ? "button" : "menuitem", { name: "Add another account" })).toBeVisible();
      await expect(panel.getByRole(phone ? "button" : "menuitem", { name: "Sign out" })).toBeVisible();
      await expect.poll(() => profiles.evaluateAll(nodes => {
        const first = nodes[0];
        const firstNameX = first.querySelector("[title]")!.getBoundingClientRect().left;
        const height = first.getBoundingClientRect().height;
        return nodes.every(node => {
          const [name, handle] = [...node.querySelectorAll("[title]")].map(line => line.getBoundingClientRect());
          return height >= 44 && Math.abs(node.getBoundingClientRect().height - height) < 0.5
            && Math.abs(name.left - firstNameX) < 0.5 && Math.abs(handle.left - name.left) < 0.5 && handle.top >= name.bottom;
        });
      })).toBe(true);
      if (!phone) {
        await page.keyboard.press("Home");
        await page.keyboard.press("ArrowDown");
        await expect(profiles.nth(1)).toBeFocused();
      }
      await page.keyboard.press("Escape");
      await expect(trigger).toBeFocused();
      await trigger.click();
      await expect(profiles.first()).toBeVisible();
      await page.waitForTimeout(700); // The screenshot includes the fully opened menu or sheet.
    },
  },
  {
    name: "account-switch-home", path: "/linked-accounts", waitFor: "h1",
    routes: [...linked, ["POST /v1/session/accounts/switch", () => ({ status: 204 })]],
    prepare: async page => {
      await page.getByRole("button", { name: "Switch", exact: true }).first().click();
      await expect(page).toHaveURL(/\/$/);
      await expect(page.locator("[data-home]")).toBeVisible();
    },
  },
  {
    name: "auth-work-existing-invitation",
    path: "/work-invitations/existing",
    as: "signed-out",
    waitFor: "h1",
    routes: [
      [
        "GET /v1/work-invitations/:ticket",
        () => ({
          json: {
            invitation_id: "existing",
            org,
            handle: "alex",
            needs_link: true,
            return_to: "http://localhost:8661/invites/existing",
          },
        }),
      ],
    ],
  },
  {
    name: "auth-work-picker",
    path: "/authorize/flow/work-picker",
    as: "signed-out",
    waitFor: "#accounts-Work",
    routes: [
      [
        "GET /v1/flows/:id",
        () => ({
          json: {
            flow: {
              ...sampleFlow(FIRST_PARTY, "choose_method"),
              id: "work-picker",
              step: "select_account",
              accounts: choices,
            },
          },
        }),
      ],
    ],
  },
  {
    name: "account-work-linked",
    path: "/linked-accounts",
    waitFor: "#accounts-work",
    element: 'section[aria-labelledby="accounts-work"]',
    routes: linked,
    prepare: async page => {
      const work = page.getByRole("region", { name: "Work", exact: true });
      for (const account of [choices[1], studioColleague]) {
        const row = work.getByRole("listitem").filter({ hasText: account.id ?? account.uuid });
        const photo = row.locator(":scope > [role=img] img");
        await expect(photo).toHaveAttribute("src", account.pfp_url);
        const organization = row.getByText(org.name, { exact: true });
        const logo = organization.locator("..").locator("img");
        await expect(logo).toHaveAttribute("src", "/icon-192.png");
        await expect(logo).toHaveAttribute("alt", "");
        for (const image of [photo, logo]) {
          await expect.poll(() => image.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
        }
        const mark = (await logo.boundingBox())!;
        const name = (await organization.boundingBox())!;
        expect(Math.abs(mark.y + mark.height / 2 - name.y - name.height / 2)).toBeLessThan(2);
        expect(name.x - mark.x - mark.width).toBeGreaterThanOrEqual(0);
        expect(name.x - mark.x - mark.width).toBeLessThan(8);
      }
      const research = work.getByRole("listitem").filter({ hasText: "c:alex.research" });
      await expect(research.getByText("Research Collective", { exact: true })).toBeVisible();
      await expect(research.locator("img")).toHaveCount(1);
      await expect(research.locator(":scope > [role=img] img")).toHaveAttribute("src", /^data:image\/svg\+xml/);
    },
  },
  {
    name: "account-work-link-recovery",
    path: "/linked-accounts",
    waitFor: "h1",
    routes: linked,
    prepare: async (page) => {
      await page.evaluate(() =>
        sessionStorage.setItem(
          "silicon-accounts:pending-link",
          "visual-pending-link",
        ),
      );
      await page.reload();
      await page
        .getByRole("button", { name: "Finish linking", exact: true })
        .waitFor();
    },
  },
  {
    name: "account-work-link-request",
    path: "/linked-accounts",
    waitFor: "h1",
    routes: [
      [
        "GET /v1/me/linked-accounts",
        () => ({ json: { main_uuid: carbon.uuid, accounts: choices } }),
      ],
      [
        "GET /v1/me/linked-accounts/requests",
        () => ({
          json: {
            items: [
              {
                id: "request",
                source: {
                  uuid: "work-si",
                  id: "si:research.studio",
                  display_name: "Research Assistant",
                  org,
                },
                target: {
                  uuid: "personal-si",
                  id: "si:research",
                  display_name: "Research Assistant",
                },
                expires_at: "2026-11-17T00:00:00Z",
              },
            ],
          },
        }),
      ],
    ],
  },
  {
    name: "account-work-personal-create",
    path: "/linked-accounts",
    waitFor: "h1",
    routes: [
      ["GET /v1/me/linked-accounts/requests", () => ({ json: { items: [] } })],
      [
        "GET /v1/me",
        () => ({ json: { ...carbon, uuid: "wrk", id: "c:alex.studio", org } }),
      ],
      [
        "GET /v1/me/linked-accounts",
        () => ({
          json: {
            main_uuid: "wrk",
            accounts: [{ ...choices[1], is_main: true }],
          },
        }),
      ],
    ],
  },
  {
    name: "auth-work-invitation",
    path: "/work-invitations/visual",
    as: "signed-out",
    waitFor: "h1",
    routes: [
      [
        "GET /v1/work-invitations/:ticket",
        () => ({
          json: {
            invitation_id: "visual",
            org,
            handle: "alex",
            email: "a***@studio.test",
            needs_link: false,
            return_to: "http://localhost:8661/invites/visual",
          },
        }),
      ],
    ],
  },
];
export const screens: ScreenSpec[] = specs.map((screen) => ({
  ...screen,
  prepare: async (page) => {
    await screen.prepare?.(page);
    await page.evaluate(() => {
      document.documentElement.dataset.theme = window.matchMedia(
        "(prefers-color-scheme: dark)",
      ).matches
        ? "dark"
        : "light";
    });
  },
}));
