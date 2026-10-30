/**
 * Lets someone into a space the way people join: they've signed in with an
 * email (`<id>@example.com`), a manager (`by`) invites it, and they accept.
 */
import type { Actor, Runtime } from "../../../runtime/mod.ts";

export async function join(
  rt: Runtime,
  space: string,
  who: Actor,
  role: string,
  by: Actor,
): Promise<void> {
  const email = `${who.id}@example.com`;
  await rt.call("person.set", { person: who.id, email });
  const { invitation } = await rt.call<{ invitation: string }>("invitation.send", {
    space,
    email,
    role,
  }, { actor: by });
  await rt.call("invitation.accept", { invitation }, { actor: who });
}
