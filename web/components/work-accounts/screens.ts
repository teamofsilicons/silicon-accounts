import type { ScreenSpec, MockRoute } from "../../scripts/screens-types";
import { carbon, carbonSummary } from "../../scripts/mock/fixtures";
import { FIRST_PARTY, sampleFlow } from "../auth/mocks/flows";
const org = { org_id: "studio", name: "The Design Studio", logo_url: null };
const choices = [
  { ...carbonSummary, org: null, is_main: true, allowed: true, reason: null },
  {
    ...carbonSummary,
    uuid: "wrk",
    id: "c:alex.studio",
    org,
    is_main: false,
    allowed: true,
    reason: null,
  },
  {
    ...carbonSummary,
    uuid: "blocked",
    id: "c:alex.research",
    org: { ...org, org_id: "research", name: "Research Collective" },
    is_main: false,
    allowed: false,
    reason: "Research Collective does not allow this app.",
  },
];
const linked: MockRoute[] = [
  ["GET /v1/me/linked-accounts/requests", () => ({ json: { items: [] } })],
  [
    "GET /v1/me/linked-accounts",
    () => ({ json: { main_uuid: carbon.uuid, accounts: choices } }),
  ],
];
const specs: ScreenSpec[] = [
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
    waitFor: "[aria-label='Work accounts']",
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
    waitFor: "h1",
    routes: linked,
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
    await page.evaluate(() => {
      document.documentElement.dataset.theme = window.matchMedia(
        "(prefers-color-scheme: dark)",
      ).matches
        ? "dark"
        : "light";
    });
  },
}));
