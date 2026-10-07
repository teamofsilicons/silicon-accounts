// HTML for the fake app server. Plain server-rendered pages with stable ids so
// Playwright tests can drive them: #signin-hosted, #signup-hosted (intent=signup),
// #continue-{google|apple|email|phone} (direct method buttons), #signin-iframe,
// #silicon-accounts (SDK mount), #signed-in-as, #account (AccountForApp JSON), #token,
// #id-token, #error.

import { escapeHtml } from '../shared/util.ts';
import { jsonPre, page } from '../shared/page.ts';
import type { SiliconAppsApp } from './types.ts';

export interface SignedInView {
  uuid: string;
  id: string;
  kind: string;
  membership_id: string;
  account: unknown;
  token: Record<string, unknown>;
  id_token: { claims: unknown; verified: boolean | null; error: string | null } | null;
  via: string;
}

function head(app: SiliconAppsApp): string {
  return app.logo_url ? `<link rel="icon" href="${escapeHtml(app.logo_url)}">` : '';
}

function appHeader(app: SiliconAppsApp): string {
  const logo = app.logo_url ? `<img class="logo" src="${escapeHtml(app.logo_url)}" alt="">` : '';
  return `<header class="row app-header">${logo}<div><h1><a href="/${escapeHtml(app.app_id)}/" style="color:inherit;text-decoration:none">${escapeHtml(app.name)}</a></h1><p class="muted">${escapeHtml(app.description)}</p></div></header>`;
}

const FOOTER = (app: SiliconAppsApp): string =>
  `<footer class="muted" style="margin-top:32px;font-size:13px">Fake app <code>${escapeHtml(app.app_id)}</code> served by the Silicon Accounts testkit · <a href="/${escapeHtml(app.app_id)}/_state">state</a> · <a href="/${escapeHtml(app.app_id)}/_events">webhook events</a> · <a href="/">all fake apps</a></footer>`;

export function indexPage(apps: SiliconAppsApp[], accountsPublicUrl: string): string {
  const cards = apps
    .map(
      (app) => `<li class="card row" data-app-id="${escapeHtml(app.app_id)}">
${app.logo_url ? `<img class="logo" src="${escapeHtml(app.logo_url)}" alt="">` : ''}
<div style="flex:1;min-width:220px"><h2 style="margin:0"><a href="/${escapeHtml(app.app_id)}/">${escapeHtml(app.name)}</a> <span class="badge">${escapeHtml(app.app_id)}</span></h2>
<p class="muted" style="margin:4px 0 0">${escapeHtml(app.testkit?.purpose ?? app.description)}</p></div></li>`,
    )
    .join('\n');
  return page({
    title: 'Fake apps · Silicon Accounts testkit',
    css: 'ul.apps { list-style: none; padding: 0; margin: 0; } ul.apps li { margin: 12px 0; }',
    body: `<main id="fake-apps">
<h1>Fake apps</h1>
<p class="muted">Stand-ins for apps made in Silicon Apps. Each one signs Carbons and Silicons in through Silicon Accounts at <code>${escapeHtml(accountsPublicUrl)}</code>.</p>
<ul class="apps">
${cards}
</ul>
</main>`,
  });
}

/** The app's own button labels (UNDERSTANDING.md "Adding sign-in to an app"). */
const METHOD_LABELS: Record<string, string> = {
  google: 'Continue with Google',
  apple: 'Continue with Apple',
  email: 'Continue with email',
  phone: 'Continue with phone number',
};

export interface AppPageOptions {
  app: SiliconAppsApp;
  accountsPublicUrl: string;
  signedIn: SignedInView | null;
  hosted: {
    url: string;
    state: string;
    /** The app's own "Create an account" button (intent=signup). */
    signup?: { url: string; state: string };
    /** Direct "Continue with …" buttons (method=…), in the app's method order. */
    direct?: Array<{ method: string; url: string; state: string }>;
  } | null;
  iframe: { url: string; state: string } | null;
  sdk: { attributes: Record<string, string>; state: string } | null;
  redirectUri: string;
}

