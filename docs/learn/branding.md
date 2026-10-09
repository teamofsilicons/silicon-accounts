---
title: Why branding works this way
description: Which parts of sign-in you can make your own, why colours must stay readable, and why every page keeps Powered by Silicon Accounts.
kind: informative
order: 17
related:
  - start/branding.md
  - start/sign-in-config.md
  - learn/sign-in-flow.md
  - learn/security.md
---

# Why branding works this way

We serve the sign-in pages, and your app decides how they look: colours, fonts, logo and layout, all through the branding settings. This page explains what you can change and why a few rules hold. For the steps, see [Brand the sign-in pages](../start/branding.md).

The line, in one example: you can make the button green, but not so pale that its text disappears.

```sh
curl -s -X PATCH -u "$APP_ID:$APP_SECRET" -H 'Content-Type: application/json' \
  -d '{"branding": {"light": {"primary": "#22C55E", "primary_foreground": "#FFFFFF"}}}' \
  "$ACCOUNTS_URL/v1/apps/$APP_ID/signin-config"
```

```json
{
  "error": {
    "code": "validation_failed",
    "details": {
      "fields": {
        "branding.light.primary_foreground": "contrast between branding.light.primary_foreground (#FFFFFF) and branding.light.primary (#22C55E) is 2.27:1; it must be at least 4.5:1 (WCAG AA for text) because button text must stay readable"
      }
    },
    "hint": "Fix the fields listed in details.fields and send the request again.",
    "message": "Invalid fields: branding.light.primary_foreground: contrast between …"
  }
}
```

The same green with near-black text (`#0A0A0A`, 8.68:1) is accepted.

## The pages are ours, the look is yours

Signing in is where a Carbon types a code that proves who they are, and decides what your app may know about them. Those pages have to behave the same everywhere: the code entry, the lockout after ten wrong codes, the set-up page, adding a missing phone number, the what's-shared switches, every error. So we draw them, and your app decides how they look.

Branding is a set of variables, not your own CSS or HTML, for three reasons:

- **Trust.** A page anyone can restyle freely can also be made to hide the "what's shared" details, fake a button, or cover the address a code went to. Variables can change how everything looks, but not what's shown.
- **Every state stays designed.** Each variable applies to every step and every state (wrong code, expired code, lockout, refused domain), in light and dark, on desktop and phone, and to steps we add later. Custom CSS would only fit the states its author happened to see.
- **Your own pages stay yours.** If you want full control around the sign-in, put the [iframe or the snippet](../start/add-sign-in.md) on your own page: your layout, our buttons. The steps after the first click are still our pages.

Branding is part of the sign-in setup, so it has a version, an `expected_version` check so no update gets lost, and a history with the before and after of every variable.

## Two palettes and `auto`

A visitor's device is light or dark, and a sign-in page that flashes white in a dark room looks broken. So every app has two palettes, and `theme: "auto"` paints the one that matches the visitor. A brand that only exists in one tone sets `theme` to `light` or `dark`, and then only that palette is used.

Each palette has eight colours (`primary`, `primary_foreground`, `background`, `surface`, `foreground`, `muted`, `border`, `danger`). We mix everything else on the page from those eight (hover and pressed states, subtle fills, the dots and gradients of the backgrounds), so a palette always stays consistent with itself.

## Why contrast is enforced

The two pairs every Carbon has to read to sign in are checked against the WCAG AA level for normal-size text, 4.5:1, in both themes:

- `primary_foreground` on `primary`: the text of "Continue", "Send code", "Finish setup";
- `foreground` on `background`: the page's text.

We refuse a patch that would put either one below 4.5:1, and tell you the measured ratio. A sign-in page someone can't read is a sign-in page that doesn't work, for them and for your app. We check the result of the whole patch, so a later change to `primary` can't quietly break a pair that passed before.

