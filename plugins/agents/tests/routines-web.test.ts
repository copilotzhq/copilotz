/**
 * Routines on the web, their logic: how one stands (on, paused, done,
 * failing, unable to run as its maker), what the schedule picker starts
 * with and gives back (each kind, and a schedule read back into it), the
 * examples an empty tab offers (each a schedule that reads), and the paths
 * to a routine, its space's tab and its chats.
 */
import { assertEquals } from "@std/assert";
import { normalize, type Schedule } from "../routines/shared/schedule.ts";
import {
  EXAMPLES,
  givenOf,
  picking,
  routinePath,
  routinesTab,
  standingOf,
  threadPath,
} from "../routines/views/web/routines.ts";
import { test } from "../../../testing/mod.ts";

test("how a routine stands", () => {
  const at = "2026-11-02T09:00:00.000Z";
  const on = { left: false, next: at };
  assertEquals(standingOf(on).key, "set");
  assertEquals(standingOf({ ...on, paused: at }).key, "paused");
  assertEquals(standingOf({ left: false }).key, "done");
  assertEquals(standingOf({ ...on, last: { at, outcome: "failed" } }).key, "failing");
  assertEquals(standingOf({ ...on, last: { at, outcome: "sent" } }).key, "set");
  // Its maker gone outweighs everything else.
  assertEquals(standingOf({ ...on, left: true, paused: at }), {
    key: "left",
    label: "Can't run",
    tone: "destructive",
  });
});

test("the schedule picker: what it starts with, and each schedule read back into it", () => {
  const now = Date.parse("2026-11-02T08:00:00.000Z");
  const fresh = picking("Europe/Lisbon", undefined, now);
  assertEquals(givenOf(fresh), { kind: "weekdays", time: "09:00", timezone: "Europe/Lisbon" });
  // A once starts tomorrow at nine, where they are.
  assertEquals(givenOf({ ...fresh, kind: "once" }), {
    kind: "once",
    at: "2026-11-03T09:00",
    timezone: "Europe/Lisbon",
  });
  const schedules: Schedule[] = [
    { kind: "daily", time: "07:30", timezone: "UTC" },
    { kind: "weekdays", time: "09:00", timezone: "Asia/Tokyo" },
    { kind: "weekly", days: [1, 4], time: "17:00", timezone: "Europe/Lisbon" },
    { kind: "hours", every: 6 },
    { kind: "once", at: "2026-12-24T18:00:00.000Z", timezone: "America/New_York" },
    { kind: "cron", cron: "0 9 1 * *", timezone: "UTC" },
  ];
  for (const s of schedules) {
    assertEquals(normalize(givenOf(picking("UTC", s, now)), now), s, s.kind);
  }
  // Switching kinds keeps what the others had.
  const switched = { ...picking("UTC", schedules[2], now), kind: "daily" as const };
  assertEquals(givenOf(switched), { kind: "daily", time: "17:00", timezone: "Europe/Lisbon" });
});

test("the examples an empty tab offers each read as a schedule, and the paths", () => {
  for (const example of EXAMPLES) {
    normalize(givenOf({ ...picking("UTC"), ...example.when }));
  }
  assertEquals(routinePath("r 1"), "/routine/r%201");
  assertEquals(routinePath("r1", true), "/routine/r1?edit=1");
  assertEquals(routinesTab("s1"), "/space/s1?tab=routines");
  assertEquals(threadPath("t1", "s 1"), "/thread/t1?in=s%201");
  assertEquals(threadPath("t1"), "/thread/t1");
});
