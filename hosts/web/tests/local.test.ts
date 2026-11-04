/**
 * This machine, and the network it's on. What only this machine may do
 * (dev sign-in) goes by the socket's address and the host together, never a
 * header. Over plain http to this machine or a LAN host (a private address,
 * a `.local` name), cookies aren't Secure (a browser would drop them there)
 * and a page there is the app's own; anywhere else, and wherever the app's
 * front says the request is for a public host, they're Secure, and a host's
 * own cookies are `__Host-` ones.
 */
import { assert, assertEquals } from "@std/assert";
import { createRuntime } from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import { identity } from "../../../plugins/access/mod.ts";
import { test } from "../../../testing/mod.ts";
import { setClientAddress } from "../address.ts";
import { fromHere, fromPage, hostCookie, nearby, setCookie, siteOf } from "../entrances.ts";
import { createTickets } from "../tickets.ts";
import { webServer } from "../server.ts";

const FRONT = { secret: "front-secret-0123456789abcdef" };

test("this machine's: its socket's address and the host, both, never a header", () => {
  const at = (url: string, address?: string, headers: Record<string, string> = {}) => {
    const request = new Request(url, { headers });
    return fromHere(address ? setClientAddress(request, address) : request, FRONT);
  };
  assert(at("http://localhost:8790/", "127.0.0.1"));
  assert(at("http://127.0.0.1:8790/", "::1"));
  assert(at("http://[::1]:8790/", "::ffff:127.0.0.1"));
  // `Host: localhost` from another machine, or from nowhere anyone said.
  assert(!at("http://localhost:8790/", "192.168.1.20"));
  assert(!at("http://localhost:8790/"));
  // From this machine, to a name that isn't its own (a page rebinding its name here).
  assert(!at("http://evil.example/", "127.0.0.1"));
  assert(!at("http://192.168.1.20:8790/", "127.0.0.1"));
  // The front's word for the host is its secret's: a public host isn't this machine.
  assert(
    !at("http://localhost:8790/", "127.0.0.1", {
      "x-copilotz-front": FRONT.secret,
      "x-forwarded-host": "app.example.com",
    }),
  );
});

test("plain http to this machine or a LAN host: no Secure, so a browser keeps the cookies", () => {
  const secure = (url: string) => setCookie(new URL(url), "v", 60, "n").endsWith("; Secure");
  for (
    const url of [
      "http://localhost:8790",
      "http://127.0.0.1:8790",
      "http://[::1]:8790",
      "http://10.0.0.7:8080",
      "http://172.16.4.2:8080",
      "http://172.31.255.1:8080",
      "http://192.168.1.20:8080",
      "http://169.254.1.1:8080",
      "http://[fd12:3456::1]:8080",
      "http://[fe80::1]:8080",
      "http://studio.local:8080",
    ]
  ) {
    assert(!secure(url), url);
    assertEquals(hostCookie(new URL(url), "session"), "session", url);
  }
  for (
    const url of [
      "https://localhost:8790",
      "https://192.168.1.20",
      "http://app.example.com",
      "http://8.8.8.8",
      "http://172.32.0.1",
      "http://11.0.0.1",
      "http://[2001:db8::1]",
      "http://local.example.com",
    ]
  ) {
    assert(secure(url), url);
    assertEquals(hostCookie(new URL(url), "session"), "__Host-session", url);
  }
  assert(nearby("studio.local") && !nearby("studio.local.example.com"));
});

test("behind the front, the host it says is the one cookies go by, though the app's is private", () => {
  const inside = "http://10.0.0.7:8080/connect";
  const vouched = new Request(inside, {
    headers: { "x-copilotz-front": FRONT.secret, "x-forwarded-host": "app.example.com" },
  });
  assertEquals(siteOf(vouched, FRONT).host, "app.example.com");
  assertEquals(hostCookie(siteOf(vouched, FRONT), "session"), "__Host-session");
  assertEquals(
    setCookie(siteOf(vouched, FRONT), "v", 60, "n").endsWith("; Secure"),
    true,
  );
  // Without the secret, the forwarded host is no one's word: it's the private address it reached.
  const forged = new Request(inside, { headers: { "x-forwarded-host": "app.example.com" } });
  assertEquals(siteOf(forged, FRONT).host, "10.0.0.7:8080");
  assertEquals(hostCookie(siteOf(forged, FRONT), "session"), "session");
});

test("a page over plain http on a LAN host is the app's own; elsewhere, only over https", () => {
  const from = (url: string, origin: string) =>
    fromPage(new Request(url, { method: "POST", headers: { origin } }));
  assert(from("http://192.168.1.20:8080/connect", "http://192.168.1.20:8080"));
  assert(from("http://studio.local:8080/connect", "http://studio.local:8080"));
  assert(from("http://[fe80::1]:8080/connect", "http://[fe80::1]:8080"));
  // Its host is still this one.
  assert(!from("http://192.168.1.20:8080/connect", "http://192.168.1.21:8080"));
  assert(!from("http://192.168.1.20:8080/connect", "http://192.168.1.20:9999"));
  // Plain http anywhere else isn't a page of the app's.
  assert(!from("http://app.example.com/connect", "http://app.example.com"));
  assert(!from("http://8.8.8.8/connect", "http://8.8.8.8"));
});

test("over plain http on a LAN host, a session's cookie is kept, read and cleared", async () => {
  const rt = await createRuntime({ store: memoryStore(), plugins: [identity] });
  try {
    const serve = webServer({ runtime: rt, tickets: createTickets() });
    const { session } = await rt.call<{ session: string }>("session.start", { person: "ana" });
    const lan = "http://192.168.1.20:8080";
    const post = (path: string) =>
      serve(
        new Request(lan + path, {
          method: "POST",
          headers: { origin: lan, cookie: `session=${session}` },
        }),
      );
    const connected = await post("/connect");
    assertEquals((await connected.json()).actor, { kind: "person", id: "ana" });
    const out = await post("/signout");
    const cleared = out.headers.get("set-cookie")!;
    assert(cleared.startsWith("session=; ") && !cleared.includes("Secure"), cleared);
    assertEquals((await post("/connect")).status, 401);
  } finally {
    await rt.close();
  }
});
