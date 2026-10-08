---
title: Embed the sign-in buttons in an iframe
description: Show your app’s sign-in buttons inside an iframe. Allow your website’s origin, add the frame and handle the return to your app.
kind: instructive
order: 12
related:
  - start/hosted-pages.md
  - start/sdk.md
  - learn/sign-in-flow.md
  - start/branding.md
---

# Embed the sign-in buttons in an iframe

An iframe lets you put the sign-in buttons on your own page. It shows one button for each method your app has enabled, using your colours and logo, with "Powered by Silicon Accounts" below.

First, add your website’s origin to `allowed_origins`. Then embed `/embed/v1/buttons` with the same parameters as an [authorize request](hosted-pages.md#the-authorize-request). When someone clicks a button, the whole window opens the hosted sign-in pages. After sign-in, the browser returns to your redirect URI. Handle that callback just as you would for the hosted pages.

First allow the origin that will frame the buttons (scheme, host and port, no path), and
register the redirect URI. Lists in a sign-in setup patch replace the whole list, so a patch
of just `["http://localhost:3000"]` would delete every origin and redirect URI you already
have, and sign-in on those sites would stop. Add to what is there instead (with `jq`):

```sh
CONFIG=$(silicon-accounts app config get --json)
echo "$CONFIG" | jq '.signin_config | {
  allowed_origins: (.allowed_origins + ["http://localhost:3000"]),
  redirect_uris: (.redirect_uris + ["http://localhost:3000/callback"])
}' | silicon-accounts app config set - --expected-version "$(echo "$CONFIG" | jq .config_version)"
```

```text
Updated briefcase (allowed_origins, redirect_uris); the sign-in setup is now version 2.
```

Duplicates are dropped, so running it twice changes nothing. `--expected-version` refuses the
patch (`409 config_version_conflict`) if someone changed the setup between your read and your
write, instead of overwriting their change; read and patch again.

Then serve the page. State and PKCE are made on your server for every page view, exactly as
for the hosted pages, so the callback is the same:

```ts
// iframe-app.ts: the sign-in buttons in an iframe, with state + PKCE made on your server.
// Node 24+: ACCOUNTS_APP_ID=briefcase ACCOUNTS_APP_SECRET=sa_app_… node iframe-app.ts, then open http://localhost:3000/
import { createServer, type ServerResponse } from "node:http";
import { createHash, randomBytes } from "node:crypto";

const ACCOUNTS_URL = process.env.ACCOUNTS_URL ?? "https://accounts.teamofsilicons.com";
const APP_ID = process.env.ACCOUNTS_APP_ID ?? "briefcase";
const APP_SECRET = process.env.ACCOUNTS_APP_SECRET ?? "";
const PORT = Number(process.env.PORT ?? 3000);
const ORIGIN = `http://localhost:${PORT}`; // in the app's allowed_origins
const REDIRECT_URI = `${ORIGIN}/callback`; // in the app's redirect_uris

const pending = new Map<string, { verifier: string; startedAt: number }>();
const random = (bytes: number) => randomBytes(bytes).toString("base64url");
const text = (res: ServerResponse, status: number, body: string) =>
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" }).end(body);
const attr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", ORIGIN);

  if (url.pathname === "/") {
    // A new sign-in for every page view: state + PKCE stay here, the cookie binds them to this browser.
    const state = random(32);
    const verifier = random(32);
    pending.set(state, { verifier, startedAt: Date.now() });
    const src = new URL("/embed/v1/buttons", ACCOUNTS_URL);
    src.search = new URLSearchParams({
      app_id: APP_ID,
      redirect_uri: REDIRECT_URI,
      scope: "email",
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      theme: "light", // your page's theme: light, dark or auto
    }).toString();
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Set-Cookie": `signin_state=${state}; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600`,
    });
    return res.end(`<!doctype html><title>Sign in</title>
<iframe id="silicon-accounts" title="Sign in with Silicon Accounts" src="${attr(src.toString())}"
        style="display:block;width:100%;max-width:400px;height:260px;border:0"></iframe>
<script>
  // The frame reports its height; follow it.
  addEventListener("message", (event) => {
    if (event.origin === ${JSON.stringify(new URL(ACCOUNTS_URL).origin)} && event.data?.type === "silicon-accounts:resize")
      document.getElementById("silicon-accounts").style.height = event.data.height + "px";
  });
</script>`);
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
}).listen(PORT, () => console.log(`Open ${ORIGIN}/`));
```

In a browser, the frame shows the app's four methods (each a link with `target="_top"`) and
reports its height, 264 px here. Choosing email took the window to:

```text
https://accounts.teamofsilicons.com/authorize?app_id=briefcase&redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Fcallback&state=-V6HjsnYz78--44vVIH-TCym7jQBur7OcUCSaIcU7Ek&code_challenge=fo6rK7yEC-w7zkC04MxhbnUMyDW0ZPoAbQyKoiMdtTM&code_challenge_method=S256&scope=email&method=email
```

and after the sign-in, the callback answered `Signed in as c:grace-hopper (briefcase:ptO)`.
The app's Embed tab on developers.teamofsilicons.com prints this iframe for your own app id and
redirect URIs, with a live preview.

## Allow your origin

Browsers only show the frame on pages whose origin is in your `allowed_origins`: the embed
page answers with `Content-Security-Policy: frame-ancestors 'self' <your allowed_origins>`.

```sh
curl -sI "https://accounts.teamofsilicons.com/embed/v1/buttons?app_id=briefcase&redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Fcallback" \
  | grep -i -o "frame-ancestors[^;]*"
