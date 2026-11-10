/**
 * The page's connection, once `web()` has made it: the client, and whom it
 * shows Views to. What `LazyView` observes with. A person's viewer is kept as
 * their own record says (`followViewer`): their name, or none, and their
 * email.
 */
import type { Client } from "../../runtime/client.ts";
import type { Viewer } from "../../runtime/mod.ts";

export const session: { client?: Client; viewer?: Viewer } = {};

/** What someone signed in is shown as: their name and email, as far as known. */
export type Shown = { name?: unknown; email?: unknown };

/**
 * Whom Views are shown to: a person by their id, with their name and email;
 * a contact as messages name it.
 */
export function viewerOf(actor: { kind: string; id: string }, shown: Shown = {}): Viewer {
  const text = (value: unknown) => typeof value === "string" && value ? value : undefined;
  const label = text(shown.name);
  const email = text(shown.email);
  return {
    kind: actor.kind,
    name: actor.kind === "person" ? actor.id : `${actor.kind}:${actor.id}`,
    ...(label ? { label } : {}),
    ...(email ? { email } : {}),
  };
}

/**
 * Keeps the page's viewer (`session.viewer`) as a person's own record says
 * (identity's `person`: their name and email), and says when it changes
 * (`changed`: the page draws again): they renamed themselves, here or in
 * another tab. Its first answer is what the page knew already. It returns
 * how to stop.
 */
export function followViewer(
  client: Client,
  person: { kind: string; id: string },
  changed: () => void,
): () => void {
  return client.db.collection<Shown>("person").watch(
    { _id: person.id },
    { projection: { name: 1, email: 1 } },
    ([now], error) => {
      if (error || !now) return;
      const next = viewerOf(person, now);
      const was = session.viewer;
      if (next.label === was?.label && next.email === was?.email) return;
      session.viewer = next;
      changed();
    },
  );
}
