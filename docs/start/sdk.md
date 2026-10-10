---
title: Drop in the SDK snippet
description: Add one script tag and your sign-in buttons show up on your page. Set up the buttons, then finish the sign-in through your server's callback.
kind: instructive
order: 13
related:
  - start/hosted-pages.md
  - start/iframe.md
  - learn/sign-in-flow.md
  - start/branding.md
---

# Drop in the SDK snippet

Add the SDK with one `<script>` tag and it shows your sign-in buttons on your page, with the methods, colours and logo you set up for your app. Your server still makes the `state` and PKCE challenge, and handles the callback just as it does for the [hosted pages](hosted-pages.md).

Load the script from `https://accounts.teamofsilicons.com/sdk/v1.js`. It's about 20 KB, has no dependencies and is cached for 5 minutes. It allows cross-origin loading with `Access-Control-Allow-Origin: *`.

```ts
// sdk-app.ts: the SDK snippet renders the buttons; state + PKCE are made on your server.
// Node 24+: ACCOUNTS_APP_ID=briefcase ACCOUNTS_APP_SECRET=sa_app_… node sdk-app.ts, then open http://localhost:3000/
import { createServer, type ServerResponse } from "node:http";
import { createHash, randomBytes } from "node:crypto";

const ACCOUNTS_URL = process.env.ACCOUNTS_URL ?? "https://accounts.teamofsilicons.com";
const APP_ID = process.env.ACCOUNTS_APP_ID ?? "briefcase";
const APP_SECRET = process.env.ACCOUNTS_APP_SECRET ?? "";
const PORT = Number(process.env.PORT ?? 3000);
const REDIRECT_URI = `http://localhost:${PORT}/callback`; // in the app's redirect_uris

const pending = new Map<string, { verifier: string; startedAt: number }>();
const random = (bytes: number) => randomBytes(bytes).toString("base64url");
const text = (res: ServerResponse, status: number, body: string) =>
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" }).end(body);
const attr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  if (url.pathname === "/") {
    const state = random(32);
    const verifier = random(32);
    pending.set(state, { verifier, startedAt: Date.now() });
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Set-Cookie": `signin_state=${state}; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600`,
    });
    return res.end(`<!doctype html><title>Sign in</title>
<div id="silicon-accounts" style="max-width:400px"></div>
<script src="${ACCOUNTS_URL}/sdk/v1.js" async
        data-app-id="${attr(APP_ID)}"
        data-redirect-uri="${attr(REDIRECT_URI)}"
        data-target="#silicon-accounts"
        data-scope="email"
        data-state="${attr(state)}"
        data-code-challenge="${attr(challenge)}"
        data-code-challenge-method="S256"></script>`);
  }

  if (url.pathname === "/callback") {
    // Exactly the hosted pages' callback: check the state, exchange the code with the verifier.
    const error = url.searchParams.get("error");
    if (error) return text(res, 400, `Sign-in ended without signing in: ${error}`);
    const state = url.searchParams.get("state") ?? "";
    const cookieState = /(?:^|;\s*)signin_state=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
    const started = pending.get(state);
    pending.delete(state);
    if (!started || cookieState !== state || Date.now() - started.startedAt > 60 * 60_000) {
      return text(res, 400, "This sign-in was not started in this browser (or it expired).");
    }
    const response = await fetch(new URL("/v1/oauth/token", ACCOUNTS_URL), {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${APP_ID}:${APP_SECRET}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: url.searchParams.get("code") ?? "",
        redirect_uri: REDIRECT_URI,
        code_verifier: started.verifier,
      }),
    });
    const tokens = await response.json();
    if (!response.ok) return text(res, 502, `${tokens.error}: ${tokens.error_description}`);
    return text(res, 200, `Signed in as ${tokens.account.id} (${tokens.membership_id})`);
  }

  text(res, 404, "Not found");
}).listen(PORT, () => console.log(`Open http://localhost:${PORT}/`));
```

In a browser, the page shows "Continue with Google", "Continue with Apple", "Continue with
email" and "Continue with phone" (briefcase's methods, in its order) and the "Powered by
Silicon Accounts" line. Choosing email went to:

```text
https://accounts.teamofsilicons.com/authorize?app_id=briefcase&redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Fcallback&response_type=code&state=GQe4rfj-DYDcsc1QSee9P0knbkY4YaF83btELqx-7Lo&code_challenge=9oFWaKZEmIFd4oWb4yVL2fRCaobJFwMKi1wdbMs-A50&code_challenge_method=S256&scope=email&method=email
```

and the callback answered `Signed in as c:grace-hopper (briefcase:d6393ce9-6e58-4e52-b7da-e65c5d47322b)`.

The SDK puts its buttons in a Shadow DOM, so their styles stay separate from your page. It uses a constructed stylesheet, which keeps the button styles working under a strict `style-src`.

The buttons don't need an `allowed_origins` entry: they belong to your page, and clicking one navigates to `/authorize`. An iframe does need an allowed origin, whether you use `mountFrame` or [write the iframe yourself](iframe.md).

If your page sets a Content-Security-Policy, allow the script and its request with `script-src https://accounts.teamofsilicons.com; connect-src https://accounts.teamofsilicons.com`. Add `frame-src https://accounts.teamofsilicons.com` when you use `mountFrame`.

