/**
 * A conversation on the web says nothing of what its messages drew on: an
 * agent's record of the other spaces its work read (`drew`) is for whoever
 * moves the chat, never a notice, in any kind of space.
 */
import { assertEquals } from "@std/assert";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "../../../testing/mod.ts";
import { conversationView } from "../chat/views/web/conversation.tsx";
import { messageView } from "../chat/views/web/message.tsx";
import { PERSONAL } from "../../access/spaces/contract.ts";

const at = new Date().toISOString();
const message = (more: Record<string, unknown> = {}) => ({
  _id: "m1",
  thread: "t1",
  from: "maya",
  to: ["ana"],
  turn: "r1",
  at,
  text: "The budget is set",
  ...more,
});

/** A View context over one chat (in a space of `kind`, unless it's still loading) and its message. */
const contextOf = (kind: string, said: unknown, shown: unknown[] = []) => {
  const one: Record<string, unknown> = {
    thread: { _id: "t1", in: "s1", agents: ["maya"] },
    ...(kind === "loading" ? {} : { space: { _id: "s1", name: "Here", kind } }),
  };
  return {
    hints: {},
    resources: {},
    viewer: { name: "ana" },
    call: () => Promise.resolve(),
    show: (view: string, _doc: unknown, hints: Record<string, unknown>) => {
      if (view === "web.message") shown.push(hints);
      return null;
    },
    db: {
      collection: (name: string) => ({
        findOne: () => ({ value: one[name] }),
        find: () => ({
          value: name === "space" ? [{ _id: "finance", name: "Finance", kind: "shared" }] : [],
        }),
        query: (query: string) => ({
          value: name === "message" ? (query === "conversation" ? [said] : []) : undefined,
        }),
      }),
    },
  };
};

test("a message drawn from other spaces shows as any other, in every kind of space", () => {
  const drawn = message({ drew: ["finance"] });
  for (const kind of ["shared", PERSONAL, "loading"]) {
    // What the conversation hands each message to show with: the same.
    const shown = (said: unknown) => {
      const hints: unknown[] = [];
      conversationView({ _id: "t1" }, contextOf(kind, said, hints) as never);
      return hints;
    };
    assertEquals(shown(drawn), shown(message()), kind);
    // And the message itself: the same page.
    const page = (said: ReturnType<typeof message>) =>
      renderToStaticMarkup(<>{messageView(said as never, contextOf(kind, said) as never)}</>);
    assertEquals(page(drawn), page(message()), kind);
  }
});
