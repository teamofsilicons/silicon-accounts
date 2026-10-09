/**
 * Branding fonts that ship through next/font: Geist, Instrument Serif and JetBrains Mono are three of the faces an app
 * may pick for its hosted sign-in pages (lib/branding/fonts.ts), so the Pages tab's live preview must be able to show
 * them. They are downloaded at build and self-hosted under /_next/static/media (font-src 'self'), never preloaded, and
 * a browser only fetches one when a branded preview actually uses it. The site's own faces are in styles/fonts.css.
 */
import { Geist, Instrument_Serif, JetBrains_Mono } from "next/font/google";

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

/** The class names that put the three branding font variables on <html>. */
export const brandFontVariables = [geist.variable, instrumentSerif.variable, jetbrainsMono.variable].join(" ");
