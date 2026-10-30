/**
 * The org's roles: owners and admins reach everything in the org, Personal
 * spaces too; members only their spaces (and who's in the org); guests only
 * the spaces they're let into, and make none; staff reach it all. Only
 * owners make owners, an org keeps one, and taking someone out ends their
 * memberships and sessions and hands on the spaces only they managed. An
 * agent working for an admin still reaches only where it works.
 */
import { assertEquals } from "@std/assert";
import { type Actor, createRuntime } from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import { access } from "../mod.ts";
import { test } from "../../../testing/mod.ts";

const ana: Actor = { kind: "person", id: "ana" };
const bob: Actor = { kind: "person", id: "bob" };
const cleo: Actor = { kind: "person", id: "cleo" };
const dan: Actor = { kind: "person", id: "dan" };
const staff: Actor = { kind: "person", id: "sam", staff: true };
const refused = (promise: Promise<unknown>) =>
  promise.then(() => "done", (error) => (error as { code?: string }).code ?? "failed");

test("owners and admins reach the whole org; members, guests and agents what's theirs", async () => {
  const rt = await createRuntime({ store: memoryStore(), plugins: [...access] });
  try {
    await rt.call("org.join", { person: "ana", role: "owner" });
    await rt.call("org.join", { person: "bob" });
    await rt.call("org.join", { person: "cleo", role: "guest" });
    const can = async (actor: Actor, space: string, verb = "read") =>
      (await rt.call<{ can: boolean }>("space.can", { space, verb }, { actor })).can;

    // Bob's own space, and his Personal one: Ana runs the org, so she reaches both.
    const { space: plans } = await rt.call<{ space: string }>("space.create", { name: "Plans" }, {
      actor: bob,
    });
    const { space: bobs } = await rt.call<{ space: string }>("space.personal", {}, { actor: bob });
    assertEquals([await can(ana, plans, "manage"), await can(ana, bobs, "write")], [true, true]);
    // Cleo, a guest, reaches neither, and can't make a space of her own.
    assertEquals([await can(cleo, plans), await can(cleo, bobs)], [false, false]);
    assertEquals(
      await refused(rt.call("space.create", { name: "Mine" }, { actor: cleo })),
      "forbidden",
    );
    // Staff reach it all; their standing says so.
    assertEquals(await can(staff, bobs, "manage"), true);
    assertEquals(await rt.call("org.me", {}, { actor: staff }), { role: null, staff: true });
    assertEquals(await rt.call("org.me", {}, { actor: bob }), { role: "member", staff: false });

    // An agent working for Ana reaches only where it works, however much Ana reaches.
    const helper: Actor = { kind: "agent", id: "helper", for: ana };
    assertEquals(await can(helper, bobs), false);
  } finally {
    await rt.close();
  }
});

test("roles change by the org's owners and admins; only owners make owners; one stays", async () => {
  const rt = await createRuntime({ store: memoryStore(), plugins: [...access] });
  try {
    await rt.call("org.join", { person: "ana", role: "owner" });
    await rt.call("org.join", { person: "bob" });
    await rt.call("org.join", { person: "dan" });
    const role = (person: string, to: string, actor: Actor) =>
      refused(rt.call("org.role", { person, role: to }, { actor }));

    assertEquals(await role("dan", "admin", bob), "forbidden");
    assertEquals(await role("bob", "admin", ana), "done");
    // An admin changes members, but not owners.
    assertEquals(await role("dan", "guest", bob), "done");
    assertEquals(await role("dan", "owner", bob), "forbidden");
    assertEquals(await role("ana", "member", bob), "forbidden");
    // The last owner stays one until there's another.
    assertEquals(await role("ana", "member", ana), "forbidden");
    assertEquals(await role("bob", "owner", ana), "done");
    assertEquals(await role("ana", "member", ana), "done");
    // Org roles don't change through spaces' memberships.
    assertEquals(
      await refused(rt.call("member.set", { space: "*", member: dan, role: "manager" }, {
        actor: bob,
      })),
      "forbidden",
    );
    // Coming back in keeps the role you had.
    await rt.call("org.join", { person: "dan" });
    assertEquals(await rt.call("org.me", {}, { actor: dan }), { role: "guest", staff: false });
  } finally {
    await rt.close();
  }
});

test("taking someone out ends their memberships and sessions, and hands on what only they managed", async () => {
  const rt = await createRuntime({ store: memoryStore(), plugins: [...access] });
  try {
    await rt.call("org.join", { person: "ana", role: "owner" });
    await rt.call("org.join", { person: "bob" });
    const { space: plans } = await rt.call<{ space: string }>("space.create", { name: "Plans" }, {
      actor: bob,
    });
    const { space: bobs } = await rt.call<{ space: string }>("space.personal", {}, { actor: bob });
    const { session } = await rt.call<{ session: string }>("session.start", { person: "bob" });
    assertEquals((await rt.query("credential.actor", { secret: session }) as Actor).id, "bob");

    assertEquals(
      await refused(rt.call("org.remove", { person: "ana" }, { actor: ana })),
      "forbidden",
    );
    assertEquals(await rt.call("org.remove", { person: "bob" }, { actor: ana }), {
      handed: [plans],
    });
    // His session's gone; Ana manages what he alone managed; his Personal space stays, in reach.
    assertEquals(await rt.query("credential.actor", { secret: session }), null);
    const can = async (actor: Actor, space: string, verb = "read") =>
      (await rt.call<{ can: boolean }>("space.can", { space, verb }, { actor })).can;
    assertEquals(await can(bob, plans), false);
    assertEquals(await can(ana, plans, "manage"), true);
    assertEquals(await can(ana, bobs), true);
    assertEquals(await rt.call("org.me", {}, { actor: bob }), { role: null, staff: false });
    // Staff, not in the org, change roles as owners do, but not past its last owner.
    await rt.call("org.join", { person: "cleo" });
    assertEquals(await rt.call("org.role", { person: "cleo", role: "owner" }, { actor: staff }), {
      role: "owner",
    });
    assertEquals(await rt.call("org.role", { person: "ana", role: "admin" }, { actor: staff }), {
      role: "admin",
    });
    assertEquals(
      await refused(rt.call("org.role", { person: "cleo", role: "admin" }, { actor: staff })),
      "forbidden",
    );
  } finally {
    await rt.close();
  }
});