export function appPage(options: AppPageOptions): string {
  const { app } = options;
  const accountsOrigin = new URL(options.accountsPublicUrl).origin;
  const primary = app.testkit?.integration ?? 'hosted';
  const badge = (kind: string): string => (kind === primary ? ' <span class="badge">this app’s main integration</span>' : '');

  const session = options.signedIn
    ? `<section class="card" id="session" data-uuid="${escapeHtml(options.signedIn.uuid)}">
<p id="signed-in-as">Signed in as <strong>${escapeHtml(options.signedIn.id)}</strong> <span class="badge">${escapeHtml(options.signedIn.kind)}</span> <code>${escapeHtml(options.signedIn.membership_id)}</code></p>
<div class="row"><a class="button secondary" href="/${escapeHtml(app.app_id)}/signed-in">Details</a>
<form method="post" action="/${escapeHtml(app.app_id)}/logout"><button type="submit" class="ghost" id="sign-out">Sign out</button></form></div>
</section>`
    : '';

  const hosted = options.hosted
    ? `<section class="card" id="integration-hosted">
<h2>1. Hosted sign-in page${badge('hosted')}</h2>
<p class="muted">The app sends the browser to Silicon Accounts and gets it back on <code>${escapeHtml(options.redirectUri)}</code> with a code it exchanges server-side (state + PKCE).</p>
<div class="row">
<a id="signin-hosted" class="button" href="${escapeHtml(options.hosted.url)}" data-state="${escapeHtml(options.hosted.state)}">Sign in with Silicon Accounts</a>
${options.hosted.signup ? `<a id="signup-hosted" class="button secondary" href="${escapeHtml(options.hosted.signup.url)}" data-state="${escapeHtml(options.hosted.signup.state)}">Create an account</a>` : ''}
</div>
${
  options.hosted.direct?.length
    ? `<p class="muted">Or the app's own direct buttons (the hosted page opens on that method; Google and Apple show the opening page first):</p>
<div class="row" id="direct-buttons">${options.hosted.direct
        .map((d) => `<a id="continue-${escapeHtml(d.method)}" class="button secondary" href="${escapeHtml(d.url)}" data-state="${escapeHtml(d.state)}" data-method="${escapeHtml(d.method)}">${escapeHtml(METHOD_LABELS[d.method] ?? d.method)}</a>`)
        .join('\n')}</div>`
    : ''
}
</section>`
    : '';

  const iframe = options.iframe
    ? `<section class="card" id="integration-iframe">
<h2>2. Embedded buttons (iframe)${badge('iframe')}</h2>
<p class="muted">The app drops in the Silicon Accounts iframe; choosing a method takes the whole window to the hosted flow.</p>
<iframe id="signin-iframe" title="Sign in with Silicon Accounts" src="${escapeHtml(options.iframe.url)}" data-state="${escapeHtml(options.iframe.state)}" style="width:100%;min-height:96px;border:0;display:block" loading="eager"></iframe>
<script>
window.addEventListener('message', function (event) {
  if (event.origin !== ${JSON.stringify(accountsOrigin)}) return;
  var data = event.data;
  if (data && data.type === 'silicon-accounts:resize' && typeof data.height === 'number') {
    document.getElementById('signin-iframe').style.height = Math.max(48, Math.ceil(data.height)) + 'px';
  }
});
</script>
</section>`
    : '';

  const sdk = options.sdk
    ? `<section class="card" id="integration-sdk">
<h2>3. SDK snippet${badge('sdk')}</h2>
<p class="muted">The app adds one script tag; the SDK renders the buttons this app has configured.</p>
<div id="silicon-accounts" data-state="${escapeHtml(options.sdk.state)}"></div>
<script src="${escapeHtml(`${options.accountsPublicUrl}/sdk/v1.js`)}" ${Object.entries(options.sdk.attributes)
        .map(([k, v]) => `${escapeHtml(k)}="${escapeHtml(v)}"`)
        .join(' ')} async></script>
</section>`
    : '';

  return page({
    title: `${app.name} · fake app`,
    accent: app.testkit?.accent,
    head: head(app),
    body: `<main id="fake-app" data-app-id="${escapeHtml(app.app_id)}">
${appHeader(app)}
${session}
${hosted}
${iframe}
${sdk}
${FOOTER(app)}
</main>`,
  });
}

