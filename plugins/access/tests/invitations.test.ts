/**
 * Invitations: people join a shared space by accepting one sent to the email
 * they signed in with. Sending says nothing about whether the address has
 * an account; only its managers and whom it's to see it; nobody reads
 * anyone else's email.
 */
import { assertEquals } from "@std/assert";
import { type Actor, createRuntime, defineAction, definePlugin } from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import { access, type Invitation } from "../mod.ts";
import { test } from "../../../testing/mod.ts";

const ana: Actor = { kind: "person", id: "ana" };
const bob: Actor = { kind: "person", id: "bob" };
const cy: Actor = { kind: "person", id: "cy" };
const refused = (promise: Promise<unknown>) =>
  promise.then(() => "done", (error) => (error as { code?: string }).code ?? "failed");

/** What someone's own reads reach, through the rules, as anyone's code reads. */
const app = definePlugin({
  name: "app",
  actions: {
    "test.seen": defineAction({
      input: { type: "object" },
      allow: () => true,
      run: async (ctx) => ({
        people: (await ctx.db.collection("person").find({})).map((p) => p._id),
        invitations: (await ctx.db.collection("invitation").find({})).map((i) => i.email),
      }),
    }),
  },
});

const start = async () => {
  const rt = await createRuntime({ store: memoryStore(), plugins: [...access, app] });
  await rt.call("person.set", { person: "ana", email: "ana@example.com", name: "Ana" });
  await rt.call("person.set", { person: "bob", email: "Bob@Example.com" });
  const { space } = await rt.call<{ space: string }>("space.create", { name: "Launch" }, {
    actor: ana,
  });
  return { rt, space };
};

test("a manager invites by email; whoever signed in with it sees it and joins by accepting", async () => {
  const { rt, space } = await start();
  try {
    const can = (actor: Actor) =>
      rt.call<{ can: boolean }>("space.can", { space, verb: "write" }, { actor });
    const invite = (email: string, role?: string) =>
      rt.call<{ invitation: string }>("invitation.send", {
        space,
        email,
        ...(role ? { role } : {}),
      }, { actor: ana });
    const mine = (actor: Actor) => rt.query<Invitation[]>("invitation.mine", {}, { actor });

    // An address with an account and one without answer alike.
    const toBob = await invite(" BOB@example.com ");
    const toNobody = await invite("nobody@example.com");
    assertEquals(Object.keys(toBob), Object.keys(toNobody));
    assertEquals(await refused(invite("not an email")), "invalid");
    assertEquals(await refused(invite("cy@example.com", "owner")), "invalid");

    // Bob sees his, with what it's for; Cy (no email) and Ana, none to them.
    const [bobs, ...more] = await mine(bob);
    assertEquals(more, []);
    assertEquals([bobs.name, bobs.email, bobs.role, bobs.by], [
      "Launch",
      "bob@example.com",
      "editor",
      "person:ana",
    ]);
    assertEquals(await mine(cy), []);
    assertEquals(await mine(ana), []);
    assertEquals(await can(bob), { can: false });

    // Bob can't invite into Launch, nor answer what isn't his.
    assertEquals(
      await refused(rt.call("invitation.send", { space, email: "x@example.com" }, { actor: bob })),
      "forbidden",
    );
    assertEquals(
      await refused(
        rt.call("invitation.accept", { invitation: toNobody.invitation }, { actor: bob }),
      ),
      "forbidden",
    );
    assertEquals(
      await refused(
        rt.call("invitation.decline", { invitation: toNobody.invitation }, { actor: cy }),
      ),
      "forbidden",
    );
    // Ana manages Launch, but can't accept for someone else.
    assertEquals(
      await refused(rt.call("invitation.accept", { invitation: toBob.invitation }, { actor: ana })),
      "forbidden",
    );

    // He accepts: he's in, as invited, and it's gone.
    assertEquals(
      await rt.call("invitation.accept", { invitation: toBob.invitation }, { actor: bob }),
      { space },
    );
    assertEquals(await can(bob), { can: true });
    assertEquals(await mine(bob), []);
    // Ana takes back the other one.
    await rt.call("invitation.decline", { invitation: toNobody.invitation }, { actor: ana });
    assertEquals(
      (await rt.call<{ invitations: string[] }>("test.seen", {}, { actor: ana })).invitations,
      [],
    );

    // People join only that way: adding Cy directly is refused; Bob's role still changes.
    assertEquals(
      await refused(rt.call("member.set", { space, member: cy, role: "viewer" }, { actor: ana })),
      "invalid",
    );
    await rt.call("member.set", { space, member: bob, role: "viewer" }, { actor: ana });
    assertEquals(await can(bob), { can: false });
    // Invited again, someone already in keeps their role.
    const again = await invite("bob@example.com", "manager");
    await rt.call("invitation.accept", { invitation: again.invitation }, { actor: bob });
    assertEquals(await can(bob), { can: false });

    // A Personal space takes no invitations.
    const { space: personal } = await rt.call<{ space: string }>("space.personal", {}, {
      actor: ana,
    });
    assertEquals(
      await refused(
        rt.call("invitation.send", { space: personal, email: "bob@example.com" }, { actor: ana }),
      ),
      "forbidden",
    );
  } finally {
    await rt.close();
  }
});

test("a person reads only themselves; invitations, only their managers and whom they're to", async () => {
  const { rt, space } = await start();
  try {
    await rt.call("invitation.send", { space, email: "bob@example.com" }, { actor: ana });
    await rt.call("invitation.send", { space, email: "nobody@example.com" }, { actor: ana });
    const seen = (actor: Actor) =>
      rt.call<{ people: string[]; invitations: string[] }>("test.seen", {}, { actor });
    assertEquals(await seen(ana), {
      people: ["ana"],
      invitations: ["bob@example.com", "nobody@example.com"],
    });
    assertEquals(await seen(bob), { people: ["bob"], invitations: ["bob@example.com"] });
    assertEquals(await seen(cy), { people: [], invitations: [] });
    // Bob's agent, working for him, neither: they're his to answer.
    assertEquals(await seen({ kind: "agent", id: "lead", for: bob }), {
      people: [],
      invitations: [],
    });
    assertEquals(
      await refused(rt.query("invitation.mine", {}, { actor: { kind: "agent", id: "lead" } })),
      "forbidden",
    );
  } finally {
    await rt.close();
  }
});
