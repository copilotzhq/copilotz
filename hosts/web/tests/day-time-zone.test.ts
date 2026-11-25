/**
 * A wall-clock time's moment in a time zone, by one rule wherever the clocks change: a time they
 * skip moves forward by the gap, and a time they repeat is its first pass (Temporal's
 * "compatible", which `new Date(y, m, d, h, mi, s)` follows in the page's zone). A named zone and
 * the page's own agree, minute by minute through every change of several zones.
 */
import process from "node:process";
import { assert, assertEquals, assertThrows } from "@std/assert";
import { runtime, test } from "../../../testing/mod.ts";
import { dateOfDayTime } from "../toolkit/day-time-zone.ts";

const at = (value: string, zone?: string) => dateOfDayTime(value, zone)?.toISOString();

test("a day-time's moment in a zone, and a day's at its start", () => {
  assertEquals(at("2026-11-16 14:30", "America/Sao_Paulo"), "2026-11-16T17:30:00.000Z");
  assertEquals(at("2026-11-16 14:30:05", "UTC"), "2026-11-16T14:30:05.000Z");
  assertEquals(at("2026-11-16", "Asia/Tokyo"), "2026-11-15T15:00:00.000Z");
  assertEquals(at("2026-07-01 12:00", "America/New_York"), "2026-07-01T16:00:00.000Z");
  assertEquals(at("2026-01-15 12:00", "America/New_York"), "2026-01-15T17:00:00.000Z");
  assertEquals(at("2026-11-16 09:00", "Asia/Kolkata"), "2026-11-16T03:30:00.000Z");
  assertEquals(at("0000-01-01", "UTC"), "0000-01-01T00:00:00.000Z");
  assertEquals(at("9999-12-31 23:59:59", "UTC"), "9999-12-31T23:59:59.000Z");
  for (const wrong of ["2026-02-30 10:00", "2026-11-16 24:00", "2026-11-16T14:30", "soon", ""]) {
    assertEquals(dateOfDayTime(wrong, "UTC"), undefined, wrong);
  }
  assertThrows(() => dateOfDayTime("2026-11-16 14:30", "Mars/Olympus_Mons"), RangeError);
});

test("skipped times move forward by the gap; repeated times are their first pass", () => {
  // New York springs forward at 02:00 and falls back at 02:00.
  assertEquals(at("2026-03-08 02:30", "America/New_York"), "2026-03-08T07:30:00.000Z");
  assertEquals(at("2026-03-08 01:59:59", "America/New_York"), "2026-03-08T06:59:59.000Z");
  assertEquals(at("2026-03-08 03:00", "America/New_York"), "2026-03-08T07:00:00.000Z");
  assertEquals(at("2026-11-01 01:30", "America/New_York"), "2026-11-01T05:30:00.000Z");
  // São Paulo's 2018 change skipped midnight: the day starts at 01:00.
  assertEquals(at("2018-11-04", "America/Sao_Paulo"), "2018-11-04T03:00:00.000Z");
  // Lord Howe moves half an hour.
  assertEquals(at("2026-10-04 02:15", "Australia/Lord_Howe"), "2026-10-03T15:45:00.000Z");
  assertEquals(at("2026-04-05 01:45", "Australia/Lord_Howe"), "2026-04-04T14:45:00.000Z");
  // Samoa skipped 30 December 2011 whole.
  assertEquals(at("2011-12-30 12:00", "Pacific/Apia"), "2011-12-30T22:00:00.000Z");
});

/** A zone's wall clock at an instant, as `YYYY-MM-DD HH:mm:ss`. */
function wallIn(zone: string, ms: number): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

const asUtc = (wall: string) => Date.parse(wall.replace(" ", "T") + "Z");
const offsetAt = (zone: string, ms: number) => asUtc(wallIn(zone, ms)) - ms;

/** The instants a zone's offset changes in a year, to the second. */
function changes(zone: string, year: number): number[] {
  const out: number[] = [];
  const end = Date.UTC(year + 1, 0, 1);
  for (let t = Date.UTC(year, 0, 1); t < end; t += 86400e3) {
    if (offsetAt(zone, t) === offsetAt(zone, t + 86400e3)) continue;
    let [lo, hi] = [t, t + 86400e3];
    while (hi - lo > 1000) {
      const mid = lo + Math.floor((hi - lo) / 2000) * 1000;
      if (offsetAt(zone, mid) === offsetAt(zone, lo)) lo = mid;
      else hi = mid;
    }
    out.push(hi);
  }
  return out;
}

