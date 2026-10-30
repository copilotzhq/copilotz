/**
 * Leaving a shared space: a member can; nobody leaves their Personal space;
 * and a shared space always keeps a manager, whether its last one would
 * leave, be removed or be made something less.
 */
import { assertEquals } from "@std/assert";
import { type Actor, createRuntime } from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import { access } from "../mod.ts";
import { join } from "./join.ts";
import { test } from "../../../testing/mod.ts";

const ana: Actor = { kind: "person", id: "ana" };
const bob: Actor = { kind: "person", id: "bob" };
const refused = (promise: Promise<unknown>) =>
  promise.then(() => "done", (error) => (error as { code?: string }).code ?? "failed");

test("members leave shared spaces; a space keeps a manager; Personal spaces stay their person's", async () => {
  const rt = await createRuntime({ store: memoryStore(), plugins: [...access] });
  try {
    const { space } = await rt.call<{ space: string }>("space.create", { name: "Launch" }, {
      actor: ana,
    });
    await join(rt, space, bob, "editor", ana);
    const can = (actor: Actor) =>
      rt.call<{ can: boolean }>("space.can", { space, verb: "read" }, { actor });
    assertEquals(await can(bob), { can: true });

    // Bob leaves; he reaches it no more.
    assertEquals(await rt.call("space.leave", { space }, { actor: bob }), { left: true });
    assertEquals(await can(bob), { can: false });
    assertEquals(await rt.call("space.leave", { space }, { actor: bob }), { left: false });

    // Ana is its only manager: she can't leave, be removed or stop managing it.
    assertEquals(await refused(rt.call("space.leave", { space }, { actor: ana })), "forbidden");
    assertEquals(
      await refused(rt.call("member.remove", { space, member: ana }, { actor: ana })),
      "forbidden",
    );
    assertEquals(
      await refused(
        rt.call("member.set", { space, member: ana, role: "editor" }, { actor: ana }),
      ),
      "forbidden",
    );
    // Once Bob is back, managing it too, she can.
    await join(rt, space, bob, "manager", ana);
    assertEquals(await rt.call("space.leave", { space }, { actor: ana }), { left: true });
    assertEquals(await can(ana), { can: false });

    // A Personal space can't be left.
    const { space: personal } = await rt.call<{ space: string }>("space.personal", {}, {
      actor: ana,
    });
    assertEquals(
      await refused(rt.call("space.leave", { space: personal }, { actor: ana })),
      "forbidden",
    );
  } finally {
    await rt.close();
  }
});
