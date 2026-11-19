/**
 * The two sample apps of /__signin, copied from the test fixtures (testkit/fake-apps.json: briefcase, acme-notes) so the
 * browser can use them (Turbopack can't import outside web/). Sample data only.
 */
export const SAMPLE_APPS = {
  "briefcase": {
    "app_id": "briefcase",
    "name": "Briefcase",
    "logo_url": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCIgd2lkdGg9IjY0IiBoZWlnaHQ9IjY0Ij48cGF0aCBkPSJNMzIgMEM1NS4zIDAgNjQgOC43IDY0IDMyUzU1LjMgNjQgMzIgNjQgMCA1NS4zIDAgMzIgOC43IDAgMzIgMFoiIGZpbGw9IiMyRjRCN0MiLz48ZyBmaWxsPSJub25lIiBzdHJva2U9IiNGRkZERjkiIHN0cm9rZS13aWR0aD0iMy41IiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiPjxyZWN0IHg9IjE1IiB5PSIyMyIgd2lkdGg9IjM0IiBoZWlnaHQ9IjI0IiByeD0iNSIvPjxwYXRoIGQ9Ik0yNiAyM3YtMy41YTMuNSAzLjUgMCAwIDEgMy41LTMuNWg1YTMuNSAzLjUgMCAwIDEgMy41IDMuNVYyMyIvPjxwYXRoIGQ9Ik0xNSAzM2gzNCIvPjxwYXRoIGQ9Ik0yOSAzM3YzLjVoNlYzMyIvPjwvZz48L3N2Zz4=",
    "logo_dark_url": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCIgd2lkdGg9IjY0IiBoZWlnaHQ9IjY0Ij48cGF0aCBkPSJNMzIgMEM1NS4zIDAgNjQgOC43IDY0IDMyUzU1LjMgNjQgMzIgNjQgMCA1NS4zIDAgMzIgOC43IDAgMzIgMFoiIGZpbGw9IiMzRDVGOTkiLz48ZyBmaWxsPSJub25lIiBzdHJva2U9IiNGRkZERjkiIHN0cm9rZS13aWR0aD0iMy41IiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiPjxyZWN0IHg9IjE1IiB5PSIyMyIgd2lkdGg9IjM0IiBoZWlnaHQ9IjI0IiByeD0iNSIvPjxwYXRoIGQ9Ik0yNiAyM3YtMy41YTMuNSAzLjUgMCAwIDEgMy41LTMuNWg1YTMuNSAzLjUgMCAwIDEgMy41IDMuNVYyMyIvPjxwYXRoIGQ9Ik0xNSAzM2gzNCIvPjxwYXRoIGQ9Ik0yOSAzM3YzLjVoNlYzMyIvPjwvZz48L3N2Zz4=",
    "homepage_url": "http://127.0.0.1:8593/briefcase/",
    "methods": {
      "email": true,
      "phone": true,
      "google": true,
      "apple": true
    },
    "method_order": [
      "google",
      "apple",
      "email",
      "phone"
    ],
    "branding": {},
    "copy": {
      "title": "Sign in to Briefcase",
      "subtitle": "Your files, for every Carbon and Silicon.",
      "signup_title": "Create your Briefcase account",
      "terms_url": "https://teamofsilicons.com/legal/terms",
      "privacy_url": "https://teamofsilicons.com/legal/privacy",
      "support_email": "support@teamofsilicons.com"
    }
  },
  "acme-notes": {
    "app_id": "acme-notes",
    "name": "Acme Notes",
    "logo_url": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCIgd2lkdGg9IjY0IiBoZWlnaHQ9IjY0Ij48cGF0aCBkPSJNMzIgMEM1NS4zIDAgNjQgOC43IDY0IDMyUzU1LjMgNjQgMzIgNjQgMCA1NS4zIDAgMzIgOC43IDAgMzIgMFoiIGZpbGw9IiMxQTE3MTQiLz48ZyBmaWxsPSJub25lIiBzdHJva2U9IiNFOEIwNEIiIHN0cm9rZS13aWR0aD0iMy41IiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiPjxwYXRoIGQ9Ik0yMCAxNGgxN2w5IDl2MjdIMjB6Ii8+PHBhdGggZD0iTTM3IDE0djloOSIvPjxwYXRoIGQ9Ik0yNS41IDMxaDE1TTI1LjUgMzdoMTVNMjUuNSA0M2g5Ii8+PC9nPjwvc3ZnPg==",
    "logo_dark_url": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCIgd2lkdGg9IjY0IiBoZWlnaHQ9IjY0Ij48cGF0aCBkPSJNMzIgMEM1NS4zIDAgNjQgOC43IDY0IDMyUzU1LjMgNjQgMzIgNjQgMCA1NS4zIDAgMzIgOC43IDAgMzIgMFoiIGZpbGw9IiM0QTNGMzMiLz48ZyBmaWxsPSJub25lIiBzdHJva2U9IiNFOEIwNEIiIHN0cm9rZS13aWR0aD0iMy41IiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiPjxwYXRoIGQ9Ik0yMCAxNGgxN2w5IDl2MjdIMjB6Ii8+PHBhdGggZD0iTTM3IDE0djloOSIvPjxwYXRoIGQ9Ik0yNS41IDMxaDE1TTI1LjUgMzdoMTVNMjUuNSA0M2g5Ii8+PC9nPjwvc3ZnPg==",
    "homepage_url": "http://127.0.0.1:8593/acme-notes/",
    "methods": {
      "google": true,
      "email": true,
      "phone": false,
      "apple": false
    },
    "method_order": [
      "google",
      "email"
    ],
    "branding": {
      "logo_url": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCIgd2lkdGg9IjY0IiBoZWlnaHQ9IjY0Ij48cGF0aCBkPSJNMzIgMEM1NS4zIDAgNjQgOC43IDY0IDMyUzU1LjMgNjQgMzIgNjQgMCA1NS4zIDAgMzIgOC43IDAgMzIgMFoiIGZpbGw9IiMxQTE3MTQiLz48ZyBmaWxsPSJub25lIiBzdHJva2U9IiNFOEIwNEIiIHN0cm9rZS13aWR0aD0iMy41IiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiPjxwYXRoIGQ9Ik0yMCAxNGgxN2w5IDl2MjdIMjB6Ii8+PHBhdGggZD0iTTM3IDE0djloOSIvPjxwYXRoIGQ9Ik0yNS41IDMxaDE1TTI1LjUgMzdoMTVNMjUuNSA0M2g5Ii8+PC9nPjwvc3ZnPg==",
      "logo_dark_url": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCIgd2lkdGg9IjY0IiBoZWlnaHQ9IjY0Ij48cGF0aCBkPSJNMzIgMEM1NS4zIDAgNjQgOC43IDY0IDMyUzU1LjMgNjQgMzIgNjQgMCA1NS4zIDAgMzIgOC43IDAgMzIgMFoiIGZpbGw9IiM0QTNGMzMiLz48ZyBmaWxsPSJub25lIiBzdHJva2U9IiNFOEIwNEIiIHN0cm9rZS13aWR0aD0iMy41IiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiPjxwYXRoIGQ9Ik0yMCAxNGgxN2w5IDl2MjdIMjB6Ii8+PHBhdGggZD0iTTM3IDE0djloOSIvPjxwYXRoIGQ9Ik0yNS41IDMxaDE1TTI1LjUgMzdoMTVNMjUuNSA0M2g5Ii8+PC9nPjwvc3ZnPg==",
      "theme": "dark",
      "logo_height": 40,
      "show_app_name": true,
      "font_family": "Inter",
      "heading_font_family": "Fraunces",
      "corner_style": "squircle",
      "radius": 28,
      "button_style": "solid",
      "layout": "split",
      "background_style": "grain",
      "density": "comfortable",
      "light": {
        "primary": "#8A4F0F",
        "primary_foreground": "#FFFBF5",
        "background": "#FBF7F0",
        "surface": "#FFFFFF",
        "foreground": "#2B2118",
        "muted": "#6E5E4C",
        "border": "#E9DFD0",
        "danger": "#B42318"
      },
      "dark": {
        "primary": "#E8B04B",
        "primary_foreground": "#1A1410",
        "background": "#16130F",
        "surface": "#211D18",
        "foreground": "#F3ECE2",
        "muted": "#B3A796",
        "border": "#3A332B",
        "danger": "#F97066"
      }
    },
    "copy": {
      "title": "Welcome back to Acme Notes",
      "subtitle": "Sign in to pick up where you left off.",
      "opening_title": "Taking you to {provider} for {app}\u2026",
      "signup_title": "Start your Acme notebook",
      "terms_url": "https://acme-notes.test/terms",
      "privacy_url": "https://acme-notes.test/privacy",
      "support_email": "help@acme-notes.test"
    }
  }
} as const;
