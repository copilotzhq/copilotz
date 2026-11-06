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
import {
  createRuntime,
  definePlugin,
  nearby,
  type Runtime,
  setClientAddress,
} from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import { identity } from "../../../plugins/access/mod.ts";
import { fromHere } from "../../../plugins/access/dev/shared/here.ts";
import { test } from "../../../testing/mod.ts";

const FRONT = { secret: "front-secret-0123456789abcdef" };

/** An app with identity, behind a front. */
const front = definePlugin({ name: "front", resources: { caller: { front: FRONT.secret } } });

async function setup(fn: (runtime: Runtime) => Promise<void>) {
  const runtime = await createRuntime({ store: memoryStore(), plugins: [identity, front] });
  try {
    await fn(runtime);
  } finally {
    await runtime.close();
  }
}

/** The cookie a sign-out clears at `url`, as its `Set-Cookie` says (the host's rules for it). */
async function clearing(runtime: Runtime, url: string, headers: Record<string, string> = {}) {
  const out = await runtime.fetch(new Request(url, { method: "POST", headers }));
  await out.body?.cancel();
  return out.headers.get("set-cookie")!;
}

test("this machine's: its socket's address and the host, both, never a header", () => {
  const at = (url: string, address?: string, headers: Record<string, string> = {}) => {
    const request = new Request(url, { headers });
    return fromHere(address ? setClientAddress(request, address) : request);
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
  // Behind a front or a proxy, a public host isn't this machine, and nothing forwarded is.
  assert(
    !at("http://localhost:8790/", "127.0.0.1", {
      "x-copilotz-front": FRONT.secret,
      "x-forwarded-host": "app.example.com",
    }),
  );
  assert(!at("http://localhost:8790/", "127.0.0.1", { "x-forwarded-for": "203.0.113.7" }));
});

test("plain http to this machine or a LAN host: no Secure, so a browser keeps the cookies", async () => {
  await setup(async (runtime) => {
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
      const cleared = await clearing(runtime, `${url}/signout`);
      assert(cleared.startsWith("session=; ") && !cleared.includes("Secure"), `${url}: ${cleared}`);
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
      const cleared = await clearing(runtime, `${url}/signout`);
      assert(cleared.startsWith("__Host-session=; ") && cleared.endsWith("; Secure"), `${url}`);
    }
  });
  assert(nearby("studio.local") && !nearby("studio.local.example.com"));
});

test("behind the front, the host it says is the one cookies go by, though the app's is private", async () => {
  await setup(async (runtime) => {
    const inside = "http://10.0.0.7:8080/signout";
    const vouched = await clearing(runtime, inside, {
      "x-copilotz-front": FRONT.secret,
      "x-forwarded-host": "app.example.com",
    });
    assert(vouched.startsWith("__Host-session=; ") && vouched.endsWith("; Secure"), vouched);
    // Without the secret, the forwarded host is no one's word: it's the private address it reached.
    const forged = await clearing(runtime, inside, { "x-forwarded-host": "app.example.com" });
    assert(forged.startsWith("session=; ") && !forged.includes("Secure"), forged);
  });
});

test("a page over plain http on a LAN host is the app's own; elsewhere, only over https", async () => {
  await setup(async (runtime) => {
    const from = async (url: string, origin: string) => {
      const answered = await runtime.fetch(
        new Request(url, { method: "POST", headers: { origin } }),
      );
      await answered.body?.cancel();
      return answered.status === 200;
    };
    assert(await from("http://192.168.1.20:8080/signout", "http://192.168.1.20:8080"));
    assert(await from("http://studio.local:8080/signout", "http://studio.local:8080"));
    assert(await from("http://[fe80::1]:8080/signout", "http://[fe80::1]:8080"));
    // Its host is still this one.
    assert(!await from("http://192.168.1.20:8080/signout", "http://192.168.1.21:8080"));
    assert(!await from("http://192.168.1.20:8080/signout", "http://192.168.1.20:9999"));
    // Plain http anywhere else isn't a page of the app's.
    assert(!await from("http://app.example.com/signout", "http://app.example.com"));
    assert(!await from("http://8.8.8.8/signout", "http://8.8.8.8"));
    // Behind the front, the page's origin is the host the front forwards, with its secret only.
    const forwarded = (headers: Record<string, string>) =>
      runtime.fetch(
        new Request("http://10.0.0.7:8080/signout", {
          method: "POST",
          headers: { origin: "https://app.example", "x-forwarded-host": "app.example", ...headers },
        }),
      );
    assertEquals((await forwarded({ "x-copilotz-front": FRONT.secret })).status, 200);
    assertEquals((await forwarded({})).status, 403);
  });
});

test("over plain http on a LAN host, a session's cookie is kept, read and cleared", async () => {
  await setup(async (rt) => {
    const { session } = await rt.call<{ session: string }>("session.start", { person: "ana" });
    const lan = "http://192.168.1.20:8080";
    const post = (path: string) =>
      rt.fetch(
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
  });
});
