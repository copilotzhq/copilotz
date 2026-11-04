/**
 * Signed links: one opens until it expires, and changing anything in it, or
 * signing with another secret, breaks it.
 */
import { assert, assertEquals, assertThrows } from "@std/assert";
import { createRuntime, definePlugin, linksOf, signLink, verifyLink } from "../mod.ts";
import { memoryStore } from "../../stores/memory/mod.ts";
import { webServer } from "../../hosts/web/server.ts";
import { createTickets } from "../../hosts/web/tickets.ts";
import { test } from "../../testing/mod.ts";

const links = { origin: "https://app.example", secret: "a-secret-only-the-app-has-32-bytes!" };

const opened = (link: string) => {
  const url = new URL(link);
  return [url.pathname, Object.fromEntries(url.searchParams)] as const;
};

test("a signed link opens with its params, until it expires", async () => {
  const link = await signLink(links, "/media/trip-card", { trip: "123", seat: "12A" });
  assertEquals(link.startsWith("https://app.example/media/trip-card?"), true);
  const [path, query] = opened(link);
  assertEquals(await verifyLink(links, path, query), { trip: "123", seat: "12A" });
  // An hour, unless said.
  const left = Number(query.exp) * 1000 - Date.now();
  assert(left > 3_500_000 && left <= 3_600_000, String(left));
  // Changed, moved, signed with another secret, for another app (or org), or past its time: nothing.
  assertEquals(await verifyLink(links, path, { ...query, trip: "124" }), undefined);
  assertEquals(await verifyLink(links, "/media/other", query), undefined);
  assertEquals(
    await verifyLink({ ...links, secret: "another-secret-also-32-bytes-long!" }, path, query),
    undefined,
  );
  assertEquals(
    await verifyLink({ ...links, origin: "https://app.example/o/other" }, path, query),
    undefined,
  );
  assertEquals(await verifyLink(links, path, { ...query, sig: "nope" }), undefined);
  // Where the origin ends and the path begins is part of what's signed.
  const moved = { origin: "https://app.example/media", secret: links.secret };
  assertEquals(await verifyLink(moved, "/trip-card", query), undefined);
  const [, old] = opened(await signLink(links, "/media/trip-card", { trip: "123" }, -1_000));
  assertEquals(await verifyLink(links, path, old), undefined);
});

test("the app's links: an origin and a secret of 32 bytes or more, or none", () => {
  assertEquals(linksOf({ links: { origin: "https://app.example/", secret: links.secret } }), {
    origin: "https://app.example",
    secret: links.secret,
  });
  assertThrows(
    () => linksOf({ links: { origin: "https://app.example", secret: "too-short" } }),
    Error,
    "at least 32 bytes",
  );
  assertEquals(linksOf({ links: { origin: "https://app.example" } }), undefined);
  assertEquals(linksOf({}), undefined);
});

test("a web server with a links secret too short refuses to start, rather than fail each file", async () => {
  const runtime = await createRuntime({
    store: memoryStore(),
    plugins: [definePlugin({
      name: "short",
      resources: { links: { origin: "https://app.example", secret: "short" } },
    })],
  });
  try {
    assertThrows(
      () =>
        webServer({
          runtime,
          tickets: createTickets(),
          code: { entry: "app.js", files: { "app.js": "" } },
          upgrade: () => new Response(null, { status: 299 }),
        }),
      Error,
      "at least 32 bytes",
    );
  } finally {
    await runtime.close();
  }
});
