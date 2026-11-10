/**
 * IANA time zones for pickers (Arc Combobox options): every zone the browser knows, labelled with its current UTC
 * offset and searchable by city, region and offset ("kolkata", "+05:30", "india").
 */
import type { ComboboxOption } from "@teamofsilicons/silicon-ui/combobox";

/** "+05:30" for a zone at a moment (now by default). */
export function utcOffset(timeZone: string, at: Date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" }).formatToParts(at);
    const name = parts.find(part => part.type === "timeZoneName")?.value ?? "GMT";
    const match = /GMT([+-]\d{2}):?(\d{2})?/.exec(name);
    if (!match) return "+00:00";
    return `${match[1]}:${match[2] ?? "00"}`;
  } catch {
    return "+00:00";
  }
}

/** Offset in minutes (for sorting). */
export function offsetMinutes(timeZone: string, at: Date = new Date()): number {
  const [hours = "0", minutes = "0"] = utcOffset(timeZone, at).split(":");
  const sign = hours.startsWith("-") ? -1 : 1;
  return sign * (Math.abs(Number(hours)) * 60 + Number(minutes));
}

/** "Asia/Kolkata" → "Kolkata, Asia". */
export function timezoneLabel(timeZone: string): string {
  if (timeZone === "UTC" || timeZone === "Etc/UTC") return "Coordinated Universal Time";
  const parts = timeZone.split("/");
  const city = (parts[parts.length - 1] ?? timeZone).replace(/_/g, " ");
  const region = parts.length > 1 ? parts.slice(0, -1).join(" / ").replace(/_/g, " ") : "";
  return region ? `${city}, ${region}` : city;
}

const FALLBACK = [
  "UTC", "Africa/Cairo", "Africa/Johannesburg", "Africa/Lagos", "Africa/Nairobi", "America/Anchorage", "America/Argentina/Buenos_Aires",
  "America/Bogota", "America/Chicago", "America/Denver", "America/Halifax", "America/Lima", "America/Los_Angeles", "America/Mexico_City",
  "America/New_York", "America/Phoenix", "America/Santiago", "America/Sao_Paulo", "America/Toronto", "America/Vancouver", "Asia/Bangkok",
  "Asia/Dhaka", "Asia/Dubai", "Asia/Hong_Kong", "Asia/Jakarta", "Asia/Jerusalem", "Asia/Karachi", "Asia/Kathmandu", "Asia/Kolkata",
  "Asia/Manila", "Asia/Riyadh", "Asia/Seoul", "Asia/Shanghai", "Asia/Singapore", "Asia/Taipei", "Asia/Tehran", "Asia/Tokyo",
  "Atlantic/Reykjavik", "Australia/Adelaide", "Australia/Brisbane", "Australia/Melbourne", "Australia/Perth", "Australia/Sydney",
  "Europe/Amsterdam", "Europe/Athens", "Europe/Berlin", "Europe/Dublin", "Europe/Helsinki", "Europe/Istanbul", "Europe/Lisbon",
  "Europe/London", "Europe/Madrid", "Europe/Moscow", "Europe/Paris", "Europe/Rome", "Europe/Stockholm", "Europe/Warsaw", "Europe/Zurich",
  "Pacific/Auckland", "Pacific/Honolulu",
];

/** Legacy IANA names some engines still list (ICU), mapped to the names people know and the server stores. */
const MODERN: Record<string, string> = {
  "Asia/Calcutta": "Asia/Kolkata",
  "Asia/Katmandu": "Asia/Kathmandu",
  "Asia/Saigon": "Asia/Ho_Chi_Minh",
  "Asia/Rangoon": "Asia/Yangon",
  "Asia/Dacca": "Asia/Dhaka",
  "Asia/Thimbu": "Asia/Thimphu",
  "Asia/Ulan_Bator": "Asia/Ulaanbaatar",
  "Asia/Macao": "Asia/Macau",
  "Asia/Chungking": "Asia/Chongqing",
  "Europe/Kiev": "Europe/Kyiv",
  "Europe/Uzhgorod": "Europe/Kyiv",
  "Europe/Zaporozhye": "Europe/Kyiv",
  "Atlantic/Faeroe": "Atlantic/Faroe",
  "America/Godthab": "America/Nuuk",
  "Pacific/Enderbury": "Pacific/Kanton",
  "Pacific/Ponape": "Pacific/Pohnpei",
  "Pacific/Truk": "Pacific/Chuuk",
  "Africa/Asmera": "Africa/Asmara",
  "America/Buenos_Aires": "America/Argentina/Buenos_Aires",
};

