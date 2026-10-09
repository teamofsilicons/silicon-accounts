---
title: Brand the sign-in pages
description: Make the sign-in pages, the iframe and the buttons look like your app, with your colours, fonts, logo and layout.
kind: instructive
order: 17
related:
  - learn/branding.md
  - start/sign-in-config.md
  - start/add-sign-in.md
  - reference/api.md
---

# Brand the sign-in pages

Your sign-in pages can wear your app's colours, fonts and logo, so they feel like your own. You also choose the corner shape, button style, layout, background and spacing, and you set separate colours for light and dark mode.

Your branding applies all the way through sign-in: the opening page, the email and phone codes, account setup, required details, the what's-shared screen, and the buttons in an iframe or the snippet. It is saved as part of your [sign-in setup](sign-in-config.md), so every change gets a version number.

```sh
printf '%s' "$APP_SECRET" | silicon-accounts app use waveform --secret-stdin
silicon-accounts app config set branding.json --expected-version 8
```

with `branding.json`:

```json
{
  "branding": {
    "theme": "auto",
    "logo_url": "https://cdn.example.com/waveform/logo.svg",
    "logo_dark_url": "https://cdn.example.com/waveform/logo-dark.svg",
    "logo_height": 40,
    "show_app_name": false,
    "font_family": "Inter",
    "heading_font_family": "Fraunces",
    "corner_style": "rounded",
    "radius": 12,
    "button_style": "solid",
    "layout": "split",
    "background_style": "dots",
    "density": "comfortable",
    "light": {"primary": "#0B6E4F", "primary_foreground": "#FFFFFF"},
    "dark": {"primary": "#0B6E4F", "primary_foreground": "#FFFFFF", "background": "#101412", "surface": "#18201C"}
  }
}
```

```text
Updated waveform (branding); the sign-in setup is now version 9.
```

Everything you leave out keeps its current value, and for an app that never set any branding,
that's the Silicon Accounts look. A palette you never set takes its colours from the same
theme's defaults, so your dark palette never inherits light colours. Over HTTP, it's the same
patch:

```sh
curl -s -X PATCH -u "$APP_ID:$APP_SECRET" \
  -H 'Content-Type: application/json' \
  --data-binary @branding.json \
  "$ACCOUNTS_URL/v1/apps/$APP_ID/signin-config"
```

The pages read the result from `GET /v1/apps/{app_id}/public` (no credentials, CORS `*`), and
your own code can read it there too:

```sh
curl -s "$ACCOUNTS_URL/v1/apps/waveform/public"
```

```json
{
  "app_id": "waveform",
  "name": "Waveform",
  "methods": ["apple", "google", "email"],
  "branding": {
    "background_image_url": null,
    "background_style": "dots",
    "button_style": "solid",
    "corner_style": "rounded",
    "dark": {"background": "#101412", "border": "#4A4845", "danger": "#FF8A80", "foreground": "#FFFDF9", "muted": "#B5B0A8", "primary": "#0B6E4F", "primary_foreground": "#FFFFFF", "surface": "#18201C"},
    "density": "comfortable",
    "font_family": "Inter",
    "heading_font_family": "Fraunces",
    "layout": "split",
    "light": {"background": "#FFFDF9", "border": "#E8E3DA", "danger": "#B42318", "foreground": "#353432", "muted": "#6F6B66", "primary": "#0B6E4F", "primary_foreground": "#FFFFFF", "surface": "#FFFFFF"},
    "logo_dark_url": "https://cdn.example.com/waveform/logo-dark.svg",
    "logo_height": 40,
    "logo_url": "https://cdn.example.com/waveform/logo.svg",
    "radius": 12,
    "show_app_name": false,
    "theme": "auto"
  },
  "copy": {"title": "Sign in to Waveform", "subtitle": null, "terms_url": "…", "privacy_url": "…", "support_email": "…"},
  "logo_url": "…",
  "logo_dark_url": "…",
  "homepage_url": "…",
  "allowed_origins": ["…"]
}
```

You can make the same changes in your app's **Pages** tab (`/apps/{app_id}/pages`) on [developers.teamofsilicons.com](https://developers.teamofsilicons.com), where you can edit the wording too.

Its live preview shows every step: sign-in and sign-up, opening Google or Apple, entering a code, account setup, your custom flow, the what's-shared screen and the embedded buttons. Switch between light and dark, or desktop and phone, to check each layout.

Branding can be changed with the app's credentials, or by one of its authors through their own session. See [who can change the setup](sign-in-config.md#who-can-change-it).

## The variables

