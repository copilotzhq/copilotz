/**
 * Dev sign-in, from this machine: a name is a person by that id, an email a
 * person with that email; and someone already there (moved in from another
 * app under an id of its own) is signed in by their email or their id, as
 * they are: nothing about them changes.
 */
import { assertEquals } from "@std/assert";
import { createRuntime, type Runtime, setClientAddress } from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import { access, devSignIn } from "../mod.ts";
import { test } from "../../../testing/mod.ts";

/** Signs in by name from this machine: who the session's cookie proves. */
async function signIn(rt: Runtime, name: string) {
  const answer = await rt.fetch(setClientAddress(
    new Request("http://localhost/signin/dev", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    }),
    "127.0.0.1",
  ));
  const cookie = answer.headers.get("set-cookie")!.split(";")[0];
  return await rt.query("credential.actor", { secret: cookie.slice(cookie.indexOf("=") + 1) });
}

test("dev sign-in reaches someone already there by their email or id, as they are", async () => {
  const rt = await createRuntime({ store: memoryStore(), plugins: [...access, devSignIn] });
  try {
    // Someone who moved in from another app, under the id it gave them.
    await rt.call("person.set", { person: "01HEXAMPLE", email: "ana@example.com", name: "Ana" });
    assertEquals(await signIn(rt, "Ana@Example.com"), { kind: "person", id: "01HEXAMPLE" });
    assertEquals(await rt.query("person.profile", { person: "01HEXAMPLE" }), {
      name: "Ana",
      email: "ana@example.com",
    });
    // Someone new, by name or email, as ever; and by name again, as they are.
    assertEquals(await signIn(rt, "bob"), { kind: "person", id: "bob" });
    assertEquals(await signIn(rt, "cy@example.com"), { kind: "person", id: "cy@example.com" });
    await rt.call("person.set", { person: "bob", name: "Bob B." });
    assertEquals(await signIn(rt, "bob"), { kind: "person", id: "bob" });
    assertEquals(await rt.query("person.profile", { person: "bob" }), { name: "Bob B." });
  } finally {
    await rt.close();
  }
});
