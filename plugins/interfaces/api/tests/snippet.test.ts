/**
 * The API tab's words: what to paste in a terminal to try a key (with its
 * secret when it's just been made, else a variable), and what a key does,
 * in a few words.
 */
import { assert, assertEquals } from "@std/assert";
import { test } from "../../../../testing/mod.ts";
import { snippets, summary } from "../views/web/snippet.ts";
import { presets } from "../resources/presets.ts";

test("trying a key: sending a message when it may, a query, and following what happens", () => {
  const made = snippets("https://app.test", { actions: ["chat.send"], queries: ["thread.recent"] });
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
  const shown = snippets("https://app.test", { actions: ["note.write"], queries: [] }, secret);
  assertEquals(shown.map((s) => s.title), ["Call note.write", "Follow what happens"]);
  assert(shown.every((s) => s.text.includes(`Bearer ${secret}`)));
  assertEquals(shown[0].code.filter((p) => p.tone === "accent").map((p) => p.text), [secret]);
  assert(shown[0].text.includes("-d '{}'"));
});

test("what a key does, in a few words: its preset, else what it counts", () => {
  assertEquals(
    summary({ actions: ["chat.stop", "chat.send"], queries: presets.chat.queries! }, presets),
    "Chat",
  );
  assertEquals(summary({ actions: [], queries: presets.read.queries! }, presets), "Read only");
  assertEquals(
    summary({ actions: ["a.b"], queries: ["c.d", "e.f"] }, presets),
    "1 Action, 2 queries",
  );
  assertEquals(summary({ actions: [], queries: [], views: ["thread"] }, presets), "1 View");
});