## Script attributes

With `data-app-id` and `data-redirect-uri`, the script renders the buttons by itself. Without
`data-app-id`, it only defines `window.SiliconAccounts`.

| Attribute | Meaning |
|---|---|
| `data-app-id` | Your app id. |
| `data-redirect-uri` | A registered redirect URI. |
| `data-target` | CSS selector of the element to render into; without it the buttons go right after the script tag. A selector that matches nothing logs an error. |
| `data-state` | Your `state`. Without it the SDK makes one and keeps it in `sessionStorage` (see below). |
| `data-code-challenge`, `data-code-challenge-method` | Your PKCE challenge (`S256`, or `plain`). |
| `data-pkce="S256"` | Have the SDK make the PKCE pair itself when you pass no challenge. |
| `data-scope`, `data-nonce`, `data-prompt`, `data-method` | Passed to [`/authorize`](hosted-pages.md#the-authorize-request). `data-method` also shows only that method's button. |
| `data-buttons` | `methods` (default): a button per method your app turned on ("Continue with Google", "Continue with Apple", "Continue with email", "Continue with phone number"), each opening our pages on that method; Google and Apple go through the Opening page first. `intents`: a "Sign in" and a "Sign up" button that open our pages with every method. |
| `data-intent` | `signup` opens the sign-up version of our pages ("Create your {app} account"); with `data-buttons="intents"` it keeps only the "Sign up" button. Default `signin`. | |
| `data-theme` | `light` or `dark` paints the buttons that way. Otherwise your branding's forced theme wins, else the SDK reads the page behind the buttons (the first opaque background, else the page's `color-scheme`) and follows it when your page switches theme. |

Email (else phone) is the one filled button. Google and Apple stay neutral, as their
guidelines ask. Colours, corners, button style, font and density come from your app's
[branding](branding.md).

## Let the SDK make state and PKCE

A static site with no session store can let the browser keep the sign-in. With
`data-pkce="S256"` and no `data-state`, the SDK makes the state, the PKCE pair (and a nonce
when `scope` includes `openid`) and saves them in `sessionStorage` before leaving the page.
Your callback page calls `SiliconAccounts.handleCallback()`, which checks the state against
that saved record and hands back the code and its verifier. Your server only exchanges them,
so the app secret still never reaches the browser. Register the callback page
(`http://localhost:3000/signed-in` here) as a redirect URI.

```ts
// sdk-static.ts: the SDK makes state + PKCE in the browser; your server only exchanges the code.
// Node 24+: ACCOUNTS_APP_ID=briefcase ACCOUNTS_APP_SECRET=sa_app_… node sdk-static.ts, then open http://localhost:3000/
import { createServer } from "node:http";

const ACCOUNTS_URL = process.env.ACCOUNTS_URL ?? "https://accounts.teamofsilicons.com";
const APP_ID = process.env.ACCOUNTS_APP_ID ?? "briefcase";
const APP_SECRET = process.env.ACCOUNTS_APP_SECRET ?? "";
const PORT = Number(process.env.PORT ?? 3000);
const REDIRECT_URI = `http://localhost:${PORT}/signed-in`; // listed in the app's redirect_uris

