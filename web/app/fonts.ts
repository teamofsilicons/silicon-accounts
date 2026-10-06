/**
 * The site's typefaces through next/font: downloaded at build and self-hosted under /_next/static/media, so the
 * Content-Security-Policy keeps font-src 'self'. Geist for the interface, Instrument Serif for display moments,
 * JetBrains Mono for ids, tokens and code. Each sets a CSS variable on <html> that styles/tokens.css maps onto
 * --font-body, --font-display, --font-serif and --font-mono.
 *
 * Branding fonts for hosted sign-in pages load on demand from lib/branding/fonts.ts.
 */
import { Geist, Instrument_Serif, JetBrains_Mono } from "next/font/google";

export const geist = Geist({
  subsets: ["latin", "latin-ext"],
  variable: "--font-geist",
  display: "swap",
});

export const instrumentSerif = Instrument_Serif({
  subsets: ["latin", "latin-ext"],
  weight: "400",
  style: ["normal", "italic"],
  variable: "--font-instrument-serif",
  display: "swap",
});

export const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin", "latin-ext"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

/** The class names that put the three font variables on <html>. */
export const fontVariables = [geist.variable, instrumentSerif.variable, jetbrainsMono.variable].join(" ");
