/**
 * A conversation on the web: a message that drew on spaces not everyone here
 * sees says so, by their names; never in a Personal space, where only its
 * person is, nor until the space is known.
 */
import { assertEquals } from "@std/assert";
import { test } from "../../../testing/mod.ts";
import { conversationView } from "../chat/views/web/conversation.tsx";
import { PERSONAL } from "../../access/spaces/contract.ts";

test("a message drawn from spaces not everyone here sees says so, never in a Personal space", () => {
  /** The sources each message is shown with, in a chat in a space of `kind`. */
  const shownIn = (kind: string) => {
    const hints: unknown[] = [];
    const message = {
      _id: "m1",
      thread: "t1",
      from: "maya",
      to: ["ana"],
      at: new Date().toISOString(),
      text: "The budget is set",
      sources: ["finance"],
    };
    const one: Record<string, unknown> = {
      thread: { _id: "t1", in: "s1", agents: ["maya"] },
      ...(kind === "loading" ? {} : { space: { _id: "s1", name: "Here", kind } }),
    };
    const ctx = {
      hints: {},
      resources: {},
      viewer: { name: "ana" },
      call: () => Promise.resolve(),
      show: (view: string, _doc: unknown, h: Record<string, unknown>) => {
        if (view === "web.message") hints.push(h.sources);
        return null;
      },
      db: {
        collection: (name: string) => ({
          findOne: () => ({ value: one[name] }),
          find: () => ({
            value: name === "space" ? [{ _id: "finance", name: "Finance", kind: "shared" }] : [],
          }),
          query: (query: string) => ({
            value: name === "message" ? (query === "conversation" ? [message] : []) : undefined,
          }),
        }),
      },
    };
    conversationView({ _id: "t1" }, ctx as never);
    return hints;
  };
  assertEquals(shownIn("shared"), [["Finance"]]);
  // Only Ana is in her Personal space, and she sees all her agents drew on for her.
  assertEquals(shownIn(PERSONAL), [[]]);
  assertEquals(shownIn("loading"), [[]]);
});
