/**
 * The sky at a time of day, for Sky bands (components/account/silicons/sky-bands.tsx): a colour from the --sky-* tokens,
 * mixed between the two nearest stops so the day moves smoothly.
 */
const STOPS = [
  { at: 0, color: "--sky-night" },
  { at: 5 * 60, color: "--sky-night" },
  { at: 6.5 * 60, color: "--sky-dawn" },
  { at: 8.5 * 60, color: "--sky-morning" },
  { at: 12 * 60, color: "--sky-noon" },
  { at: 16 * 60, color: "--sky-afternoon" },
  { at: 18.5 * 60, color: "--sky-dusk" },
  { at: 20.5 * 60, color: "--sky-night" },
  { at: 24 * 60, color: "--sky-night" },
];

/** A CSS colour for minutes since local midnight. */
export function skyColor(minutes: number): string {
  const time = ((minutes % 1440) + 1440) % 1440;
  const next = STOPS.findIndex(stop => stop.at > time);
  const after = STOPS[next] ?? STOPS[STOPS.length - 1]!;
  const before = STOPS[Math.max(next - 1, 0)]!;
  const share = Math.round(((time - before.at) / (after.at - before.at)) * 100);
  return `color-mix(in oklab, var(${after.color}) ${share}%, var(${before.color}))`;
}

/** Minutes since local midnight at an offset from UTC. */
export function localMinutes(offset: number, at: Date): number {
  return at.getUTCHours() * 60 + at.getUTCMinutes() + offset;
}

/** The land's dots at a time of day: white under a dark sky, dark ink under a light one, so they read at every hour. */
export function skyInk(minutes: number): string {
  const time = ((minutes % 1440) + 1440) % 1440;
  return time >= 7 * 60 && time < 18.5 * 60 ? "var(--sky-night)" : "var(--neutral-0)";
}
