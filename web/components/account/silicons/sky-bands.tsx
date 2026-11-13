"use client";

/**
 * Sky bands (Anil, 2026-11-07): choosing a time zone by the sky. A strip of the world, west to east, painted with the sky
 * each offset has right now, with a band for every offset and the land in dots. A click goes by place (lib/zone-at.ts). The
 * strip is a picture that takes a click, hidden from assistive tech: the Combobox under it serves keyboards and screen
 * readers. The Combobox under it
 * is the one place the zone is written, and reaches every other zone.
 */
import { useEffect, useMemo, useState, type MouseEvent } from "react";
import { localMinutes, skyColor, skyInk } from "@/lib/sky";
import { offsetMinutes, timezoneBands, type TimezoneBand } from "@/lib/timezones";
import { WORLD_DOTS } from "@/lib/world-dots";
import { zoneAt } from "@/lib/zone-at";
import styles from "./sky-bands.module.css";

/** The strip runs from UTC-12 to UTC+14. */
const WEST = -12 * 60;
const EAST = 14 * 60;
const SPAN = EAST - WEST;
const MINUTE = 60_000;
/** Where the map sits in the strip, as .land in the CSS: it starts at 80°N and spans 140° of latitude. */
const LAND_TOP = 0.18;
const LAND_HEIGHT = 0.64;

const place = (offset: number) => ((offset - WEST) / SPAN) * 100;

/** The land as one path of round dots. A degree of longitude is 4 minutes of offset, so the dots line up with the bands. */
const DOTS = WORLD_DOTS.flatMap((row, y) => [...row].flatMap((cell, x) => {
  if (cell !== "1") return [];
  const longitude = -180 + ((x + 0.5) / row.length) * 360;
  return [`M${place(longitude * 4).toFixed(2)} ${(((y + 0.5) / WORLD_DOTS.length) * 100).toFixed(2)}h0`];
})).join("");

function nearest(bands: TimezoneBand[], offset: number): TimezoneBand | undefined {
  return bands.reduce<TimezoneBand | undefined>((best, band) => (!best || Math.abs(band.offset - offset) < Math.abs(best.offset - offset) ? band : best), undefined);
}

export function SkyBands({ value, onChange }: { value: string; onChange: (timeZone: string) => void }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), MINUTE);
    return () => window.clearInterval(timer);
  }, []);

  const bands = useMemo(() => timezoneBands(now), [now]);
  const selected = nearest(bands, offsetMinutes(value, now));
  const sky = useMemo(() => {
    const stops = bands.map(band => `${skyColor(localMinutes(band.offset, now))} ${place(band.offset).toFixed(2)}%`);
    return `linear-gradient(90deg, ${stops.join(", ")})`;
  }, [bands, now]);

  const edges = (band: TimezoneBand) => {
    const index = bands.indexOf(band);
    const west = index > 0 ? (bands[index - 1]!.offset + band.offset) / 2 : WEST;
    const east = index < bands.length - 1 ? (band.offset + bands[index + 1]!.offset) / 2 : EAST;
    return { left: `${place(west)}%`, width: `${place(east) - place(west)}%` };
  };

  const pick = (band: TimezoneBand | undefined) => {
    if (band && band !== selected) onChange(band.primary);
  };
  // A click means a place: the zone for that spot in that country. Out at sea it means the band.
  const onStrip = (event: MouseEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const offset = WEST + ((event.clientX - box.left) / box.width) * SPAN;
    const down = ((event.clientY - box.top) / box.height - LAND_TOP) / LAND_HEIGHT;
    const zone = zoneAt(offset / 4, 80 - down * 140, now);
    if (zone) onChange(zone);
    else pick(nearest(bands, offset));
  };
  return (
    <div className={styles.root}>
        <div className={styles.strip} style={{ backgroundImage: sky }} onClick={onStrip} aria-hidden="true">
          <svg className={styles.land} viewBox="0 0 100 100" preserveAspectRatio="none">
            <defs>
              <linearGradient id="sky-land" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="100" y2="0">
                {bands.map(band => <stop key={band.offset} offset={`${place(band.offset)}%`} style={{ stopColor: skyInk(localMinutes(band.offset, now)) }} />)}
              </linearGradient>
            </defs>
            <path d={DOTS} stroke="url(#sky-land)" />
          </svg>
          {selected ? <span className={styles.selected} style={edges(selected)} /> : null}
        </div>
    </div>
  );
}
