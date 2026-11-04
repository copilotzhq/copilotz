/**
 * Signed links: one opens until it expires, and changing anything in it, or
 * signing with another secret, breaks it.
 */
import { assertEquals } from "@std/assert";
import { linksOf, signLink, verifyLink } from "../mod.ts";
import { test } from "../../testing/mod.ts";

const links = { origin: "https://app.example", secret: "a-secret-only-the-app-has" };

const opened = (link: string) => {
  const url = new URL(link);
  return [url.pathname, Object.fromEntries(url.searchParams)] as const;
};

test("a signed link opens with its params, until it expires", async () => {
  const link = await signLink(links, "/media/trip-card", { trip: "123", seat: "12A" });
  assertEquals(link.startsWith("https://app.example/media/trip-card?"), true);
  const [path, query] = opened(link);
  assertEquals(await verifyLink(links.secret, path, query), { trip: "123", seat: "12A" });
  // Changed, moved, signed with another secret, or past its time: nothing.
  assertEquals(await verifyLink(links.secret, path, { ...query, trip: "124" }), undefined);
  assertEquals(await verifyLink(links.secret, "/media/other", query), undefined);
  assertEquals(await verifyLink("another-secret", path, query), undefined);
  assertEquals(await verifyLink(links.secret, path, { ...query, sig: "nope" }), undefined);
  const [, old] = opened(await signLink(links, "/media/trip-card", { trip: "123" }, -1_000));
  assertEquals(await verifyLink(links.secret, path, old), undefined);
});

test("the app's links: an origin and a secret, or none", () => {
  assertEquals(linksOf({ links: { origin: "https://app.example/", secret: "s" } }), {
    origin: "https://app.example",
    secret: "s",
  });
  assertEquals(linksOf({ links: { origin: "https://app.example" } }), undefined);
  assertEquals(linksOf({}), undefined);
});