const ZONES: [string, number][] = [
  ["America/New_York", 2026],
  ["Europe/London", 2026],
  ["America/Sao_Paulo", 2018],
  ["Australia/Lord_Howe", 2026],
  ["Pacific/Apia", 2011],
  ["Pacific/Chatham", 2026],
  ["Asia/Kolkata", 2026],
];

/**
 * Wall times through each change, every five minutes from two hours before it to two hours after
 * it, and a second and a minute either side of each wall time the change starts or ends on.
 */
const around = new Map<string, string[]>();
function wallsAround(zone: string, year: number): string[] {
  if (around.has(zone)) return around.get(zone)!;
  const walls = new Set<string>();
  const add = (ms: number) => walls.add(new Date(ms).toISOString().slice(0, 19).replace("T", " "));
  const instants = changes(zone, year);
  // A zone that doesn't change: a day of it.
  if (!instants.length) instants.push(Date.UTC(year, 5, 1));
  for (const change of instants) {
    const [before, after] = [offsetAt(zone, change - 1000), offsetAt(zone, change)];
    const from = change + Math.min(before, after) - 2 * 3600e3;
    const to = change + Math.max(before, after) + 2 * 3600e3;
    for (let w = from; w <= to; w += 300e3) add(w);
    for (const edge of [change + before, change + after]) {
      for (const step of [-60e3, -1000, 0, 1000, 60e3]) add(edge + step);
    }
  }
  around.set(zone, [...walls]);
  return around.get(zone)!;
}

test("every wall time through each change: one rule, as the zone's clock shows it", () => {
  for (const [zone, year] of ZONES) {
    for (const wall of wallsAround(zone, year)) {
      const moment = dateOfDayTime(wall, zone)!.getTime();
      const w = asUtc(wall);
      const shown = [w - offsetAt(zone, w - 86400e3), w - offsetAt(zone, w + 86400e3)]
        .filter((t) => wallIn(zone, t) === wall);
      if (shown.length) {
        // A time the clock shows: its first instant.
        assertEquals(moment, Math.min(...shown), `${zone} ${wall}`);
      } else {
        // A skipped time: the offset from before the change, so the clock shows it later by the gap.
        const gap = offsetAt(zone, w + 86400e3) - offsetAt(zone, w - 86400e3);
        assertEquals(moment, w - offsetAt(zone, w - 86400e3), `${zone} ${wall}`);
        assertEquals(asUtc(wallIn(zone, moment)), w + gap, `${zone} ${wall}`);
      }
    }
  }
});

/** Whether this runtime's `Date` follows the page's zone as changed, and the spec's rule. */
function dateFollows(zone: string): boolean {
  if (Intl.DateTimeFormat().resolvedOptions().timeZone !== zone) return false;
  return zone !== "America/New_York" ||
    new Date(2026, 2, 8, 2, 30).toISOString() === "2026-03-08T07:30:00.000Z";
}

test("the page's zone and a named one agree, and agree with the page's own Date", () => {
  const original = process.env.TZ;
  let checked = 0;
  try {
    for (const [zone, year] of ZONES) {
      process.env.TZ = zone;
      const oracle = dateFollows(zone);
      for (const wall of wallsAround(zone, year)) {
        const named = dateOfDayTime(wall, zone)!.getTime();
        assertEquals(dateOfDayTime(wall)!.getTime(), named, `${zone} ${wall}, no zone given`);
        if (!oracle) continue;
        const [y, m, d, h, mi, s] = wall.split(/[- :]/).map(Number);
        assertEquals(new Date(y, m - 1, d, h, mi, s).getTime(), named, `${zone} ${wall}, Date`);
        checked++;
      }
    }
    // Deno's and Node's Date follow a changed TZ, so there the oracle ran for every zone.
    if (runtime !== "bun") assert(checked > 1_000, `${checked} walls checked against Date`);
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});
