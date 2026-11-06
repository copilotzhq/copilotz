/**
 * Documents' web front end, rendered on the server (Deno and Bun run
 * `.tsx`): an agent's write in a conversation as a compact card (its
 * title, what changed, its version, Open), a read and a list as quiet
 * lines, a failure in the agent's words; a change as a diff's parts; and
 * who's on a document now.
 */
import assert from "node:assert/strict";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ViewContext } from "../../../../runtime/mod.ts";
import { test } from "../../../../testing/mod.ts";
import type { Presence } from "../contract.ts";
import { diffParts } from "../views/web/changes.tsx";
import { shownAs } from "../views/web/people.tsx";
import { hereNow } from "../views/web/presence.tsx";
import { documentStepView, wrote } from "../views/web/step.tsx";

/** A View's context whose reads answer from `docs` (documents by id) and `threads`. */
function ctxOf(
  docs: Record<string, unknown> = {},
  hints: Record<string, unknown> = {},
): ViewContext<ReactNode> {
  const found = (name: string, id: string) =>
    name === "document" ? docs[id] ?? null : name === "thread" ? { _id: id, in: "launch" } : null;
  return {
    db: {
      collection: (name: string) => ({
        findOne: (filter: { _id: string }) => ({ status: "ready", value: found(name, filter._id) }),
      }),
    },
    resources: {},
    name: "document.step",
    hints: { thread: "t1", ...hints },
    show: () => null,
    call: () => Promise.resolve(undefined),
    emit: () => Promise.resolve(),
  } as unknown as ViewContext<ReactNode>;
}

const html = (node: ReactNode) =>
  renderToStaticMarkup(<>{node}</>).replace(/<style[^>]*>[\s\S]*?<\/style>/g, "");

test("an agent's write shows as a card: the title, what changed, its version, and Open", () => {
  const call = {
    _id: "c1",
    name: "edit_document",
    input: { document: "Launch plan", old: "a", new: "b" },
    output: "Saved [Launch plan](/document/d1) as version 4: +12 −3 lines.",
  };
  const shown = html(
    documentStepView(call, ctxOf({ d1: { _id: "d1", title: "Launch plan", in: "launch" } })),
  );
  assert.match(shown, /class="doc-step"/);
  assert.match(shown, />Launch plan</);
  assert.match(shown, /Edited it · version 4/);
  assert.match(shown, />\+12</);
  assert.match(shown, />−3</);
  assert.match(shown, /href="\/document\/d1\?in=launch"/);
  assert.match(shown, />Open</);
  // Made, and renamed since: the title it has now.
  const made = html(documentStepView({
    _id: "c2",
    name: "write_document",
    input: { title: "Plan", text: "x" },
    output: "Made [Plan](/document/d2) (version 1, 3 lines).",
  }, ctxOf({ d2: { _id: "d2", title: "The plan", in: "launch" } })));
  assert.match(made, /Made it · version 1/);
  assert.match(made, />The plan</);
  // Deleted since: said, and nothing to open.
  const gone = html(documentStepView({ ...call, output: call.output }, ctxOf()));
  assert.match(gone, /since deleted/);
  assert.doesNotMatch(gone, />Open</);
});

test("a call running, a read, a list and a failure each read as one line", () => {
  const running = html(documentStepView(
    { _id: "c", name: "append_document", input: { document: "Plan", text: "x" } },
    ctxOf({}, { running: true }),
  ));
  assert.match(running, /Adding to <b>Plan<\/b>…/);
  const read = html(documentStepView({
    _id: "c",
    name: "read_document",
    input: { document: "Plan" },
    output: "[Plan](/document/d1) · version 2 · 1.2 KB · saved by Ana 2026-10-29 21:04\n\nText",
  }, ctxOf({ d1: { _id: "d1", title: "Plan", in: "launch" } })));
  assert.match(
    read,
    /Read <a href="\/document\/d1\?in=launch" class="doc-step-link">Plan<\/a> · version 2/,
  );
  const listed = html(documentStepView({
    _id: "c",
    name: "list_documents",
    output: "Documents here (3), latest saved first:\n- …",
  }, ctxOf()));
  assert.match(listed, /Looked at this space&#x27;s documents \(3\)/);
  const failed = html(documentStepView({
    _id: "c",
    name: "edit_document",
    input: { document: "Plan", old: "zzz", new: "y" },
    output: "The text to replace isn't in [Plan](/document/d1): read it again.",
  }, ctxOf()));
  assert.match(failed, /data-failed/);
  assert.match(failed, /isn&#x27;t in/);
  assert.equal(
    wrote("No changes: [Plan](/document/d1) is already that (version 5).")?.unchanged,
    true,
  );
  assert.equal(wrote("Something else"), undefined);
});

test("a change as a diff: lines out and in, what stayed around them, the rest folded", () => {
  const before = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
  const after = before.replace("line 10", "line ten");
  const parts = diffParts(before, after);
  const text = parts.map((p) => p.text).join("");
  assert.match(text, /⋯ 7 unchanged lines/);
  assert.ok(parts.some((p) => p.tone === "removed" && p.text === "line 10"));
  assert.ok(parts.some((p) => p.tone === "added" && p.text === "line ten"));
  assert.match(text, / {2}line 9\n/);
  assert.deepEqual(diffParts("", "one"), [{ text: "one", tone: "added" }]);
});

test("who's on a document now: each once, editing if any page is; not you, not gone", () => {
  const now = Date.parse("2026-10-30T10:00:00Z");
  const at = (s: number) => new Date(now - s * 1000).toISOString();
  const p = (who: string, state: "open" | "editing", ago: number, page = "p"): Presence => ({
    _id: `d|${who}|${page}`,
    document: "d",
    in: "launch",
    who,
    state,
    at: at(ago),
  });
  const here = hereNow(
    [
      p("person:bob@example.com", "open", 5, "a"),
      p("person:bob@example.com", "editing", 10, "b"),
      p("person:ana@example.com", "editing", 1),
      p("person:vera@example.com", "open", 200),
      p("agent:north", "open", 3),
    ],
    now,
    "ana@example.com",
    (key) =>
      shownAs(key, {
        agents: { north: { name: "North", icon: "🧭" } as never },
        names: { "bob@example.com": "Bob Silva" },
      }),
  );
  assert.deepEqual(here.map((h) => [h.who.name, h.editing]), [["Bob Silva", true], [
    "North",
    false,
  ]]);
});