# frame-ancestors 'self' http://localhost:3000
```

- An origin is `scheme://host[:port]` with no path: `https://app.example.com`, not
  `https://app.example.com/login`. `https` is required except for `localhost`, `127.0.0.1`
  and `[::1]`. Up to 50.
- `http://localhost:3000` and `http://127.0.0.1:3000` are different origins, and ports count.
- With no allowed origins (or an unknown or disabled app), the page answers
  `frame-ancestors 'none'` and `X-Frame-Options: DENY`.
- A change takes up to 30 seconds to reach the embed page.

On an origin that isn't listed, the frame stays empty and the browser's console says why,
for example in Chromium:

```text
Framing 'https://accounts.teamofsilicons.com/' violates the following Content Security Policy directive: "frame-ancestors 'self' http://localhost:3000". The request has been blocked.
```

Why a list at all: a page that can frame the buttons can also dress them up (overlays,
opacity tricks) to trick a click. Only you decide which of your pages may do that. Every
other page of Silicon Accounts refuses to be framed by anyone.

## Parameters of the frame

The iframe's `src` takes the parameters of the [authorize request](hosted-pages.md#the-authorize-request):
`app_id` (or `client_id`) and `redirect_uri` are required; `state`, `code_challenge`,
`code_challenge_method`, `scope`, `nonce`, `prompt`, `intent` and `response_type` are passed on
to `/authorize` unchanged when a button is clicked. `login_hint`, `email` and `phone` are dropped:
your app never hands Silicon Accounts a Carbon's email or phone. These shape the frame itself:

| Parameter | Effect |
|---|---|
| `buttons` | `methods` (default): one button per enabled method, "Continue with Google", "Continue with Apple", "Continue with email", "Continue with phone number", each opening our pages on that method (Google and Apple through the Opening page). `intents`: a "Sign in" and a "Sign up" button that open our pages with every method. |
| `intent` | `signup` opens the sign-up version of our pages ("Create your {app} account"). With `buttons=intents` it keeps only the "Sign up" button; `signin` only "Sign in". |
| `method` | Show only that method's button (`google`, `apple`, `email`, `phone`). Each button adds its own `method=` to `/authorize`. |
| `theme` | Your page's theme: `light`, `dark` or `auto`. It sets the frame's color scheme so its background stays transparent on your page. The buttons paint in `light` or `dark` when you give one; otherwise in your branding's forced theme, else (with `auto`) the device's theme, else light. Not passed to `/authorize`. |

The buttons follow your app's [branding](branding.md) (colours, corner style, button style,
font, density) and its method order. Email (else phone) is the one filled button; Google and
Apple stay neutral, as their own guidelines ask.

## Size the frame

The page inside the frame posts its height to your page whenever it changes:

```js
{ type: "silicon-accounts:resize", height: 264 }
```

Follow it as the example does, checking `event.origin` first. Or load the [SDK](sdk.md) on
your page: it resizes every `/embed/v1/buttons` frame on the page, including frames you wrote
in HTML yourself, and `SiliconAccounts.mountFrame("#target", {...})` builds the iframe for you
(it makes the state, and the PKCE pair with `pkce: "S256"`, and keeps them in `sessionStorage`
for `handleCallback`).

## Why the click leaves your page

The buttons are links with `target="_top"`: the sign-in itself always runs in the whole
window at `accounts.teamofsilicons.com`, never inside the frame. The Carbon sees the real
address before typing a code, the Silicon Accounts session works without third-party
cookies (which browsers block in frames), and Google and Apple, which refuse to be framed,
work the same way. Your page gets the result on the redirect URI, like every other way.

## When the frame shows an error

A frame that can't show buttons says why in place ("These sign-in buttons are not set up
correctly"), logs the same text to the console, and marks it with `data-error-code`:

| `data-error-code` | Message |
|---|---|
| `missing_app_id` | The embed URL has no app_id. |
| `missing_redirect_uri` | The embed URL has no redirect_uri. |
| `unknown_app` | No app with app_id 'nope' exists in Silicon Accounts. |
| `app_disabled` | The app 'briefcase' is disabled, so nobody can sign in to it right now. |
| `method_not_enabled` | DM does not offer sign-in with "google". |
| `no_methods` | Briefcase has no sign-in methods turned on. |
| `network_error` | Silicon Accounts could not be reached (after two quiet retries). |
| `no_allowed_origins` | Shown when the embed page is opened on its own and the app lists no allowed origins: other sites can't frame it yet. |

The frame doesn't check `redirect_uri` against your registered list: that happens when a
button is clicked, and an unregistered one stops at the hosted page with "This sign-in link
is not set up right". Test a click before you ship.