export function signedInPage(app: SiliconAppsApp, view: SignedInView): string {
  const idToken = view.id_token
    ? `<h2 style="margin-top:20px">ID token</h2>
<p id="id-token-status" data-verified="${String(view.id_token.verified)}">${view.id_token.verified ? 'Signature, issuer, audience and nonce verified against the Silicon Accounts JWKS.' : `Not verified: ${escapeHtml(view.id_token.error ?? 'unknown reason')}`}</p>
${jsonPre('id-token', view.id_token.claims)}`
    : '';
  return page({
    title: `${app.name} · signed in`,
    accent: app.testkit?.accent,
    head: head(app),
    body: `<main id="fake-app-signed-in" data-app-id="${escapeHtml(app.app_id)}" data-uuid="${escapeHtml(view.uuid)}">
${appHeader(app)}
<section class="card">
<p id="signed-in-as">Signed in as <strong>${escapeHtml(view.id)}</strong> <span class="badge">${escapeHtml(view.kind)}</span> <span class="badge">via ${escapeHtml(view.via)}</span></p>
<p class="muted">Membership <code id="membership-id">${escapeHtml(view.membership_id)}</code> — apps store the uuid, never the ${view.kind === 'silicon' ? 'si:id' : 'c:id'}.</p>
<h2 style="margin-top:20px">What ${escapeHtml(app.name)} received</h2>
${jsonPre('account', view.account)}
<h2 style="margin-top:20px">Token</h2>
${jsonPre('token', view.token)}
${idToken}
<div class="row" style="margin-top:16px"><a class="button secondary" href="/${escapeHtml(app.app_id)}/">Back to ${escapeHtml(app.name)}</a>
<form method="post" action="/${escapeHtml(app.app_id)}/logout"><button type="submit" class="ghost" id="sign-out">Sign out</button></form></div>
</section>
${FOOTER(app)}
</main>`,
  });
}

export function errorPage(app: SiliconAppsApp | null, status: number, code: string, message: string, details: Record<string, unknown> = {}): string {
  const title = app ? `${app.name} · sign-in failed` : 'Fake app · error';
  return page({
    title,
    accent: app?.testkit?.accent,
    head: app ? head(app) : '',
    body: `<main id="fake-app-error" data-error="${escapeHtml(code)}" data-status="${status}">
${app ? appHeader(app) : ''}
<section class="card error">
<h2 id="error-code">${escapeHtml(code)}</h2>
<p id="error-message">${escapeHtml(message)}</p>
${jsonPre('error', { status, code, message, ...details })}
${app ? `<a class="button secondary" href="/${escapeHtml(app.app_id)}/">Back to ${escapeHtml(app.name)}</a>` : ''}
</section>
${app ? FOOTER(app) : ''}
</main>`,
  });
}

/**
 * Shown when the callback carries a state the server did not issue — the SDK may have
 * generated it in the browser. The page looks for it in sessionStorage (any JSON value
 * with a matching `state`, holding `code_verifier`/`codeVerifier`/`verifier`) and
 * finishes the exchange through POST /<app>/callback/client.
 */
export function clientCallbackPage(app: SiliconAppsApp): string {
  return page({
    title: `${app.name} · finishing sign-in`,
    accent: app.testkit?.accent,
    head: head(app),
    body: `<main id="fake-app-callback-client" data-app-id="${escapeHtml(app.app_id)}">
${appHeader(app)}
<section class="card"><p id="callback-status">Finishing sign-in…</p><pre id="error" hidden></pre></section>
</main>
<script>
(async function () {
  var params = new URLSearchParams(location.search);
  var state = params.get('state');
  var found = null;
  try {
    for (var i = 0; i < sessionStorage.length; i++) {
      var key = sessionStorage.key(i);
      var raw = key ? sessionStorage.getItem(key) : null;
      if (!raw) continue;
      var value = null;
      try { value = JSON.parse(raw); } catch (e) { value = null; }
      if (value && typeof value === 'object' && value.state === state) { found = value; break; }
      if (raw === state) { found = { state: state }; }
    }
  } catch (e) { /* storage blocked */ }
  var body = {
    code: params.get('code'), state: state, error: params.get('error'), error_description: params.get('error_description'),
    found: !!found,
    code_verifier: found ? (found.code_verifier || found.codeVerifier || found.verifier || null) : null,
    nonce: found ? (found.nonce || null) : null,
    redirect_uri: found ? (found.redirect_uri || found.redirectUri || null) : null
  };
  var res = await fetch(${JSON.stringify(`/${app.app_id}/callback/client`)}, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  var result = await res.json().catch(function () { return { error: 'bad_response' }; });
  if (result.redirect) { location.replace(result.redirect); return; }
  document.getElementById('callback-status').textContent = 'Sign-in failed.';
  var pre = document.getElementById('error');
  pre.hidden = false;
  pre.textContent = JSON.stringify(result, null, 2);
})();
</script>`,
  });
}
