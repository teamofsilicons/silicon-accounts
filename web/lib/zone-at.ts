/**
 * The time zone of a place on the map, from the hidden overlay in lib/zone-cells.ts: the country there, then that country's zone
 * for that spot. So a click in Gujarat is Kolkata though Karachi is at that longitude, and southern Africa is Johannesburg and
 * not Athens. Near a coast, the nearest land counts. Zones in one country that keep the same clock all year are one choice,
 * named after the best known, so Indiana reads as New York.
 */
import { allTimezones, offsetMinutes, WELL_KNOWN } from "./timezones";
import { ZONE_CELLS, ZONE_CELL_NAMES } from "./zone-cells";
import { ZONE_PLACES } from "./zone-places";

/** How far from a coast a click still counts as land, in degrees. */
const REACH = 3;

let cells: string[][] | undefined;

function grid(): string[][] {
  cells ??= ZONE_CELLS.map(row => [...row.matchAll(/(..)(\d+)/g)].flatMap(([, code, count]) => Array<string>(Number(count)).fill(code ?? "--")));
  return cells;
}

function zoneCell(row: number, column: number): string | null {
  const code = grid()[row]?.[((column % 360) + 360) % 360];
  if (!code || code === "--") return null;
  return ZONE_CELL_NAMES[(code.charCodeAt(0) - 65) * 26 + code.charCodeAt(1) - 65] ?? null;
}

/** The overlay's zone at a place, or the nearest land's within REACH; null out at sea. */
function cellAt(longitude: number, latitude: number): string | null {
  const row = Math.floor(80 - latitude);
  const column = Math.floor(longitude + 180);
  for (let ring = 0; ring <= REACH; ring += 1) {
    for (let down = -ring; down <= ring; down += 1) {
      for (let across = -ring; across <= ring; across += 1) {
        if (Math.max(Math.abs(down), Math.abs(across)) !== ring) continue;
        const zone = zoneCell(row + down, column + across);
        if (zone) return zone;
      }
    }
  }
  return null;
}

export function zoneAt(longitude: number, latitude: number, at: Date = new Date()): string | null {
  const zone = cellAt(longitude, latitude);
  if (!zone) return null;
  const country = ZONE_PLACES.find(place => place[0] === zone)?.[1];
  const year = at.getUTCFullYear();
  const winter = new Date(Date.UTC(year, 0, 15));
  const summer = new Date(Date.UTC(year, 6, 15));
  const clock = (name: string) => `${offsetMinutes(name, winter)} ${offsetMinutes(name, summer)}`;
  const listed = allTimezones();
  const sameClock = ZONE_PLACES.filter(place => place[1] === country && clock(place[0]) === clock(zone)).map(([name]) => name);
  return WELL_KNOWN.find(name => sameClock.includes(name)) ?? (listed.includes(zone) ? zone : sameClock.find(name => listed.includes(name)) ?? zone);
}
