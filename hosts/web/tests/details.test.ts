/**
 * What a detail page says: a field's name as people read it (`humanize`),
 * and when something happened, or will, in words (`ago`, `long`).
 */
import { assertEquals } from "@std/assert";
import { humanize } from "../toolkit/humanize.ts";
import { ago } from "../toolkit/ago.ts";
import { test } from "../../../testing/mod.ts";

test("a field's label: its last part, in words; a time's trailing at goes; initials stay", () => {
  const cases: [string, string][] = [
    ["createdAt", "Created"],
    ["updated_at", "Updated"],
    ["expiresOn", "Expires"],
    ["tags.thread", "Thread"],
    ["source.messageId", "Message ID"],
    ["_id", "ID"],
    ["id", "ID"],
    ["place_id", "Place ID"],
    ["max_tokens", "Max tokens"],
    ["homepage-url", "Homepage URL"],
    ["APIKey", "API key"],
    ["at", "When"],
    ["in", "In"],
    ["core", "Core"],
  ];
  for (const [field, label] of cases) assertEquals(humanize(field), label, field);
});

test("ago: short for lists, long for details, and ahead for what's to come", () => {
  const now = new Date(2026, 9, 28, 15, 0).getTime();
  const at = (minutes: number) => new Date(now + minutes * 60_000);
  assertEquals(ago(at(0), now), "now");
  assertEquals(ago(at(0), now, true), "just now");
  assertEquals(ago(at(-1), now, true), "1 minute ago");
  assertEquals(ago(at(-5), now), "5m");
  assertEquals(ago(at(-5), now, true), "5 minutes ago");
  assertEquals(ago(at(-180), now), "3h");
  assertEquals(ago(at(-180), now, true), "3 hours ago");
  assertEquals(ago(at(-60 * 24), now), "Yesterday");
  assertEquals(ago(at(5), now, true), "in 5 minutes");
  assertEquals(ago(at(120), now), "in 2h");
  assertEquals(ago(at(60 * 24), now), "Tomorrow");
  assertEquals(ago(new Date(2026, 10, 14), now), ago(new Date(2026, 10, 14), now, true));
  assertEquals(ago(new Date(2026, 10, 14), now).includes("14"), true);
});
