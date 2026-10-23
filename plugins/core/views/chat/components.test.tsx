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
  normalizeMathDelimiters,
  preloadMarkdown,
} from "@copilotz/copilotz/web/kit";
import { AssistantActivity, formatElapsed, toolLabel } from "./activity.tsx";
import { useToolDisplay } from "./tool-display.tsx";
import {
  describeJson,
  parseStructured,
  previewJson,
  ToolPayload,
} from "./tool-output.tsx";
import { MessageGroup } from "./message.tsx";
import { activeMention, mentionedTargets } from "./composer.tsx";
import { titleFrom } from "./intents.ts";
import { prependScrollTop } from "./list.tsx";
import {
  type ChatActivity,
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

const steps: ChatActivity[] = [
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
  {
    id: "s",
    kind: "tool",
    status: "failed",
    toolId: "web_search",
    error: "Timed out",
  },
  {
    id: "r",
    kind: "tool",
    status: "active",
    toolId: "terminal",
    input: { stdin: "ls" },
  },
];

test("background work is one quiet row while it runs, opening to plain-language steps", () => {
  const html = renderToStaticMarkup(<AssistantActivity items={steps} />);
  assert.match(html, /data-state="working"/);
  assert.ok(html.includes("Working…"), html);
  assert.ok(html.includes("Using terminal…"), "the current step");
  assert.match(html, /aria-expanded="false"/, "a disclosure, closed");
  assert.ok(!html.includes("Used kanban"), "steps stay folded");
  // With "Show technical details" the steps show, details one click away.
  const open = renderToStaticMarkup(
    <AssistantActivity items={steps} technical />,
  );
  for (
    const label of [
      "Thought through the request",
      "Used kanban",
      "Used web search · failed",
      "Using terminal…",
      "View thinking",
    ]
  ) assert.ok(open.includes(label), `${label}: ${open}`);
  assert.equal(open.match(/>View details</g)?.length, 3, open);
  assert.ok(!open.includes('data-slot="tool-details"'), "never preloaded");
  assert.equal(toolLabel("sharedDocument"), "shared document");
});

test("a settled reply reads as Used N tools with its time, or its one step's line", () => {
  const at = (seconds: number) =>
    `2026-10-21T10:00:${String(seconds).padStart(2, "0")}.000Z`;
  const done = (id: string, status: "complete" | "failed" = "complete") => ({
    id,
    kind: "tool" as const,
    status,
    toolId: id,
    startedAt: at(0),
    endedAt: at(id === "c" ? 4 : 2),
  });
  const many = renderToStaticMarkup(
    <AssistantActivity items={[done("a"), done("b", "failed"), done("c")]} />,
  );
  assert.match(many, /data-state="done"/);
  assert.ok(many.includes("Used 3 tools · 1 failed"), many);
  assert.ok(many.includes("· 4s"), "from the first call to the last result");
  const one = renderToStaticMarkup(
    <AssistantActivity
      items={[done("search_memory")]}
      tools={new Map([["search_memory", {
        inline: false,
        summary: <>Searched memory: no notes found</>,
      }]])}
    />,
  );
  assert.ok(one.includes("Searched memory: no notes found"), one);
  assert.ok(!one.includes("Used 1 tool"));
  assert.equal(formatElapsed(900), undefined, "nothing under a second");
  assert.equal(formatElapsed(72_000), "1m 12s");
});

test("a batched run reads as one step, its summary speaking for every call", () => {
  const html = renderToStaticMarkup(
    <AssistantActivity
      technical
      items={["a", "b", "c"].map((id) => ({
        id,
        kind: "tool" as const,
        status: "complete" as const,
        toolId: "kanban",
      }))}
      tools={new Map(["a", "b", "c"].map((id) => [id, {
        inline: false,
        group: ["a", "b", "c"],
        summary: <>Added 3 cards to Launch plan</>,
      }]))}
    />,
  );
  assert.equal(html.match(/data-slot="activity-step"/g)?.length, 1, html);
  assert.ok(html.includes("Added 3 cards to Launch plan"));
});

test("output the viewer may not read says whose it is, with no details to open", () => {
  const html = renderToStaticMarkup(
    <AssistantActivity
      technical
      items={[
        {
          id: "a",
          kind: "tool",
          status: "complete",
          toolId: "search_memory",
          input: { query: "x" },
          resultStatus: "restricted",
          withheld: true,
          readableBy: "Ana",
        },
        {
          id: "b",
          kind: "tool",
          status: "complete",
          toolId: "search_memory",
          resultStatus: "restricted",
        },
      ]}
    />,
  );
  assert.ok(html.includes("Only Ana can see these details"), html);
  assert.ok(html.includes("Output visible to the agent only"));
  assert.ok(!html.includes("View details"));
});

test("a live renderer streams in the message; a technical one is a strip until watched", () => {
  const running: ChatActivity = {
    id: "r",
    kind: "tool",
    status: "active",
    toolId: "terminal",
    input: { stdin: "npm test" },
  };
  function Probe(): React.ReactElement {
    const display = useToolDisplay();
    return <pre>{`mode=${display.mode} framed=${display.framed}`}</pre>;
  }
  const tool = (live: "everyone" | "technical") =>
    new Map([["r", {
      inline: false,
      live,
      node: <Probe />,
      summary: (
        <>
          Running <code>npm test</code>
        </>
      ),
    }]]);
  const everyone = renderToStaticMarkup(
    <AssistantActivity items={[running]} tools={tool("everyone")} />,
  );
  assert.match(everyone, /data-slot="live-tool"/);
  assert.ok(everyone.includes("mode=live framed=true"), everyone);
  assert.ok(everyone.includes("<code>npm test</code>"));
  const strip = renderToStaticMarkup(
    <AssistantActivity items={[running]} tools={tool("technical")} />,
  );
  assert.ok(strip.includes("Watch"), strip);
  assert.ok(!strip.includes("mode=live"), "the strip draws no live view");
  assert.match(strip, /data-mode="closed"/);
  assert.ok(!strip.includes('data-slot="activity"'), "not a background step");
  const watched = renderToStaticMarkup(
    <AssistantActivity items={[running]} tools={tool("technical")} technical />,
  );
  assert.ok(watched.includes("mode=live"), "open from the start");
  // Settled, it is a compact card.
  const card = renderToStaticMarkup(
    <AssistantActivity
      items={[{ ...running, status: "complete" }]}
      tools={tool("everyone")}
    />,
  );
  assert.ok(card.includes("mode=card framed=true"), card);
  assert.equal(
    renderToStaticMarkup(<Probe />),
    "<pre>mode=full framed=false</pre>",
    "outside a frame a renderer draws in full",
  );
});

test("a live call the viewer may not read shows its status alone", () => {
  const item: ChatActivity = {
    id: "r",
    kind: "tool",
    status: "active",
    toolId: "terminal",
    withheld: true,
    readableBy: "Ana",
  };
  const tools = new Map([["r", {
    inline: false,
    live: "everyone" as const,
    node: <pre>secret output</pre>,
  }]]);
  const html = renderToStaticMarkup(
    <AssistantActivity items={[item]} tools={tools} agent="North" />,
  );
  assert.ok(html.includes("North is using the terminal…"), html);
  assert.ok(!html.includes("secret output"));
  const done = renderToStaticMarkup(
    <AssistantActivity
      items={[{ ...item, status: "complete", resultStatus: "restricted" }]}
      tools={tools}
      agent="North"
    />,
  );
  assert.ok(done.includes("North used the terminal · Done"), done);
  assert.ok(done.includes("Only Ana can see these details"));
});

test("a structured tool result shows as JSON in its step", () => {
  const html = renderToStaticMarkup(
    <AssistantActivity
      items={[{
        id: "c",
        kind: "tool",
        status: "complete",
        toolId: "search",
        data: { hits: 2, top: "Pricing" },
      }]}
    />,
  );
  assert.match(html, /aria-expanded="false"/, "the step has details");
});

test("a structured result reads as named fields: short values inline, nested ones open near the top", () => {
  const html = renderToStaticMarkup(
    <ToolPayload
      label="Result"
      value={{
        query: "launch",
        total: 2,
        notes: [
          { id: "n7", text: "Thursdays", tags: ["cadence"], score: 0.92 },
          { id: "n3", text: "Channel", tags: [], score: 0.64 },
        ],
      }}
    />,
  );
  assert.match(html, /data-slot="tool-payload"/);
  assert.match(html, /Result<\/span>/);
  assert.match(html, /3 fields/, "the caption says what it holds");
  for (const part of ["query", "&quot;launch&quot;", "total", "notes"]) {
    assert.ok(html.includes(part), part);
  }
  assert.match(
    html,
    /aria-expanded="true"[^>]*aria-label="Collapse notes, 2 items"/,
  );
  assert.match(html, /&quot;cadence&quot;/, "nested values show");
});

test("results say when they are empty; JSON text reads as structure, other text as text", () => {
  const render = (props: Parameters<typeof ToolPayload>[0]) =>
    renderToStaticMarkup(<ToolPayload {...props} />);
  assert.match(
    render({ label: "Result", value: [] }),
    /No items\. The tool returned an empty list\./,
  );
  assert.match(
    render({ label: "Result", value: {} }),
    /No fields\. The tool returned an empty object\./,
  );
  assert.match(render({ label: "Result", value: null }), /Nothing returned\./);
  assert.match(render({ label: "Result", text: "  " }), /returned no text/);
  assert.match(render({ label: "Result", text: '{"ok":true}' }), /json-tree/);
  const plain = render({ label: "Result", text: "Saved 3 notes." });
  assert.ok(plain.includes("Saved 3 notes.") && !plain.includes("json-tree"));
  const error = render({ label: "Error", text: "Timed out.", tone: "error" });
  assert.match(error, /data-tone="error"/);
  assert.equal(parseStructured("[1, 2"), undefined, "broken JSON stays text");
  assert.equal(describeJson([1, 2, 3]), "3 items");
  assert.equal(
    previewJson({ id: "n7", text: "x".repeat(60), tags: ["a"] }),
    `{ id: "n7", text: "${"x".repeat(40)}…", tags: [1] }`,
  );
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
  assert.ok(!html.includes('data-slot="activity"'), "no row for it");
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

test("a bubble's width is a share of the column, so short text never wraps", () => {
  const [group] = groupMessages([message("and now?", ana)], () => true);
  const html = renderToStaticMarkup(<MessageGroup group={group} />);
  // The message box spans the column; the bubble inside sizes to its text.
  assert.match(
    html,
    /data-message-id="and now\?"[^>]*class="[^"]*\bw-full\b[^"]*items-end/,
  );
  assert.match(
    html,
    /data-slot="message-bubble"[^>]*max-w-\[min\(42rem,88%\)\]/,
  );
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
  assert.ok(!html.includes(">Sent<"), "neither says Sent");
});

test("the person's latest message says Sent quietly, then fades once a reply begins", () => {
  const render = (patch: Partial<ChatMessage>) =>
    renderToStaticMarkup(
      <MessageGroup
        group={{
          id: "x",
          sender: ana,
          role: "user",
          own: true,
          messages: [message("earlier", ana), message("latest", ana, patch)],
        }}
      />,
    );
  const slots = (html: string) =>
    [...html.matchAll(/data-slot="message-delivery" data-state="(\w+)"/g)]
      .map((match) => match[1]);
  const sent = render({ delivered: true });
  assert.deepEqual(slots(sent), ["sent"], "only on the latest message");
  assert.match(sent, /role="status"[^>]*data-slot="message-delivery"/);
  assert.ok(sent.includes("Sent"), sent);
  // Once a reply began it fades in place: hidden from screen readers too.
  const settled = render({ delivered: false });
  assert.deepEqual(slots(settled), ["settled"]);
  assert.match(settled, /data-state="settled" class="[^"]*opacity-0/);
  assert.match(settled, /aria-hidden="true"[^>]*>.*Sent/);
  // The same slot said Sending… first, so the change is announced once.
  assert.deepEqual(slots(render({ status: "sending" })), ["sending"]);
  // Other people's messages carry no delivery state.
  const theirs = renderToStaticMarkup(
    <MessageGroup
      group={{
        id: "y",
        sender: ana,
        role: "user",
        own: false,
        messages: [message("theirs", ana, { delivered: true })],
      }}
    />,
  );
  assert.deepEqual(slots(theirs), []);
});

test("a voice message is a compact player with its transcript one click away", () => {
  const voice = {
    kind: "audio" as const,
    mediaType: "audio/webm",
    name: "voice-message.webm",
    assetId: "v1",
    voice: true as const,
    durationMs: 7_450,
    peaks: [0.1, 0.8, 0.4, 1],
    transcript: "  Plan the launch\nby Friday.  ",
  };
  const upload = {
    kind: "audio" as const,
    mediaType: "audio/mpeg",
    name: "interview.mp3",
    url: "blob:interview",
  };
  const html = renderToStaticMarkup(
    <MessageGroup
      group={{
        id: "x",
        sender: ana,
        role: "user",
        own: true,
        messages: [
          message("m", ana, { text: "", attachments: [voice, upload] }),
        ],
      }}
      loadAsset={() => new Promise(() => {})}
    />,
  );
  // The recording: a player (play, waveform seek, length), not raw text.
  assert.match(html, /data-slot="voice-note"/);
  assert.match(html, /aria-label="Voice message, 0:07"/);
  assert.match(html, /aria-label="Loading the voice message"/);
  assert.match(html, /type="range"[^>]*aria-label="Playback position"/);
  assert.ok(html.includes(">0:07<"), "its length before the body loads");
  assert.match(html, /bg-bubble-foreground/, "drawn for the own bubble");
  // The transcript: a closed disclosure with a one-line preview.
  assert.match(html, /aria-expanded="false"[^>]*>.*Transcript/s);
  assert.ok(html.includes("Plan the launch by Friday."), "preview");
  assert.doesNotMatch(html, /Plan the launch\nby Friday/, "not the body");
  // An uploaded audio file stays an ordinary player.
  assert.equal(html.match(/data-slot="voice-note"/g)?.length, 1);
  assert.match(html, /<audio[^>]*controls[^>]*aria-label="interview.mp3"/);
});

test("a voice send says Transcribing…, and a failed one offers audio only or Retry", () => {
  const take = {
    kind: "audio" as const,
    mediaType: "audio/webm",
    voice: true as const,
    durationMs: 3_000,
    url: "blob:take",
  };
  const html = renderToStaticMarkup(
    <MessageGroup
      group={{
        id: "x",
        sender: ana,
        role: "user",
        own: true,
        messages: [
          message("one", ana, {
            text: "",
            attachments: [take],
            status: "sending",
            transcription: "pending",
          }),
          message("two", ana, {
            text: "",
            attachments: [take],
            status: "failed",
            transcription: "failed",
            error: "Couldn't transcribe.",
          }),
        ],
      }}
      onRetry={() => {}}
      onSendAudioOnly={() => {}}
      onDiscard={() => {}}
    />,
  );
  assert.ok(html.includes("Transcribing…"));
  assert.ok(!html.includes("Sending…"));
  assert.ok(html.includes("Couldn&#x27;t transcribe."));
  for (const action of ["Send audio only", "Retry", "Discard"]) {
    assert.ok(html.includes(action), action);
  }
  // A local take plays at once: no loading state.
  assert.equal(html.match(/aria-label="Play"/g)?.length, 2);
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

test("before KaTeX and highlighting load, math shows its source and code stays plain", () => {
  const html = renderToStaticMarkup(
    <Markdown>
      {"Inline $p = \\frac{c}{v}$ and\n\n$$\nx^2\n$$\n\n```ts\nconst a = 1;\n```"}
    </Markdown>,
  );
  assert.match(html, /data-slot="math-pending"[^>]*>p = \\frac\{c\}\{v\}</);
  assert.match(
    html,
    /class="math-pending-display"/,
    "display math keeps its box",
  );
  assert.ok(!html.includes("katex"));
  assert.ok(html.includes('data-slot="code-block"'), "code keeps its block");
  assert.ok(!html.includes("hljs"));
});

test("math renders with KaTeX and a MathML copy; it can never carry a link", async () => {
  await preloadMarkdown();
  const html = renderToStaticMarkup(
    <Markdown>
      {"Inline $p = \\frac{c}{v}$ and\n\n$$\n\\href{https://evil.example}{x}\n$$\n\n```ts\nconst a = 1;\n```"}
    </Markdown>,
  );
  assert.ok(html.includes('class="katex"'), html);
  assert.ok(html.includes("<math"), "assistive technology reads MathML");
  assert.ok(html.includes('class="katex-display"'), "fenced math is display");
  assert.ok(!html.includes('evil.example"'), "no link from math");
  assert.ok(!/<a\s/.test(html));
  assert.ok(html.includes("hljs-keyword"), "code is highlighted once loaded");
});

test("math written as \\( \\) and \\[ \\] renders like $ and $$; code keeps its text", async () => {
  await preloadMarkdown();
  const html = renderToStaticMarkup(
    <Markdown>
      {"Inline \\(a^2 + b^2\\) and display:\n\\[\nx = \\frac{1}{2}\n\\]\n\nCode `\\(kept\\)` here.\n\n```\n\\[ also kept \\]\n```"}
    </Markdown>,
  );
  assert.equal(html.match(/class="katex"/g)?.length, 2, html);
  assert.ok(html.includes('class="katex-display"'), "display math is a block");
  assert.ok(
    html.includes("<code>\\(kept\\)</code>"),
    "inline code is untouched",
  );
  assert.ok(html.includes("\\[ also kept \\]"), "fenced code is untouched");
  assert.equal(
    normalizeMathDelimiters("- item\n  \\[\n  z\n  \\]"),
    "- item\n\n  $$\n  z\n  $$",
    "display math stays inside its list item",
  );
});
