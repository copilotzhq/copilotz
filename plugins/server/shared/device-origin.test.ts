import { assertEquals } from "@std/assert";
import { deviceOrigin } from "./device-origin.ts";

const upgrade = (url: string, origin?: string) =>
  new Request(url, { headers: origin ? { origin } : {} });

Deno.test("device origin: same host over a TLS-terminating edge is the same site", () => {
  const edge = "http://tenant.example.app/api/device";
  assertEquals(
    deviceOrigin(upgrade(edge, "https://tenant.example.app"), []),
    "cookie",
  );
  assertEquals(
    deviceOrigin(upgrade(edge, "http://tenant.example.app"), []),
    "cookie",
  );
  assertEquals(deviceOrigin(upgrade(edge), []), "header");
  // Foreign hosts, other ports and downgrades stay refused.
  assertEquals(deviceOrigin(upgrade(edge, "https://evil.example"), []), false);
  assertEquals(
    deviceOrigin(upgrade(edge, "https://tenant.example.app:8443"), []),
    false,
  );
  assertEquals(
    deviceOrigin(
      upgrade(
        "https://tenant.example.app/api/device",
        "http://tenant.example.app",
      ),
      [],
    ),
    false,
  );
  assertEquals(
    deviceOrigin(upgrade(edge, "https://app.example"), ["https://app.example"]),
    "cookie",
  );
});

Deno.test("device origin: the public host a trusted edge forwarded authenticates its own origin", () => {
  const edge = "http://service-abc.a.run.app/api/device";
  const host = "tenant.example.app";
  assertEquals(
    deviceOrigin(upgrade(edge, "https://tenant.example.app"), [], host),
    "cookie",
  );
  assertEquals(
    deviceOrigin(upgrade(edge, "https://tenant.example.app"), []),
    false,
  );
  assertEquals(
    deviceOrigin(upgrade(edge, "https://other.example.app"), [], host),
    false,
  );
  assertEquals(
    deviceOrigin(upgrade(edge, "https://tenant.example.app"), [], "bad host/x"),
    false,
  );
});
