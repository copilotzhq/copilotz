/**
 * The orgs host's cookies from before they were the host's alone (`dir`,
 * `org`, `s_<org>`, now `__Host-` ones over https). On connecting and on
 * signing out, a session a browser still holds under a plain name ends
 * where it lives (the directory's, the org's), so a host reading the plain
 * names again (rolled back) finds no one, and the cookie goes. Signing out
 * ends every org session it holds too, not only the directory's.
 */
import { assertEquals } from "@std/assert";
import { type Actor, createRuntime, type Runtime } from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import { identity } from "../../../plugins/access/identity/mod.ts";
import { spaces } from "../../../plugins/access/spaces/mod.ts";
import { devSignIn } from "../../../plugins/access/dev/mod.ts";
import { directory } from "../../../plugins/access/directory/mod.ts";
import { test } from "../../../testing/mod.ts";
import { setClientAddress } from "../../web/address.ts";
import { orgsHost } from "../mod.ts";

const SITE = "https://localhost:8800";

test("orgs over https: sessions under the plain names from before end and go, on connecting and signing out", async () => {
  const dir = await createRuntime({
    store: memoryStore(),
    plugins: [identity, directory, devSignIn],
  });
  const host = orgsHost({
    directory: dir,
    open: async (_org, given) =>
      await createRuntime({
        store: memoryStore(),
        plugins: [spaces, identity, ...given.plugins],
        admit: given.admit,
      }),
    upgrade: () => new Response(null, { status: 503 }),
    code: { entry: "app.js", files: { "app.js": "" } },
  });
  try {
    const send = (method: string, path: string, cookie = "", body?: unknown) =>
      host.serve(setClientAddress(
        new Request(SITE + path, {
          method,
          headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
        "127.0.0.1",
      ));
    const jarOf = (answer: Response) =>
      Object.fromEntries(answer.headers.getSetCookie().map((c) => c.split(";")[0].split("=")));
    const cleared = (answer: Response) =>
      answer.headers.getSetCookie().filter((c) => /Max-Age=0/.test(c)).map((c) => c.split("=")[0])
        .sort();

    const signed = await send("POST", "/signin/dev", "", { name: "ana@example.com" });
    const { org } = await signed.json() as { org: { id: string } };
    const jar = jarOf(signed);
    const now = Object.entries(jar).map(([n, v]) => `${n}=${v}`).join("; ");
    const orgRt = (await host.runtime(org.id)) as Runtime;
    const ana = "ana@example.com";
    const sessions = async () => ({
      dir: (await dir.call<{ session: string }>("session.start", { person: ana })).session,
      org: (await orgRt.call<{ session: string }>("session.start", { person: ana })).session,
    });
    const at = (rt: Runtime, secret: string) =>
      rt.query<Actor | null>("credential.actor", { secret }).then((a) => a?.id ?? null);
    const plain = (old: { dir: string; org: string }) =>
      `dir=${old.dir}; org=${org.id}; s_${org.id}=${old.org}`;

    // Connecting, the plain ones beside the current: she's who she is; the plain ones end and go.
    const old = await sessions();
    const connected = await send("POST", "/connect", `${plain(old)}; ${now}`);
    assertEquals((await connected.json()).actor, { kind: "person", id: ana });
    console.log(`connecting with the plain cookies clears: ${cleared(connected)}`);
    assertEquals(cleared(connected), ["dir", "org", `s_${org.id}`]);
    assertEquals([await at(dir, old.dir), await at(orgRt, old.org)], [null, null]);
    assertEquals(
      [await at(dir, jar["__Host-dir"]), await at(orgRt, jar[`__Host-s_${org.id}`])],
      [ana, ana],
    );

    // Signing out: every one goes, and every session ends, the org's too.
    const older = await sessions();
    const out = await send("POST", "/signout", `${plain(older)}; ${now}`);
    console.log(`signing out clears: ${cleared(out)}`);
    assertEquals(cleared(out), [
      "__Host-dir",
      "__Host-org",
      `__Host-s_${org.id}`,
      "dir",
      "org",
      `s_${org.id}`,
    ]);
    assertEquals(
      [
        await at(dir, older.dir),
        await at(orgRt, older.org),
        await at(dir, jar["__Host-dir"]),
        await at(orgRt, jar[`__Host-s_${org.id}`]),
      ],
      [null, null, null, null],
    );
  } finally {
    await host.close();
    await dir.close();
  }
});
