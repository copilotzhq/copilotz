/**
 * The API tab's words: what to paste in a terminal to try a key (with its
 * secret when it's just been made, else a variable), and what a key may
 * use, in a few words.
 */
import { assert, assertEquals } from "@std/assert";
import { test } from "../../../../testing/mod.ts";
import { namesIn, sameScope, snippets, summary } from "../views/web/snippet.ts";
import { presets } from "../resources/presets.ts";

test("trying a key: sending a message when it may, a query, and following what happens", () => {
  const made = snippets("https://app.test", { call: ["chat.send"], query: ["thread.recent"] });
  assertEquals(made.map((s) => s.title), [
    "Send a message",
    "Run thread.recent",
    "Follow the replies",
  ]);
  assertEquals(
    made[0].text,
    [
      "curl -X POST https://app.test/api/actions/chat.send \\",
      '  -H "Authorization: Bearer $COPILOTZ_KEY" \\',
      '  -H "Content-Type: application/json" \\',
      `  -d '{"text":"Hello from my code"}'`,
    ].join("\n"),
  );
  // The key, when it's just been made, stands out.
  const secret = "cpz_abc";
  const shown = snippets("https://app.test", { call: ["note.write"] }, secret);
  assertEquals(shown.map((s) => s.title), ["Call note.write", "Follow what happens"]);
  assert(shown.every((s) => s.text.includes(`Bearer ${secret}`)));
  assertEquals(shown[0].code.filter((p) => p.tone === "accent").map((p) => p.text), [secret]);
  assert(shown[0].text.includes("-d '{}'"));
  // Reading only: following what happens, still.
  assertEquals(snippets("https://app.test", { read: ["note"] }).map((s) => s.title), [
    "Follow what happens",
  ]);
});

test("what a key may use, in a few words: its preset, else what it counts", () => {
  assertEquals(
    summary({ call: ["chat.stop", "chat.send"], query: presets.chat.scope.query }, presets),
    "Chat",
  );
  assertEquals(summary(presets.read.scope, presets), "Read only");
  assertEquals(summary({ call: ["a.b"], query: ["c.d", "e.f"] }, presets), "1 Action, 2 queries");
  assertEquals(summary({ view: ["thread"] }, presets), "1 View");
  // Collections count once, read or written.
  assertEquals(summary({ read: ["note", "thread"], write: ["note"] }, presets), "2 collections");
  // A preset's scope with one more is no longer the preset.
  assertEquals(
    summary({ ...presets.read.scope, read: ["message"] }, presets),
    "3 queries, 1 collection",
  );
});

test("scopes compared by name, whatever their order; their names, once each", () => {
  assert(sameScope({ call: ["a", "b"] }, { call: ["b", "a"], query: [] }));
  assert(!sameScope({ call: ["a"] }, { query: ["a"] }));
  assertEquals(namesIn({ call: ["a"], read: ["note"], write: ["note"] }), ["a", "note"]);
});
