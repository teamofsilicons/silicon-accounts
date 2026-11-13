/**
 * Branding fonts that ship through next/font: Geist, Instrument Serif and JetBrains Mono are three of the faces an app
 * may pick for its hosted sign-in pages (lib/branding/fonts.ts). They are downloaded at build and self-hosted under
 * /_next/static/media (font-src 'self'), never preloaded, and a browser only fetches one when an app's branded page
 * actually uses it. Hanken Grotesk, Silicon UI's --font-body (through --font-hanken-grotesk), is the site's face for
 * text and titles (styles/tokens.css), so it is preloaded; Geist, Silicon UI's own title face, is not (only branded pages and the
 * type lab use it).
 *
 * Geist Serif (the geist package, self-hosted by next/font/local as --font-geist-serif) sets Home's "Create your first
 * Silicon" heading (Anil, 2026-10-31).
 */
import { GeistSerif } from "geist/font/serif";
import localFont from "next/font/local";
import { Geist, Hanken_Grotesk, Instrument_Serif, Inter, JetBrains_Mono, Work_Sans } from "next/font/google";

/** The site's text face: Silicon UI's body font for every Silicon product. */
const hankenGrotesk = Hanken_Grotesk({
  subsets: ["latin", "latin-ext"],
  variable: "--font-hanken-grotesk",
  display: "swap",
});

/** Silicon UI's shipped display face; the site sets titles in Hanken (styles/tokens.css). Not preloaded (as before
 * the redesign): only apps branded with Geist and the type lab paint it, so other pages, the embed included, skip it. */
const geist = Geist({
  subsets: ["latin", "latin-ext"],
  variable: "--font-geist",
  display: "swap",
  preload: false,
});

const instrumentSerif = Instrument_Serif({
  subsets: ["latin", "latin-ext"],
  weight: "400",
  style: ["normal", "italic"],
  variable: "--font-instrument-serif",
  display: "swap",
  preload: false,
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin", "latin-ext"],
  variable: "--font-jetbrains-mono",
  display: "swap",
  preload: false,
});

/** Inter, for the dev panel's type lab and Edit text (it was the site's face for a day, 2026-11-09). Never preloaded. */
const inter = Inter({
  subsets: ["latin", "latin-ext"],
  variable: "--font-inter",
  display: "swap",
  preload: false,
});

/** Work Sans, for the type lab (Anil, 2026-11-08, from open-foundry.com). Never preloaded. */
const workSans = Work_Sans({
  subsets: ["latin", "latin-ext"],
  variable: "--font-work-sans",
  display: "swap",
  preload: false,
});

/**
 * Three faces for the type lab from open-foundry.com (Anil, 2026-11-08), self-hosted from assets/fonts (each folder has
 * its licence): TeX Gyre Heros (GUST Font License), Liberation Sans and Cooper Hewitt (SIL OFL 1.1). Never preloaded.
 */
const texGyreHeros = localFont({
  src: [
    { path: "../assets/fonts/tex-gyre-heros/texgyreheros-regular.otf", weight: "400", style: "normal" },
    { path: "../assets/fonts/tex-gyre-heros/texgyreheros-bold.otf", weight: "700", style: "normal" },
  ],
  variable: "--font-tex-gyre-heros",
  display: "swap",
  preload: false,
});

const liberationSans = localFont({
  src: [
    { path: "../assets/fonts/liberation-sans/LiberationSans-Regular.ttf", weight: "400", style: "normal" },
    { path: "../assets/fonts/liberation-sans/LiberationSans-Bold.ttf", weight: "700", style: "normal" },
  ],
  variable: "--font-liberation-sans",
  display: "swap",
  preload: false,
});

const cooperHewitt = localFont({
  src: [
    { path: "../assets/fonts/cooper-hewitt/CooperHewitt-Book.otf", weight: "400", style: "normal" },
    { path: "../assets/fonts/cooper-hewitt/CooperHewitt-Medium.otf", weight: "500", style: "normal" },
    { path: "../assets/fonts/cooper-hewitt/CooperHewitt-Semibold.otf", weight: "600", style: "normal" },
    { path: "../assets/fonts/cooper-hewitt/CooperHewitt-Bold.otf", weight: "700", style: "normal" },
  ],
  variable: "--font-cooper-hewitt",
  display: "swap",
  preload: false,
});

/** The class names that put the site's two faces and the branding font variables on <html>. */
export const brandFontVariables = [hankenGrotesk.variable, geist.variable, GeistSerif.variable, instrumentSerif.variable, jetbrainsMono.variable, inter.variable, workSans.variable, texGyreHeros.variable, liberationSans.variable, cooperHewitt.variable].join(" ");
