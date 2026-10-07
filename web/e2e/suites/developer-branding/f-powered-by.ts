/**
 * "Powered by Silicon Accounts" on every page a Carbon sees while signing into an app, for every kind of branding:
 * the Silicon Accounts look (briefcase), acme-notes (split, forced dark, Fraunces), pixel-studio (minimal, sharp,
 * outline), orbit-games (Apple only, compact, gradient) and a deliberately hostile custom branding (dm: the pill's
 * own colours everywhere, invisible borders, an 80-character title, a 200-character subtitle, huge logo). Each is
 * walked to the end by a fresh Carbon at 1440 px and at 390 px, with a screenshot of every step; at every step the
 * line is there once, visible by computed style, with a real box in the viewport, uncovered, outside the app's
 * branded subtree, and links Silicon Accounts to the account site in a new tab; that link's host is the one
 * UNDERSTANDING.md names (https://accounts.teamofsilicons.com since its 2026-10-07 edit). The main action reads at
 * 4.5:1 on every step whatever the palette, and an outline button's edge stands out at 3:1.
 */
import type { Journey } from "../../context";
import { json } from "../../lib";
import { appBasic, checkPoweredByHost, fakeApp, readHostedLook, walkHosted, type WalkOptions } from "./_helpers";

/** dm's hostile branding: everything the pill could blend into, and copy long enough to push it far down. */
const HOSTILE = {
  branding: {
    theme: "light",
    logo_height: 96,
    show_app_name: true,
    font_family: "Instrument Serif",
    heading_font_family: "JetBrains Mono",
    corner_style: "rounded",
    radius: 40,
    button_style: "outline",
    layout: "split",
    background_style: "grain",
    density: "compact",
    light: { primary: "#FFFDF9", primary_foreground: "#1A1A1A", background: "#FFFDF9", surface: "#FFFDF9", foreground: "#000000", muted: "#5E5A55", border: "#FFFDF9", danger: "#B42318" },
    dark: { primary: "#2A2927", primary_foreground: "#FFFDF9", background: "#2A2927", surface: "#2A2927", foreground: "#FFFDF9", muted: "#C9C4BC", border: "#2A2927", danger: "#FF8A80" },
  },
  copy: {
    title: "An eighty character title that keeps going and going to push everything around!",
    subtitle: "A subtitle of two hundred characters, written to make the card as tall as it can get on a phone, so the line that names Silicon Accounts has to hold its own at the very end of a long page.......",
  },
};

interface Walk {
  app: string;
  name: string;
  via: WalkOptions["via"];
  width: number;
  height: number;
  dark?: boolean;
  /** The theme every step must paint (the app's forced theme, or the visitor's). */
  theme: "light" | "dark";
  layout: string;
}

const WALKS: Walk[] = [
  { app: "briefcase", name: "default", via: "email", width: 1440, height: 900, theme: "light", layout: "card" },
  { app: "briefcase", name: "default", via: "phone", width: 390, height: 844, dark: true, theme: "dark", layout: "card" },
  { app: "acme-notes", name: "acme-notes", via: "email", width: 1440, height: 900, theme: "dark", layout: "split" },
  { app: "acme-notes", name: "acme-notes", via: "email", width: 390, height: 844, theme: "dark", layout: "split" },
  { app: "pixel-studio", name: "pixel-studio", via: "email", width: 1440, height: 900, theme: "light", layout: "minimal" },
  { app: "pixel-studio", name: "pixel-studio", via: "email", width: 390, height: 844, dark: true, theme: "light", layout: "minimal" },
  { app: "orbit-games", name: "orbit-games", via: "apple", width: 1440, height: 900, theme: "dark", layout: "card" },
  { app: "orbit-games", name: "orbit-games", via: "apple", width: 390, height: 844, theme: "dark", layout: "card" },
  { app: "dm", name: "hostile", via: "email", width: 1440, height: 900, dark: true, theme: "light", layout: "split" },
  { app: "dm", name: "hostile", via: "phone", width: 390, height: 844, theme: "light", layout: "split" },
];