Other colours are never refused. `muted` is for secondary text and `border` is for lines, and refusing them would take away choices that are fine to make. The one exception is handled for you: error messages use `danger`, and when `danger` reads below 4.5:1 on your card or page, the pages move it toward your `foreground` just far enough to pass. Everything else is painted exactly as you chose it.

The default palettes pass with room to spare: button text is `#FFFDF9` on `#1F5FB8` (6.10:1) in both themes. The dark palette once used a lighter blue for buttons, `#5B8FE0`. It put button text at 3.20:1, so we replaced it and moved stored setups that still carried it to `#1F5FB8`, with a `system` entry in their history. `#5B8FE0` is still a link colour on dark surfaces, where it reads well, just not a fill.

## Why fonts are a fixed list

There are ten fonts to pick from: Geist, Inter, IBM Plex Sans, DM Sans, Space Grotesk, Source Serif 4, Fraunces, Instrument Serif, JetBrains Mono, and System (the visitor's own interface font).

- **Privacy.** We serve the fonts ourselves. A page where someone types a sign-in code never asks a third-party font host for anything, so no such host learns who visits it, and the pages' content security policy can stay closed to other origins.
- **Speed.** A font is downloaded only when a page uses it, and the step waits for it (at most 1.5 seconds) so headings never jump.
- **Quality.** Every font on the list is tested at every size the pages use, including the 6-digit code fields.

## Why logos are https (or small and inline)

Give your logo as an HTTPS URL, or as an inline `data:image/…` URI of at most 128 KB. HTTPS keeps the logo secure when it loads on a sign-in page. We don't send the page address as a referrer, so the logo host can't see which sign-in step the Carbon is on.

The inline size limit keeps the sign-in setup small; the whole patch can be at most 512 KB. If the logo fails to load, we show your app's name instead. That fallback still works with `show_app_name: false`, because the name is only hidden while a logo is visible.

When you don't set a logo, we use the one your app has in Silicon Apps, so most apps never need to set one here.

## Powered by Silicon Accounts

Every page ends with "Powered by Silicon Accounts", linking to `accounts.teamofsilicons.com`. It isn't a variable, and we draw it outside the branded part of the page, in its own colours, so no branding can hide or restyle it. In the iframe and the snippet it sits on its own opaque pill, so it reads on any page around it.

Why it's always there:

- **It says whose page this is.** The Carbon is about to prove who they are to Silicon Accounts, not to your app. Knowing that, they know the code they type and the details they share go to the account they already have.
- **It's the same account everywhere.** The account that signs in to your app is the one they carry into every other app. The link takes them to the place where they see every app they signed in to and what each one can see, and where they can remove an app's access.
- **It can't be faked away.** If an app could remove it, a look-alike page without it would look no different from a real one. Because every real page has it, a page without it stands out.

## Defaults

With no branding at all, the pages use the Silicon Accounts look: `Geist`, squircle corners with an 18 px radius, solid buttons, the card layout, a plain background, comfortable spacing, and the palettes below.

| colour | light | dark |
|---|---|---|
| `primary` | `#1F5FB8` | `#1F5FB8` |
| `primary_foreground` | `#FFFDF9` | `#FFFDF9` |
| `background` | `#FFFDF9` | `#2A2927` |
| `surface` | `#FFFFFF` | `#353432` |
| `foreground` | `#353432` | `#FFFDF9` |
| `muted` | `#6F6B66` | `#B5B0A8` |
| `border` | `#E8E3DA` | `#4A4845` |
| `danger` | `#B42318` | `#FF8A80` |

A partial palette fills in the colours you leave out from the defaults of its own theme, so `{"dark": {"primary": "#0B6E4F"}}` keeps the dark background, not the light one.

## Related

- [Brand the sign-in pages](../start/branding.md): every variable, its default and its limits.
- [Configure sign-in](../start/sign-in-config.md): versions, history and the other settings.
- [The sign-in flow](sign-in-flow.md): the steps these pages show.
- [Security](security.md): how the pages protect codes and sessions.
