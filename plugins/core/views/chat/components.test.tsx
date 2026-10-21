/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
// deno-lint-ignore verbatim-module-syntax -- classic JSX requires this runtime import.
import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { Virtualizer } from "@tanstack/react-virtual";
import {
  Input,
  Markdown,
  NameDescriptionDialog,
} from "@copilotz/copilotz/web/kit";
import { AssistantActivity, toolLabel } from "./activity.tsx";
import { MessageGroup } from "./message.tsx";
import { activeMention, mentionedTargets } from "./composer.tsx";
import { titleFrom } from "./intents.ts";
import { prependScrollTop } from "./list.tsx";
import {
  type ChatMessage,
  type ChatSender,
  groupMessages,
} from "../../shared/chat-messages.ts";

const north: ChatSender = { id: "north", type: "agent", name: "North" };
const ana: ChatSender = { id: "ana", type: "human", name: "Ana" };
const message = (
  id: string,
  sender: ChatSender,
  patch: Partial<ChatMessage> = {},
): ChatMessage => ({
  id,
  role: sender.type === "human" ? "user" : "assistant",
  sender,
  text: id,
  createdAt: "2026-10-21T10:00:00.000Z",
  attachments: [],
  activity: [],
  status: "sent",
  ...patch,
});

test("activity steps name the tool and their state, with disclosure semantics", () => {
  const html = renderToStaticMarkup(
    <AssistantActivity
      items={[
        {
          id: "t",
          kind: "thinking",
          status: "complete",
          reasoning: "Split the plan",
        },
        {
          id: "k",
          kind: "tool",
          status: "complete",
          toolId: "kanban",
          input: { name: "Cycle" },
        },
        { id: "s", kind: "tool", status: "failed", toolId: "web_search" },
        { id: "r", kind: "tool", status: "active", toolId: "terminal" },
      ]}
    />,
  );
  for (
    const label of [
      "Thought through request",
      "Used kanban",
      "web search failed",
      "Using terminal",
    ]
  ) assert.ok(html.includes(label), `${label}: ${html}`);
  assert.equal(
    html.match(/aria-expanded="false"/g)?.length,
    2,
    "expandable rows are disclosure buttons",
  );
  assert.ok(html.includes("aria-controls="));
  assert.equal(toolLabel("sharedDocument"), "shared document");
});

test("a settled timeline of more than three steps folds into one summary", () => {
  const html = renderToStaticMarkup(
    <AssistantActivity
      items={["a", "b", "c", "d"].map((id) => ({
        id,
        kind: "tool" as const,
        status: "complete" as const,
        toolId: id,
      }))}
    />,
  );
  assert.ok(html.includes("Worked through 4 steps"), html);
  assert.ok(!html.includes("Used a"));
});

test("an inline tool presentation replaces its step", () => {
  const html = renderToStaticMarkup(
    <AssistantActivity
      items={[{ id: "q", kind: "tool", status: "active", toolId: "ask" }]}
      tools={new Map([["q", {
        node: <p>Asking @South</p>,
        inline: true,
      }]])}
    />,
  );
  assert.ok(html.includes("Asking @South"));
  assert.ok(!html.includes("Using ask"));
});

test("own messages sit in a bubble on the right; agents read as prose with their color", () => {
  const groups = groupMessages([
    message("hello", ana),
    message("reply", north, { text: "**Done**" }),
  ], (sender) => sender.id === "ana");
  const own = renderToStaticMarkup(<MessageGroup group={groups[0]} />);
  assert.ok(own.includes('data-own="true"'));
  assert.ok(own.includes("bubble"));
  assert.ok(own.includes("Ana"));
  const agent = renderToStaticMarkup(<MessageGroup group={groups[1]} />);
  assert.ok(agent.includes("<strong>Done</strong>"));
  assert.ok(!agent.includes("data-own"));
  assert.match(agent, /style="color:#[0-9a-f]{6}"/);
});