export const journey: Journey = {
  name: "developer-branding-powered-by",
  title: "\"Powered by Silicon Accounts\" on every hosted step (methods, codes, sign-up, requirements, consent, complete) for default, acme-notes, pixel-studio, orbit-games and a hostile branding, at 1440 and 390 px, with screenshots",
  timeoutMs: 9 * 60_000,
  async run(ctx) {
    const { env, results } = ctx;

    // The hostile branding goes on dm with dm's own credentials (an app may manage its own setup).
    const hostile = await json<{ config_version?: number; error?: unknown }>(`${env.site}/v1/apps/dm/signin-config`, {
      method: "PATCH",
      headers: { authorization: appBasic("dm"), "content-type": "application/json", "x-forwarded-for": ctx.ip },
      body: JSON.stringify(HOSTILE),
    });
    results.check("dm's own credentials store the hostile branding (it passes the contrast rules)", hostile.status === 200, `${hostile.status} ${JSON.stringify(hostile.body).slice(0, 200)}`);

    const hrefs: Array<string | null> = [];
    try {
      for (const walk of WALKS) {
        const label = `dvb-f-${walk.name}-${walk.width}-${walk.via}`;
        const themes = new Set<string>();
        const layouts = new Set<string>();
        const result = await walkHosted(ctx, {
          app: walk.app,
          label,
          via: walk.via,
          width: walk.width,
          height: walk.height,
          dark: walk.dark,
          atStep: async (_step, page) => {
            const look = await readHostedLook(page).catch(() => null);
            themes.add(look?.attrs["data-theme"] ?? "none");
            layouts.add(look?.attrs["data-layout"] ?? "none");
          },
        }).catch(error => ({ steps: [] as string[], account: null, ms: 0, readability: [], hrefs: [] as Array<string | null>, error: error instanceof Error ? error.message.split("\n")[0] : String(error) }));
        const failed = "error" in result ? (result as { error: string }).error : "";
        hrefs.push(...result.hrefs);
        const expected = walk.via === "apple" ? ["methods", "signup", "consent", "complete"] : [walk.via === "email" ? "email-code" : "phone-code"];
        results.check(`${walk.name} at ${walk.width} px (${walk.via}): the walk reached the app through every step`, !failed && typeof result.account?.uuid === "string" && expected.every(step => result.steps.includes(step)) && result.steps.includes("complete"), failed || result.steps.join(" → "));
        results.check(`${walk.name} at ${walk.width} px: every step painted the app's look (${walk.theme}, ${walk.layout})`, themes.size === 1 && themes.has(walk.theme) && layouts.size === 1 && layouts.has(walk.layout), `themes ${[...themes].join(",")} layouts ${[...layouts].join(",")}`);
        const worst = [...result.readability].sort((a, b) => a.ratio - b.ratio)[0];
        results.check(`${walk.name} at ${walk.width} px: the main action reads at 4.5:1 or better on every step`, !!worst && worst.ratio >= 4.5, worst ? `lowest ${worst.ratio.toFixed(2)}:1 on ${worst.step} ("${worst.label}": ${worst.text} on ${worst.background}); ${result.readability.map(entry => `${entry.step} ${entry.ratio.toFixed(2)}`).join(", ")}` : "no main action seen");
        if (worst) results.metric(`${walk.name} ${walk.width}px: lowest main-action contrast`, worst.ratio, ":1");
        // An outline button has no fill: its edge is what shows where it is (WCAG 1.4.11, 3:1 against the ground).
        const edges = result.readability.flatMap(entry => (entry.edge ? [{ step: entry.step, background: entry.background, ...entry.edge }] : []));
        if (edges.length) {
          const faintest = [...edges].sort((a, b) => a.ratio - b.ratio)[0]!;
          results.check(`${walk.name} at ${walk.width} px: the outline main action's edge stands out from what is behind it at 3:1 or better on every step (WCAG 1.4.11)`, faintest.ratio >= 3, `lowest ${faintest.ratio.toFixed(2)}:1 on ${faintest.step} (${faintest.color} on ${faintest.background}); ${edges.map(edge => `${edge.step} ${edge.ratio.toFixed(2)}`).join(", ")}`);
          results.metric(`${walk.name} ${walk.width}px: lowest outline-edge contrast`, faintest.ratio, ":1");
        }
        if (walk.app === "dm" && walk.via === "email") results.check("the hostile walk went through dm's requirements (a phone with its own code)", result.steps.includes("requirements") && result.steps.includes("requirements-code"), result.steps.join(" → "));
        results.metric(`${walk.name} ${walk.width}px ${walk.via}: walk to the app`, result.ms);
      }
      checkPoweredByHost(ctx, "the hosted pages (every step of the 10 walks)", hrefs);
    } finally {
      // dm's seeded look and texts again.
      const seeded = fakeApp("dm").signin_defaults ?? {};
      await json(`${env.site}/v1/apps/dm/signin-config`, { method: "PATCH", headers: { authorization: appBasic("dm"), "content-type": "application/json" }, body: JSON.stringify({ branding: null, copy: null }) });
      const restored = await json(`${env.site}/v1/apps/dm/signin-config`, { method: "PATCH", headers: { authorization: appBasic("dm"), "content-type": "application/json" }, body: JSON.stringify({ branding: seeded.branding, copy: seeded.copy }) });
      results.check("dm's seeded branding and texts are back", restored.status === 200, String(restored.status));
    }
  },
};