/** The modern name for a zone (Asia/Calcutta → Asia/Kolkata); unknown names pass through. */
export function modernTimezone(timeZone: string): string {
  return MODERN[timeZone] ?? timeZone;
}

let cache: string[] | undefined;

/** Every supported IANA zone (Intl.supportedValuesOf), with UTC first. */
export function allTimezones(): string[] {
  if (cache) return cache;
  let zones: string[] = [];
  try {
    const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone");
    if (supported?.length) zones = supported;
  } catch {
    // Older engines: the curated list below.
  }
  if (!zones.length) zones = FALLBACK;
  const modern = new Set(zones.map(modernTimezone));
  for (const zone of FALLBACK) modern.add(zone);
  modern.delete("UTC");
  cache = ["UTC", ...[...modern].sort()];
  return cache;
}

/** True when the browser accepts `timeZone` as an IANA zone. */
export function isValidTimezone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Combobox options for a timezone picker: label "Kolkata, Asia · UTC+05:30", keywords for search (zone name, city,
 * offset, legacy names). Pass the current value in `include` so a zone the engine does not list still shows as selected.
 */
export function timezoneOptions(at: Date = new Date(), include: string[] = []): ComboboxOption[] {
  const zones = [...allTimezones()];
  for (const zone of include) if (zone && !zones.includes(zone) && isValidTimezone(zone)) zones.push(zone);
  return zones.map(zone => {
    const offset = utcOffset(zone, at);
    return {
      value: zone,
      label: `${timezoneLabel(zone)} · UTC${offset}`,
      keywords: [zone, zone.replace(/_/g, " "), offset, `utc${offset}`, `gmt${offset}`, ...Object.entries(MODERN).filter(([, name]) => name === zone).map(([legacy]) => legacy)],
    };
  });
}

export interface TimezoneBand {
  /** Minutes east of UTC right now. */
  offset: number;
  /** "+05:30". */
  label: string;
  /** Every zone at this offset. */
  zones: string[];
  /** The zone a band stands for: the best known one. */
  primary: string;
}

/** The zones people know best, first match wins, so each offset is named after one of them. */
export const WELL_KNOWN = [
  "UTC", "Pacific/Pago_Pago", "Pacific/Honolulu", "Pacific/Marquesas", "America/Anchorage", "America/Los_Angeles", "America/Denver",
  "America/Chicago", "America/Mexico_City", "America/New_York", "America/Halifax", "America/St_Johns", "America/Sao_Paulo", "Atlantic/South_Georgia",
  "Atlantic/Azores", "Europe/Paris", "Africa/Lagos", "Europe/Athens", "Europe/Moscow", "Asia/Tehran", "Asia/Dubai", "Asia/Kabul", "Asia/Karachi",
  "Asia/Kolkata", "Asia/Kathmandu", "Asia/Dhaka", "Asia/Yangon", "Asia/Bangkok", "Asia/Singapore", "Australia/Eucla", "Asia/Tokyo",
  "Australia/Darwin", "Australia/Brisbane", "Australia/Adelaide", "Australia/Sydney", "Australia/Lord_Howe", "Pacific/Noumea",
  "Pacific/Fiji", "Pacific/Auckland", "Pacific/Chatham", "Pacific/Tongatapu", "Pacific/Kiritimati",
];

/** Every zone grouped by its current offset, west to east, so each one is in exactly one band. */
export function timezoneBands(at: Date = new Date()): TimezoneBand[] {
  const byOffset = new Map<number, string[]>();
  for (const zone of allTimezones()) {
    const offset = offsetMinutes(zone, at);
    byOffset.set(offset, [...(byOffset.get(offset) ?? []), zone]);
  }
  return [...byOffset.entries()]
    .sort(([a], [b]) => a - b)
    .map(([offset, zones]) => ({
      offset,
      label: utcOffset(zones[0] ?? "UTC", at),
      zones,
      primary: WELL_KNOWN.find(zone => zones.includes(zone)) ?? zones[0] ?? "UTC",
    }));
}

/** This browser's time zone, if it's one we list. */
export function browserTimezone(): string | null {
  try {
    const zone = modernTimezone(new Intl.DateTimeFormat().resolvedOptions().timeZone);
    return allTimezones().includes(zone) ? zone : null;
  } catch {
    return null;
  }
}