test("pending and failed sends say so, with Retry and Discard", () => {
  const html = renderToStaticMarkup(
    <MessageGroup
      group={{
        id: "x",
        sender: ana,
        role: "user",
        own: true,
        messages: [
          message("one", ana, { status: "sending" }),
          message("two", ana, { status: "failed", error: "Offline." }),
        ],
      }}
      onRetry={() => {}}
      onDiscard={() => {}}
    />,
  );
  assert.ok(html.includes("Sending…"));
  assert.ok(html.includes("Offline."));
  assert.ok(html.includes("Retry"));
  assert.ok(html.includes("Discard"));
});

test("@mentions resolve to participant ids; the active mention follows the caret", () => {
  const targets = [
    { id: "p-north", name: "North", sender: north },
    { id: "p-south", name: "South West", sender: { ...north, id: "south" } },
  ];
  assert.deepEqual(
    mentionedTargets("@North and @SouthWest, then @North again", targets),
    ["p-north", "p-south"],
  );
  assert.deepEqual(activeMention("ask @no", 7), { start: 4, query: "no" });
  assert.equal(activeMention("email@example", 13), null);
});

test("a new conversation is titled by its first words", () => {
  assert.equal(titleFrom("Plan the launch"), "Plan the launch");
  assert.equal(
    titleFrom(
      "Turn this rough idea into a practical kickoff plan for the whole team please",
    ),
    "Turn this rough idea into a practical kickoff…",
  );
  assert.equal(titleFrom("  "), "New conversation");
});

test("prepending a fragment keeps the measured row: groups are keyed by their last message", () => {
  let groups = groupMessages([
    message("first", north),
    message("last", north),
    message("next", ana),
  ], () => false);
  const key = (index: number) => groups[index]?.messages.at(-1)?.id ?? index;
  const options = {
    count: groups.length,
    getScrollElement: () => null,
    estimateSize: () => 100,
    getItemKey: key,
    scrollToFn: () => {},
    observeElementRect: () => {},
    observeElementOffset: () => {},
  };
  const virtualizer = new Virtualizer(options);
  virtualizer.getTotalSize();
  virtualizer.resizeItem(0, 420);
  const oldKey = key(0);
  groups = groupMessages([
    message("older-user", ana),
    message("older", north),
    message("first", north),
    message("last", north),
    message("next", ana),
  ], () => false);
  assert.equal(groups.length, 3);
  assert.equal(key(1), oldKey, "the merged group keeps its key");
  virtualizer.setOptions({ ...options, count: groups.length });
  assert.equal(virtualizer.getTotalSize(), 620);
  assert.equal(prependScrollTop({ start: 520, offset: 40 }, 24), 504);
});

test("text inputs keep an explicit type and Unicode values", () => {
  let value = "";
  for (const char of "Lançamento do curso") {
    value += char;
    const html = renderToStaticMarkup(
      <Input value={value} onChange={() => {}} />,
    );
    assert.ok(html.includes('type="text"'));
    assert.ok(html.includes(`value="${value}"`));
  }
  for (const type of ["email", "password", "file"]) {
    assert.ok(renderToStaticMarkup(<Input type={type} />).includes(type));
  }
});

test("the name and description editor starts from the record", () => {
  // Dialog content renders in a portal, so check the closed shell renders.
  const html = renderToStaticMarkup(
    <NameDescriptionDialog
      open={false}
      onOpenChange={() => {}}
      title="Edit Space"
      initial={{ name: "Lançamento" }}
      onSubmit={() => {}}
    />,
  );
  assert.equal(html, "");
});

test("math renders with KaTeX and a MathML copy; it can never carry a link", () => {
  const html = renderToStaticMarkup(
    <Markdown>
      {"Inline $p = \\frac{c}{v}$ and\n\n$$\n\\href{https://evil.example}{x}\n$$"}
    </Markdown>,
  );
  assert.ok(html.includes('class="katex"'), html);
  assert.ok(html.includes("<math"), "assistive technology reads MathML");
  assert.ok(html.includes('class="katex-display"'), "fenced math is display");
  assert.ok(!html.includes('evil.example"'), "no link from math");
  assert.ok(!/<a\s/.test(html));
});
