/**
 * Branding fonts that ship through next/font: Geist, Instrument Serif and JetBrains Mono are three of the faces an app
 * may pick for its hosted sign-in pages (lib/branding/fonts.ts). They are downloaded at build and self-hosted under
 * /_next/static/media (font-src 'self'), never preloaded, and a browser only fetches one when an app's branded page
 * actually uses it. Geist is also Silicon UI's --font-display (titles and the wordmark, through --font-geist), so it
 * is preloaded along with Hanken Grotesk, Silicon UI's --font-body (through --font-hanken-grotesk): the site's two
 * faces.
 */
import { Geist, Hanken_Grotesk, Instrument_Serif, JetBrains_Mono } from "next/font/google";

/** The site's text face: Silicon UI's body font for every Silicon product. */
const hankenGrotesk = Hanken_Grotesk({
  subsets: ["latin", "latin-ext"],
  variable: "--font-hanken-grotesk",
  display: "swap",
});

/** The site's title face: Silicon UI's display font. */
const geist = Geist({
  subsets: ["latin", "latin-ext"],
  variable: "--font-geist",
  display: "swap",
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

/** The class names that put the site's two faces and the branding font variables on <html>. */
export const brandFontVariables = [hankenGrotesk.variable, geist.variable, instrumentSerif.variable, jetbrainsMono.variable].join(" ");
