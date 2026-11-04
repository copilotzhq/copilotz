/**
 * Signed links: one opens until it expires, and changing anything in it, or
 * signing with another secret, breaks it.
 */
import { assert, assertEquals, assertThrows } from "@std/assert";
import { createRuntime, definePlugin, keyOf, linksOf, signLink, verifyLink } from "../mod.ts";
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

test("links are signed with a key of their own, derived from the secret: never the secret itself", async () => {
  const link = await signLink(links, "/files/f1");
  const [path, query] = opened(link);
  // What the secret itself signs (HMAC with it, as links once were) opens nothing.
  const raw = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(links.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const text = `${links.origin}\n${path}?exp=${query.exp}`;
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", raw, new TextEncoder().encode(text)));
  const sig = btoa(String.fromCharCode(...mac)).replaceAll("+", "-").replaceAll("/", "_")
    .replace(/=+$/, "");
  assertEquals(await verifyLink(links, path, { ...query, sig }), undefined);
  // Nor does what another use's key signs (a visitor's cookie, say).
  const other = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      await keyOf(links.secret, "visitors"),
      new TextEncoder().encode(text),
    ),
  );
  const otherSig = btoa(String.fromCharCode(...other)).replaceAll("+", "-").replaceAll("/", "_")
    .replace(/=+$/, "");
  assertEquals(await verifyLink(links, path, { ...query, sig: otherSig }), undefined);
  assertEquals(await verifyLink(links, path, query), {});
});

test("a new secret, the old one as previous: what the old one signed still opens, only the new one signs", async () => {
  const before = await signLink(links, "/files/f1");
  const rotated = {
    ...links,
    secret: "the-new-secret-the-app-has-32-bytes!",
    previous: links.secret,
  };
  const [path, query] = opened(before);
  assertEquals(await verifyLink(rotated, path, query), {});
  const after = await signLink(rotated, "/files/f1");
  const [, signed] = opened(after);
  assertEquals(await verifyLink({ ...rotated, previous: undefined }, path, signed), {});
  assertEquals(await verifyLink(links, path, signed), undefined);
  // The old one dropped: what it signed opens no more.
  assertEquals(await verifyLink({ ...rotated, previous: undefined }, path, query), undefined);
  assertThrows(
    () => linksOf({ links: { ...links, previous: "too-short" } }),
    Error,
    "links.previous is at least 32 bytes",
  );
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