| variable | default | values | what it changes |
|---|---|---|---|
| `theme` | `auto` | `auto`, `light`, `dark` | Which palette is painted. `auto` follows the visitor's device; `light` or `dark` always uses that palette. |
| `light` | the light palette below | 8 colours | Colours when the page is light. |
| `dark` | the dark palette below | 8 colours | Colours when the page is dark. |
| `logo_url` | `null` | `https` URL, or a `data:image/…` URI up to 128 KB | Your logo at the top of the form (and on your side of the split layout). Without one, the logo your app has in Silicon Apps is used. |
| `logo_dark_url` | `null` | same | The logo on dark pages. Falls back to `logo_url`, then to your app's dark logo, then to its logo. |
| `logo_height` | `36` | 16 to 96 (px, whole number) | The logo's height. |
| `show_app_name` | `true` | `true`, `false` | Your app's name next to the logo. With `false` the name is hidden only while a logo shows: no logo (or one that fails to load) always shows the name. |
| `font_family` | `Geist` | the font list below | All text. |
| `heading_font_family` | `null` | the font list, or `null` | Headings. `null` uses `font_family`. |
| `corner_style` | `squircle` | `squircle`, `rounded`, `sharp` | The shape of corners. `squircle`: smooth continuous curves; `rounded`: circular arcs; `sharp`: square corners (the radius is ignored). |
| `radius` | `18` | 0 to 40 (px, whole number) | Corner radius of buttons and fields. Panels scale from it (the card's radius is about 1.9 times it). |
| `button_style` | `solid` | `solid`, `soft`, `outline` | Primary buttons: filled with `primary`, a light tint of `primary` with `primary`-coloured text, or a `primary` outline. |
| `layout` | `card` | `card`, `split`, `minimal` | `card`: the form in a centred card. `split`: your logo, title and subtitle on the left half of the page, the form on the right (it folds into a card on narrow screens). `minimal`: no card, a narrower column, more air. |
| `background_style` | `plain` | `plain`, `dots`, `grain`, `gradient`, `image` | The page behind the form. `dots`: a fading dot grid; `grain`: a fine noise texture; `gradient`: two soft glows of `primary`; `image`: your picture. Decoration sits behind the form and never changes its contrast. |
| `background_image_url` | `null` | `https` URL | Required with `background_style: "image"`. Drawn to cover the page, under a 30% wash of `background`. |
| `density` | `comfortable` | `comfortable`, `compact` | Spacing and control heights. `compact` has tighter padding, shorter buttons and fields, and a slightly narrower card. |

Values are exact: `"Inter"`, not `"inter"`; `"split"`, not `"Split"`. Numbers are whole numbers.

### The palettes

Each theme has the same eight colours, written `#RRGGBB` (any letter case; we store them
uppercase):

| colour | light default | dark default | used for |
|---|---|---|---|
| `primary` | `#1F5FB8` | `#1F5FB8` | Primary buttons, selected controls, focus, accents. On dark pages, links and accents use a lighter mix of `primary` and `foreground`. |
| `primary_foreground` | `#FFFDF9` | `#FFFDF9` | Text and icons on `primary`. |
| `background` | `#FFFDF9` | `#2A2927` | The page. |
| `surface` | `#FFFFFF` | `#353432` | The card and the fields. |
| `foreground` | `#353432` | `#FFFDF9` | Text. |
| `muted` | `#6F6B66` | `#B5B0A8` | Secondary text. |
| `border` | `#E8E3DA` | `#4A4845` | Borders and dividers. |
| `danger` | `#B42318` | `#FF8A80` | Error messages. |

With `theme: "auto"`, set both palettes, because a visitor whose device is dark sees `dark`.
With a forced theme, only that palette is used.

## Contrast: at least 4.5:1

Two pairs must be readable in both themes, or the patch is refused:

| text | on | why |
|---|---|---|
| `primary_foreground` | `primary` | Button text: "Continue", "Send code", "Finish setup". |
| `foreground` | `background` | Page text. |

The minimum is 4.5:1, the WCAG AA level for normal-size text. Our defaults are well above it
(button text 6.10:1, page text 12.24:1 light and 14.30:1 dark). A refusal tells you the measured
ratio, rounded down to two decimals:

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

There are two ways to fix it: keep the colour and flip the text (`#22C55E` under `#0A0A0A` is
well above 4.5:1), or darken the colour (`#15803D` under `#FFFFFF` is 5.01:1). The check runs on
the whole result of the patch, so changing `primary` alone can break a pair you set earlier.

We don't refuse other colours, but check them the same way: text sits on `surface` in the card,
so keep `foreground` and `muted` at 4.5:1 there too. Error text is the one case the pages handle
for you. When `danger` reads below 4.5:1 on your `surface` or `background`, the pages move it
toward your `foreground` just far enough to pass, and keep every other colour exactly as you
chose it.

## Logos

```json
{"branding": {"logo_url": "https://cdn.example.com/waveform/logo.svg", "logo_dark_url": "https://cdn.example.com/waveform/logo-dark.svg", "logo_height": 40}}
```

- Use an `https` URL, or an inline `data:image/png`, `jpeg`, `webp`, `gif` or `svg+xml` URI up
  to 128 KB. Plain `http` is refused (`'http://…' must use https`), and a larger inline logo is
  refused with "inline data URIs must be at most 128 KB; host the logo and use an https URL".
- The pages load your logo from your URL as it is, without sending the page address as a
  referrer. Serve it from a host that stays up, because a logo that fails to load is replaced by
  your app's name.
- Without `logo_url`, the logo your app has in Silicon Apps is used, so many apps never set one
  here.
- The whole PATCH body may be at most 512 KB, which leaves room for two inline logos.

## Fonts

| `font_family` / `heading_font_family` | style |
|---|---|
| `Geist` (default) | sans-serif |
| `Inter` | sans-serif |
| `IBM Plex Sans` | sans-serif |
| `DM Sans` | sans-serif |
| `Space Grotesk` | sans-serif |
| `Source Serif 4` | serif |
| `Fraunces` | serif |
| `Instrument Serif` | serif |
| `JetBrains Mono` | monospace |
| `System` | the visitor's own interface font |

Only these. We serve them ourselves and load each one only when a page uses it, so your sign-in
never waits on a third-party font host or reports your visitors to one. The usual pairing is a
body font with a heading font: `"font_family": "Inter", "heading_font_family": "Fraunces"`.

## "Powered by Silicon Accounts"

Every page ends with "Powered by Silicon Accounts", with "Silicon Accounts" linking to
`https://accounts.teamofsilicons.com`. It isn't a variable: you can't remove, hide, recolour or
restyle it. We draw it outside the branded part of the page, in our own colours (light or dark,
following the visitor), so no branding reaches it. The iframe and the snippet show it too, on an
opaque pill of their own so it reads on any page. [Why](../learn/branding.md#powered-by-silicon-accounts).

## The iframe and the snippet

The buttons in the iframe and the snippet use the same palette, radius, corner style, button
style, density and font. Which palette they paint is decided in this order:

- iframe: the embed URL's `theme=light` or `theme=dark` (it describes your page around the
  frame); otherwise a branding `theme` of `light` or `dark`; otherwise the device's theme when
  the URL says `theme=auto`; otherwise light.
- snippet: `data-theme="light"` or `"dark"`; otherwise a branding `theme` of `light` or
  `dark`; otherwise your page decides: the first opaque background behind the buttons, or the
  page's color scheme.

How to set them up is in [Add sign-in to your app](add-sign-in.md).

## Reset and undo

- `null` resets one variable to its default: `{"branding": {"radius": null}}`.
- `{"branding": {"light": null}}` resets the whole light palette.
- `{"branding": null}` resets all branding to the Silicon Accounts look.
- Every change is a new version in the [history](sign-in-config.md#4-read-the-history), with
  the before and after of each variable. To undo, patch the `before` values back.

## Errors

| field | message (examples) |
|---|---|
| `branding.light.primary_foreground` | `contrast between … is 2.27:1; it must be at least 4.5:1 (WCAG AA for text) because button text must stay readable` |
| `branding.light.foreground` | `contrast between branding.light.foreground (#8A8580) and branding.light.background (#FFFDF9) is 3.59:1; … because page text must stay readable` |
| `branding.light.primary` | `'blue' must be a #RRGGBB colour` |
| `branding.radius` | `is 50 but must be between 0 and 40 (pixels)`; `invalid type: floating point `12.5`, expected u32` |
| `branding.logo_height` | `is 10 but must be between 16 and 96 (pixels)` |
| `branding.logo_url` | `'http://cdn.example.com/logo.png' must use https`; `data URIs must be data:image/png, jpeg, webp, gif or svg+xml` |
| `branding.background_image_url` | `is required when branding.background_style is image (an https URL)` |
| `branding.font_family` | ``unknown value `Comic Sans`, expected one of Geist, Inter, IBM Plex Sans, DM Sans, Space Grotesk, Source Serif 4, Fraunces, Instrument Serif, JetBrains Mono, System`` |
| `branding.colour` | `unknown field; allowed fields here are background_image_url, background_style, button_style, corner_style, dark, density, font_family, heading_font_family, layout, light, logo_dark_url, logo_height, logo_url, radius, show_app_name, theme` |

All of these are `422 validation_failed`, with every problem in `details.fields`. We only check
colour contrast once all eight colours of a palette are valid.

## Related

- [Why branding works this way](../learn/branding.md): what is and isn't configurable, and why.
- [Configure sign-in](sign-in-config.md): versions, history and the other settings.
- [Add sign-in to your app](add-sign-in.md): the hosted pages, the iframe and the snippet.