const pages: Record<string, string> = {
  // The buttons. data-pkce="S256": the SDK creates state + PKCE and keeps them in sessionStorage.
  "/": `<!doctype html><title>Sign in</title>
<div id="silicon-accounts" style="max-width:400px"></div>
<script src="${ACCOUNTS_URL}/sdk/v1.js" async data-app-id="${APP_ID}"
        data-redirect-uri="${REDIRECT_URI}" data-target="#silicon-accounts"
        data-scope="email" data-pkce="S256"></script>`,
  // The callback page: the SDK checks the state, hands back the code and its verifier.
  "/signed-in": `<!doctype html><title>Signing in…</title><pre id="out">Signing in…</pre>
<script src="${ACCOUNTS_URL}/sdk/v1.js"></script>
<script type="module">
  const out = document.getElementById("out");
  try {
    const { code, codeVerifier } = SiliconAccounts.handleCallback();
    const response = await fetch("/exchange", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, codeVerifier }),
    });
    out.textContent = await response.text();
  } catch (error) {
    out.textContent = \`\${error.code}: \${error.message}\`; // access_denied, unknown_state, …
  }
</script>`,
};

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  if (req.method === "POST" && url.pathname === "/exchange") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const { code, codeVerifier } = JSON.parse(body);
    const response = await fetch(new URL("/v1/oauth/token", ACCOUNTS_URL), {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${APP_ID}:${APP_SECRET}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, code_verifier: codeVerifier }),
    });
    const tokens = await response.json();
    if (!response.ok) return res.writeHead(400).end(`${tokens.error}: ${tokens.error_description}`);
    // Start your own session for tokens.account.uuid here (an HttpOnly cookie), keep the tokens server side.
    return res.writeHead(200).end(`Signed in as ${tokens.account.id} (${tokens.membership_id})`);
  }
  const page = pages[url.pathname];
  if (!page) return res.writeHead(404).end();
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(page);
}).listen(PORT, () => console.log(`Open http://localhost:${PORT}/`));
```

After a sign-in, the callback page shows `Signed in as c:sdk2-docs (briefcase:jTb)`.
Reloading it shows:

```text
unknown_state: Silicon Accounts: no sign-in with this state was started in this browser tab, or it was already finished. Start the sign-in again (never reuse a callback address).
```

because `handleCallback` removes the saved record, so a callback works only once. The saved
record is JSON under the key `silicon-accounts:auth:<state>`:

```json
{"state": "…", "code_verifier": "…", "nonce": null, "redirect_uri": "http://localhost:3000/signed-in", "app_id": "briefcase", "created_at": 1791341046000}
```

`sessionStorage` belongs to one tab, so the sign-in must finish in the tab that started it.
That's also what makes a link from someone else fail the state check. Server-made state (the
first example) works across tabs and survives blocked storage, so prefer it when you have a
server session. Keep `/exchange` same-origin: a JSON body can't be sent cross-site without a
CORS preflight, and your server never answers one.

## window.SiliconAccounts

Every option is optional when the script tag already carries it, and options override
attributes. Options use camelCase: `appId`, `redirectUri`, `state`, `codeChallenge`,
`codeChallengeMethod`, `scope`, `nonce`, `prompt`, `intent` (`"signin"` or `"signup"`), `method`,
`buttons` (`"methods"` or `"intents"`, for `renderButtons`), `pkce` (`"S256"` or `true`), `theme`.
There is no email or phone option. `loginHint`, `data-login-hint`, `email` and `phone` are
ignored with one console warning, because your app never hands Silicon Accounts a Carbon's
email or phone; the Carbon types it on our pages.

| Call | Does |
|---|---|
| `authorizeUrl(options)` | Returns the `/authorize` URL; no side effects. Throws when `appId` or `redirectUri` is missing, or `method` isn't google, apple, email or phone. |
| `signIn(options)` | Sends this window to sign in, making the state (and PKCE when `pkce` is set) and saving them as above. Use it for your own buttons: `signIn({method: "google"})` for "Continue with Google", `signIn({intent: "signup"})` for "Sign up". |
| `renderButtons(target, options)` | Renders the buttons into `target` (an element or a selector). Resolves to `{app, destroy()}`, where `app` is your public sign-in config; rejects after drawing the reason in place. |
| `mountFrame(target, options)` | Appends the [iframe](iframe.md) version (`/embed/v1/buttons`), sized to its content. Resolves to `{iframe, destroy()}`. Needs your origin in `allowed_origins`. |
| `handleCallback(url?)` | On your callback page: reads `?code=&state=` (or `?error=`), matches the state to a sign-in this tab started, and returns `{code, state, codeVerifier, nonce, redirectUri, appId}`. |
| `version` | The SDK's version. |

`handleCallback` throws an `Error` with a `code`:

| `code` | Meaning |
|---|---|
| `access_denied`, `login_required`, `consent_required`, `interaction_required`, … | The sign-in came back with this `error` (the message includes `error_description`). |
| `not_a_callback` | The address has no `?code=`. |
| `missing_state` | The callback has no state. |
| `unknown_state` | No sign-in with this state was started in this tab, or it was already finished. |

The script fires `silicon-accounts:ready` on `document` once it has loaded (`event.detail` is
the API), so code that runs before an `async` script finishes can wait for it:

```html
<button id="sign-in">Sign in</button>
<script src="https://accounts.teamofsilicons.com/sdk/v1.js" async></script>
<script>
  document.addEventListener("silicon-accounts:ready", ({ detail: sdk }) => {
    document.getElementById("sign-in").onclick = () =>
      sdk.signIn({ appId: "briefcase", redirectUri: "https://briefcase.example/callback", pkce: "S256", method: "google" });
  });
</script>
```

## When the buttons don't appear

Problems are drawn where the buttons would be ("These sign-in buttons are not set up
correctly") and logged to the console in the same words:

| Shown | Why |
|---|---|
| data-app-id is missing. | No `data-app-id` and no `appId` option. |
| data-redirect-uri is missing. | No `data-redirect-uri` and no `redirectUri` option. |
| No app with app_id 'nope' exists in Silicon Accounts. | The service's own answer for your public config (`GET /v1/apps/{app_id}/public`). A disabled app reads "The app '…' is disabled, so nobody can sign in to it right now." |
| Briefcase has no sign-in methods turned on. / Briefcase does not offer sign-in with "phone". | Turn the method on in your sign-in setup, or drop `data-method`. |
| could not reach https://accounts.teamofsilicons.com | The config fetch failed three times (it retries after 0.5 s and 1.5 s, so a page that is navigating away never reports it). Check `connect-src`. |

Like the iframe, the snippet doesn't check `data-redirect-uri` against your registered list
until a button is clicked, and an unregistered one stops at the hosted page.
