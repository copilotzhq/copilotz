/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import type {
  ActionTransport,
  BrowserPlugin,
  BrowserRuntime,
  BrowserViewContext,
  StorageAdapter,
} from "@copilotz/copilotz/web";
import type { FeedFrame, ThreadFeedAdapter } from "../../core/web.ts";

// Install the DOM before ReactDOM and Radix load; they detect it at import.
const window = new Window({ url: "https://app.example/" });
for (
  const name of [
    "document",
    "navigator",
    "HTMLElement",
    "HTMLInputElement",
    "HTMLTextAreaElement",
    "Element",
    "Node",
    "NodeFilter",
    "DocumentFragment",
    "MutationObserver",
    "CustomEvent",
    "Event",
    "KeyboardEvent",
    "MouseEvent",
    "PointerEvent",
    "FocusEvent",
    "getComputedStyle",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "ResizeObserver",
  ]
) {
  Object.defineProperty(globalThis, name, {
    value: (window as unknown as Record<string, unknown>)[name],
    configurable: true,
    writable: true,
  });
}
Object.defineProperty(globalThis, "window", {
  value: window,
  configurable: true,
});
let wideScreen = true;
Object.defineProperty(globalThis, "matchMedia", {
  configurable: true,
  value: (query: string) => ({
    matches: query.includes("min-width") ? wideScreen : false,
    addEventListener() {},
    removeEventListener() {},
  }),
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const { act } = React;
const { createBrowserRuntime } = await import("@copilotz/copilotz/web");
const { defineView } = await import("@copilotz/copilotz/views");
const { reactRenderer } = await import("../../web-react/index.ts");
const { uiWebPlugin, shellNavigation, shellUrlStorageAdapter } = await import(
  "../web.ts"
);
const { FixtureLive } = await import("./fixture-live.test.ts");
const document = window.document;

const tables = () => ({
  space: [
    {
      id: "s1",
      name: "Research",
      description: "Interviews and notes.",
      ownerId: "p-ana",
      memberIds: ["p-ana"],
      status: "active",
    },
    {
      id: "s2",
      name: "Ops",
      ownerId: "p-ana",
      memberIds: ["p-ana"],
      status: "active",
    },
  ],
  thread: [
    {
      id: "t1",
      name: "Interview plan",
      spaceId: "s1",
      status: "active",
      participantIds: ["p-ana", "p-north"],
      updatedAt: "2026-10-21T10:00:00.000Z",
    },
    {
      id: "t2",
      name: "Deploy checklist",
      spaceId: "s2",
      status: "active",
      participantIds: ["p-ana", "p-north"],
      updatedAt: "2026-10-21T09:00:00.000Z",
    },
    {
      id: "t3",
      name: "Loose idea",
      status: "active",
      participantIds: ["p-ana", "p-north"],
      updatedAt: "2026-10-20T09:00:00.000Z",
    },
  ],
  participant: [
    {
      id: "p-ana",
      externalId: "ana",
      participantType: "human",
      name: "Ana",
    },
    {
      id: "p-north",
      externalId: "north",
      agentId: "north",
      participantType: "agent",
      name: "North",
    },
  ],
  message: [{
    id: "m1",
    threadId: "t1",
    senderId: "p-ana",
    createdAt: "2026-10-21T09:59:00.000Z",
    content: [{
      assetId: "a",
      kind: "text",
      role: "body",
      mediaType: "text/plain",
      value: "Who should we interview first?",
    }],
    metadata: {},
  }],
});

/** A feed the test drives frame by frame. */
class TestFeed implements ThreadFeedAdapter {
  observers = new Set<(frame: FeedFrame) => void | Promise<void>>();
  cancelled: string[] = [];
  position = 0;
  observe(
    _threadId: string,
    options: Parameters<ThreadFeedAdapter["observe"]>[1],
  ): Promise<string | undefined> {
    this.observers.add(options.onFrame);
    return new Promise((resolve) =>
      options.signal.addEventListener("abort", () => {
        this.observers.delete(options.onFrame);
        resolve(undefined);
      })
    );
  }
  cancel(operationId: string): Promise<void> {
    this.cancelled.push(operationId);
    return Promise.resolve();
  }
  async emit(frame: Omit<FeedFrame, "checkpoint">) {
    const full = { ...frame, checkpoint: String(++this.position) } as FeedFrame;
    for (const observer of this.observers) await observer(full);
  }
}

const memory = (): StorageAdapter & { rows: Map<string, unknown> } => {
  const rows = new Map<string, unknown>();
  return {
    rows,
    load: (key) => rows.get(key) as never,
    save(key, value) {
      rows.set(key, structuredClone(value));
    },
  };
};

const section = (id: string, shows: string, url = true) =>
  defineView<
    { spaceId: string; threadId?: string | null },
    React.ReactNode,
    BrowserViewContext
  >({
    id,
    shows,
    renderer: "react",
    modes: ["full", "panel"],
    ...(url ? { url: true } : {}),
    render: ({ spaceId }, ctx) => (
      <p data-section={shows}>
        {`${shows} for ${spaceId} (${ctx.hints.mode})`}
      </p>
    ),
  });

const report = defineView<unknown, React.ReactNode, BrowserViewContext>({
  id: "test.report",
  shows: "testReport",
  renderer: "react",
  modes: ["full", "panel"],
  url: true,
  render(_value, ctx) {
    const state = ctx.readAction("reportQuery", { range: "week" });
    return state.status === "held"
      ? (
        <button type="button" onClick={() => state.refresh()}>
          Load report
        </button>
      )
      : <p>{`Report ${state.status}`}</p>;
  },
});

const terminal = defineView<
  { input?: { stdin?: string }; output?: { stdout?: string }; status: string },
  React.ReactNode,
  BrowserViewContext
>({
  id: "test.terminal",
  shows: "testTerminal",
  renderer: "react",
  modes: ["inline"],
  render: (call) => (
    <pre data-tool="terminal">
      {`$ ${call.input?.stdin ?? ""} [${call.status}] ${
        call.output?.stdout ?? ""
      }`}
    </pre>
  ),
});

const forkDialog = defineView<
  { threadId?: string },
  React.ReactNode,
  BrowserViewContext
>({
  id: "test.share",
  shows: "testShare",
  renderer: "react",
  modes: ["dialog"],
  render: ({ threadId }) => <p>{`Share ${threadId}`}</p>,
});

const settingsPage = defineView<
  { section?: string } | null,
  React.ReactNode,
  BrowserViewContext
>({
  id: "test.settings",
  shows: "testSettings",
  renderer: "react",
  modes: ["full"],
  url: true,
  render: (value, ctx) => (
    <div>
      <p>{`Settings: ${value?.section ?? "general"}`}</p>
      <button
        type="button"
        onClick={() =>
          ctx.show({ shows: "testSettings", value: { section: "billing" } }, {
            source: "link",
            region: "main",
          })}
      >
        Billing tab
      </button>
    </div>
  ),
});

const app: BrowserPlugin = {
  id: "test-app",
  views: {
    settingsPage,
    boards: section("test.boards", "testBoards"),
    unsafe: section("test.unsafe", "testUnsafe", false),
    report,
    terminal,
    share: forkDialog,
  },
  actions: {
    reportQuery: {
      id: "test.report",
      placement: "server",
      query: { reads: [] },
    },
    threadFork: { id: "test.fork", placement: "server" },
  },
  resources: {
    chat: {
      sender: { id: "ana", externalId: "ana", name: "Ana" },
      agents: [{ externalId: "north", agentId: "north", name: "North" }],
    },
    shell: { branding: { title: "Test app" } },
    spaceSections: {
      boards: {
        label: "Boards",
        icon: "kanban",
        order: 20,
        view: "testBoards",
        tools: ["kanban"],
      },
      unsafe: { label: "Unsafe", order: 30, view: "testUnsafe" },
      report: { label: "Report", order: 40, view: "testReport" },
    },
    headerMenu: {
      fork: { label: "Fork", icon: "git-branch", action: "threadFork" },
      share: { label: "Share", icon: "share", dialog: "testShare" },
    },
    toolRenderers: { terminal: { view: "testTerminal" } },
    userMenu: {
      settings: { label: "Settings", icon: "settings", page: "testSettings" },
    },
  },
};

type Mounted = {
  runtime: BrowserRuntime;
  live: InstanceType<typeof FixtureLive>;
  feed: TestFeed;
  calls: { alias: string; input: Record<string, unknown> }[];
  url: () => URL;
  local: ReturnType<typeof memory>;
  dispose(): Promise<void>;
};

async function mount(
  href: string,
  options: {
    local?: ReturnType<typeof memory>;
    live?: InstanceType<typeof FixtureLive>;
    /** Composed after the test app; its resources override by alias. */
    extra?: BrowserPlugin;
  } = {},
): Promise<Mounted> {
  let current = new URL(href);
  const live = options.live ?? new FixtureLive(tables());
  const feed = new TestFeed();
  const local = options.local ?? memory();
  const calls: Mounted["calls"] = [];
  const actions: ActionTransport = {
    invoke(alias, input, invocation) {
      invocation.accepted(`op-${calls.length + 1}`);
      calls.push({ alias, input: input as Record<string, unknown> });
      const data = input as Record<string, unknown>;
      if (alias === "createThreadMessage") {
        live.put("message", {
          id: String(data.id),
          threadId: String(data.threadId),
          senderId: "p-ana",
          createdAt: "2026-10-21T11:00:00.000Z",
          content: (data.content as Record<string, unknown>[]).map((part) => ({
            assetId: String(part.type),
            kind: String(part.type),
            role: part.type === "text" ? "body" : "attachment",
            mediaType: String(part.mediaType ?? "text/plain"),
            ...(part.type === "text" ? { value: part.text } : {}),
            ...(part.name ? { name: part.name } : {}),
          })),
          metadata: {},
        });
      }
      return Promise.resolve({ value: { ok: true }, seq: 1 });
    },
    cancel: () => Promise.resolve(),
  };
  const runtime: BrowserRuntime = await createBrowserRuntime({
    renderer: reactRenderer,
    plugins: [
      uiWebPlugin({ navigation: "url", preferences: "local" }),
      app,
      ...(options.extra ? [options.extra] : []),
    ],
    live,
    actions,
    adapters: { core: { feed } },
    storage: {
      url: shellUrlStorageAdapter({
        read: () => new URL(current),
        write(url) {
          current = new URL(url);
        },
      }),
      local,
    },
    show: shellNavigation(() => runtime),
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  let mounted: { dispose(): void } | undefined;
  await act(async () => {
    mounted = runtime.mount(container, { shows: "shell", value: null });
    await settle();
  });
  return {
    runtime,
    live,
    feed,
    calls,
    local,
    url: () => current,
    async dispose() {
      await act(() => {
        mounted?.dispose();
      });
      runtime.dispose();
      container.remove();
    },
  };
}

const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};
const all = (selector: string) => [...document.querySelectorAll(selector)];
function byLabel(label: string) {
  const node = all(`[aria-label="${label}"]`).at(-1);
  assert.ok(node, `No element labelled ${label}: ${document.body.innerHTML}`);
  return node as unknown as { click(): void; focus(): void };
}
function byText(selector: string, text: string) {
  const node =
    all(selector).find((element) => element.textContent?.trim() === text) ??
      all(selector).find((element) => element.textContent?.endsWith(text));
  assert.ok(node, `No ${selector} "${text}": ${document.body.textContent}`);
  return node as unknown as { click(): void };
}
async function click(node: { click(): void }) {
  await act(async () => {
    node.click();
    await settle();
  });
}
async function pointer(node: unknown) {
  // Radix menus open on pointerdown.
  await act(async () => {
    (node as { dispatchEvent(event: unknown): void }).dispatchEvent(
      new window.PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        pointerType: "mouse",
      }),
    );
    await settle();
  });
}
const main = () => document.querySelector("#shell-main")!.textContent ?? "";
const nav = (mounted: Mounted) =>
  mounted.runtime.collections.shell.get("main").value!;

test("sidebar groups by Space with No Space; the chevron expands and the name opens the Space", async () => {
  const shell = await mount("https://app.example/?chat=t1");
  try {
    const sidebar = document.querySelector('nav[aria-label="Conversations"]')!
      .textContent!;
    assert.match(
      sidebar,
      /Ops.*Research.*Interview plan.*No Space.*Loose idea/s,
    );
    assert.doesNotMatch(sidebar, /Deploy checklist/, "Ops starts collapsed");
    assert.match(main(), /Who should we interview first\?/);

    await click(byLabel("Show conversations in Ops"));
    assert.match(
      document.querySelector('nav[aria-label="Conversations"]')!.textContent!,
      /Deploy checklist/,
    );
    assert.equal(nav(shell).spaceId, null, "the chevron never opens the Space");

    await click(byText("nav button", "Ops"));
    assert.equal(nav(shell).spaceId, "s2");
    assert.equal(nav(shell).threadId, "t1", "the conversation stays selected");
    assert.ok(document.querySelector('[role="tablist"]'));
    assert.match(main(), /Overview/);
    assert.equal(shell.url().searchParams.get("space"), "s2");

    await click(byText("nav button", "Loose idea"));
    assert.equal(nav(shell).spaceId, null);
    assert.equal(nav(shell).threadId, "t3");
    assert.equal(shell.url().searchParams.get("chat"), "t3");
  } finally {
    await shell.dispose();
  }
});

test("the side panel shows the conversation's Space sections and restores its width", async () => {
  const local = memory();
  let shell = await mount("https://app.example/?chat=t1", { local });
  try {
    await click(byLabel("Show the side panel"));
    const panel = () =>
      document.querySelector('aside[aria-label="Side panel"]');
    assert.ok(panel(), "the panel opens beside the conversation");
    // Narrow panels show icon-only tabs: each keeps its name and a tooltip.
    const tabs = [...panel()!.querySelectorAll('[role="tab"]')];
    assert.deepEqual(
      tabs.map((tab) => tab.getAttribute("aria-label")),
      ["Overview", "Chats", "Boards", "Unsafe", "Report", "Members"],
    );
    assert.ok(
      tabs.every((tab) => tab.getAttribute("data-slot") === "tooltip-trigger"),
    );
    await click(byLabel("Boards"));
    assert.match(panel()!.textContent!, /testBoards for s1 \(panel\)/);
    assert.equal(nav(shell).section, "boards");
    const handle = byLabel("Resize side panel") as unknown as {
      dispatchEvent(event: unknown): void;
    };
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        handle.dispatchEvent(
          new window.KeyboardEvent("keydown", {
            key: "ArrowLeft",
            bubbles: true,
          }),
        );
        await settle();
      });
    }
    await shell.runtime.flushStorage();
    const saved =
      (local.rows.get("shellPreferences") as { panelWidth: number }[])[0]
        .panelWidth;
    assert.equal(saved, 420 + 3 * 16);
    await shell.dispose();
    shell = await mount("https://app.example/?chat=t1&panel=1", { local });
    assert.equal(
      (panel() as unknown as { style: { width: string } }).style.width,
      `${saved}px`,
    );
  } finally {
    await shell.dispose();
  }
});

test("a narrow screen keeps the same model: nothing closes on navigation", async () => {
  wideScreen = false;
  const shell = await mount("https://app.example/?chat=t1&panel=1");
  try {
    await click(byLabel("Expand sidebar"));
    const preferences = () =>
      shell.runtime.collections.shellPreferences.get("main").value!;
    assert.equal(preferences().sidebar, "expanded", "it overlays when narrow");
    await click(byText("nav button", "Loose idea"));
    assert.equal(preferences().sidebar, "expanded");
    assert.equal(nav(shell).panel, true, "the panel stays open");
    assert.equal(nav(shell).threadId, "t3");
  } finally {
    wideScreen = true;
    await shell.dispose();
  }
});

test("the composer previews, removes and sends attachments with the text", async () => {
  const shell = await mount("https://app.example/?chat=t1");
  try {
    const input = document.querySelector('input[type="file"]')!;
    const files = [
      new File(["a,b\n1,2"], "data.csv", { type: "text/csv" }),
      new File(["%PDF"], "brief.pdf", { type: "application/pdf" }),
    ];
    Object.defineProperty(input, "files", { value: files, configurable: true });
    await act(async () => {
      input.dispatchEvent(new window.Event("change", { bubbles: true }));
      await settle();
    });
    const tray = () =>
      document.querySelector('ul[aria-label="Attachments"]')?.textContent ?? "";
    assert.match(tray(), /data\.csv.*brief\.pdf/s);
    await click(byLabel("Remove brief.pdf"));
    assert.doesNotMatch(tray(), /brief\.pdf/);
    const field = document.querySelector('textarea[aria-label="Message"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(field, "Here is the data");
      field.dispatchEvent(new window.Event("input", { bubbles: true }));
      await settle();
    });
    await act(async () => {
      document.querySelector('form[aria-label="Message composer"]')!
        .dispatchEvent(
          new window.Event("submit", { bubbles: true, cancelable: true }),
        );
      await settle();
    });
    const sent = shell.calls.find((call) =>
      call.alias === "createThreadMessage"
    );
    assert.ok(sent, JSON.stringify(shell.calls));
    assert.equal(sent.input.threadId, "t1");
    assert.equal("recipientIds" in sent.input, false, "Core picks agents");
    assert.deepEqual(
      (sent.input.content as { type: string; name?: string }[]).map((part) =>
        part.name ?? part.type
      ),
      ["text", "data.csv"],
    );
    assert.equal(tray(), "", "the tray clears after sending");
    assert.match(main(), /Here is the data/);
  } finally {
    await shell.dispose();
  }
});

test("live replies stream with tool activity and app tool renderers; Stop cancels the run", async () => {
  const shell = await mount("https://app.example/?chat=t1");
  try {
    const meta = (lane: string) => ({
      llmAttemptId: "run-1",
      lane,
      providerAttemptIndex: 0,
      copilotzCore: {
        schema: "copilotz.core.llm-stream.v1",
        agent: { id: "north", name: "North" },
      },
    });
    const open = (streamId: string, metadata: Record<string, unknown>) =>
      shell.feed.emit({
        kind: "output",
        output: {
          type: "stream.output",
          operationId: "op-live",
          streamId,
          role: "text",
          kind: "text",
          mediaType: "text/plain",
          metadata,
        },
      } as never);
    const bytes = (text: string) => new TextEncoder().encode(text);
    await act(async () => {
      await open("tools", meta("tool-calls"));
      await shell.feed.emit({
        kind: "stream-chunk",
        streamId: "tools",
        offset: 0,
        bytes: bytes(
          JSON.stringify({
            draftId: "d1",
            toolName: "terminal",
            phase: "complete",
            toolCallId: "c1",
            delta: '{"stdin":"npm test"}',
          }) + "\n",
        ),
      } as never);
      await shell.feed.emit({
        kind: "output",
        output: {
          type: "action.invoked",
          operationId: "op-live",
          data: {
            actionRunId: "run-term",
            metadata: { copilotzToolAction: { toolCallId: "c1" } },
          },
        },
      } as never);
      await open("stdout", {
        sourceActionRunId: "run-term",
        channel: "stdout",
      });
      await shell.feed.emit({
        kind: "stream-chunk",
        streamId: "stdout",
        offset: 0,
        bytes: bytes("4 passing"),
      } as never);
      await open("answer", meta("content"));
      await shell.feed.emit({
        kind: "stream-chunk",
        streamId: "answer",
        offset: 0,
        bytes: bytes("Running the suite"),
      } as never);
      await new Promise((r) => setTimeout(r, 80));
      await settle();
    });
    const live = () =>
      document.querySelector('[data-slot="thread-live"]')?.textContent ?? "";
    assert.match(live(), /North/);
    assert.match(live(), /Using terminal/);
    assert.match(live(), /Running the suite/);
    assert.match(
      document.querySelector('[data-tool="terminal"]')?.textContent ?? "",
      /\$ npm test \[running\] 4 passing/,
    );
    assert.ok(
      document.querySelector('[data-slot="markdown"][data-streaming]'),
      "the reply shows its caret while streaming",
    );
    await click(byLabel("Stop the response"));
    assert.deepEqual(shell.feed.cancelled, ["op-live"]);
  } finally {
    await shell.dispose();
  }
});

test("a link holds a section's query until Load, and refuses a View without url", async () => {
  const shell = await mount(
    "https://app.example/?space=s1&section=report",
  );
  try {
    assert.equal(nav(shell).origin, "url");
    assert.equal(
      shell.calls.filter((call) => call.alias === "reportQuery").length,
      0,
      "URL state must not run the query",
    );
    await click(byText("button", "Load report"));
    assert.deepEqual(
      shell.calls.filter((call) => call.alias === "reportQuery").map((call) =>
        call.input
      ),
      [{ range: "week" }],
    );
    await shell.dispose();
    const original = console.error;
    console.error = () => {}; // React reports the contained error.
    const refused = await mount(
      "https://app.example/?space=s1&section=unsafe",
    );
    console.error = original;
    try {
      assert.match(main(), /cannot be opened from a URL/);
      assert.doesNotMatch(main(), /testUnsafe for/);
      // An in-app click is trusted and renders it.
      await click(byLabel("Boards"));
      await click(byLabel("Unsafe"));
      assert.match(main(), /testUnsafe for s1 \(full\)/);
    } finally {
      await refused.dispose();
    }
  } catch (error) {
    await shell.dispose().catch(() => {});
    throw error;
  }
});

test("header menu items run their Action with the conversation or open their dialog", async () => {
  const shell = await mount("https://app.example/?chat=t1");
  try {
    await pointer(byLabel("Conversation options"));
    await click(byText('[role="menuitem"]', "Fork"));
    assert.deepEqual(
      shell.calls.filter((call) => call.alias === "threadFork").map((call) =>
        call.input
      ),
      [{ threadId: "t1", spaceId: "s1" }],
    );
    await pointer(byLabel("Conversation options"));
    await click(byText('[role="menuitem"]', "Share"));
    assert.match(
      document.querySelector('[role="dialog"]')?.textContent ?? "",
      /Share t1/,
    );
  } finally {
    await shell.dispose();
  }
});

test("a user menu page opens in main, keeps its section in the URL and closes back", async () => {
  const shell = await mount("https://app.example/?chat=t1");
  try {
    await pointer(byLabel("Account: Ana"));
    await click(byText('[role="menuitem"]', "Settings"));
    assert.match(main(), /Settings: general/);
    assert.equal(shell.url().searchParams.get("page"), "testSettings");
    assert.equal(
      document.querySelector('[data-slot="shell-header"] h1')?.textContent,
      "Settings",
    );
    await click(byText("button", "Billing tab"));
    assert.match(main(), /Settings: billing/);
    assert.equal(shell.url().searchParams.get("section"), "billing");
    await click(byLabel("Close"));
    assert.equal(nav(shell).page, null);
    assert.equal(nav(shell).section, null);
    assert.equal(shell.url().searchParams.get("page"), null);
    assert.equal(nav(shell).threadId, "t1", "the conversation is back");
    assert.doesNotMatch(main(), /Settings/);
  } finally {
    await shell.dispose();
  }
  // A link restores the page and its section.
  const linked = await mount(
    "https://app.example/?page=testSettings&section=billing",
  );
  try {
    assert.match(main(), /Settings: billing/);
  } finally {
    await linked.dispose();
  }
});

test("Views share live reads: a conversation with its panel open uses five, people in one", async () => {
  const shell = await mount("https://app.example/?chat=t1&panel=1");
  try {
    assert.deepEqual(shell.live.active, [
      'message {"where":{"threadId":"t1"},"order":{"field":"createdAt","direction":"desc"},"limit":100}',
      'participant {"where":{"id":{"in":["p-ana","p-north"]}},"limit":2}',
      'space {"limit":200}',
      'thread {"order":{"field":"id","direction":"desc"},"limit":200}',
      'thread {"where":{"spaceId":"s1"},"order":{"field":"id","direction":"desc"},"limit":200}',
    ]);
    await act(async () => {
      shell.runtime.actions.shellNewChat({});
      await settle();
    });
    assert.equal(shell.live.subscriptionCount, 2, "closed Views release reads");
  } finally {
    await shell.dispose();
  }
});

test("live read limits show a friendly state, never a raw error", async () => {
  const ordered = new FixtureLive(tables());
  ordered.idOrderOnly = true;
  const refused = await mount("https://app.example/?chat=t1", {
    live: ordered,
  });
  try {
    assert.match(main(), /Live updates unavailable/);
    assert.doesNotMatch(main(), /subscription_|refused\./i);
  } finally {
    await refused.dispose();
  }
  const crowded = new FixtureLive(tables());
  crowded.maxSubscriptions = 2;
  const full = await mount("https://app.example/?chat=t1", { live: crowded });
  try {
    assert.match(document.body.textContent ?? "", /Too many live views open/);
    assert.doesNotMatch(
      document.body.textContent ?? "",
      /capacity exceeded|subscription_/i,
    );
  } finally {
    await full.dispose();
  }
});

test("arrow keys move through Spaces and chats; Right and Left show and hide a Space's chats", async () => {
  const shell = await mount("https://app.example/?chat=t1");
  try {
    const items = () =>
      all('nav[aria-label="Conversations"] [data-nav-item]') as unknown as {
        focus(): void;
        textContent: string | null;
        dispatchEvent(event: unknown): void;
      }[];
    const press = async (key: string) => {
      await act(async () => {
        (document.activeElement as unknown as {
          dispatchEvent(event: unknown): void;
        }).dispatchEvent(
          new window.KeyboardEvent("keydown", { key, bubbles: true }),
        );
        await settle();
      });
    };
    const first = items()[0];
    first.focus();
    await press("ArrowDown");
    assert.equal(document.activeElement, items()[1] as unknown);
    await press("End");
    assert.equal(document.activeElement, items().at(-1) as unknown);
    await press("Home");
    assert.equal(document.activeElement, items()[0] as unknown);
    // The first Space is collapsed: Right shows its chats.
    const before = items().length;
    await press("ArrowRight");
    assert.ok(items().length > before, "its chats are listed");
    await press("ArrowLeft");
    assert.equal(items().length, before);
  } finally {
    await shell.dispose();
  }
});

test("search finds chats by title and by Space name", async () => {
  const shell = await mount("https://app.example/?chat=t1");
  try {
    const search = document.querySelector(
      'nav[aria-label="Conversations"]',
    )!.parentElement!.querySelector('input[type="search"]')!;
    const type = async (value: string) =>
      await act(async () => {
        Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          "value",
        )!.set!.call(search, value);
        search.dispatchEvent(new window.Event("input", { bubbles: true }));
        await settle();
      });
    const list = () =>
      document.querySelector('nav[aria-label="Conversations"]')!.textContent!;
    await type("deploy");
    assert.match(list(), /Deploy checklist/);
    assert.doesNotMatch(list(), /Interview plan|Loose idea/);
    await type("research");
    assert.match(list(), /Interview plan/);
    assert.doesNotMatch(list(), /Deploy checklist/);
    await type("zzz");
    assert.match(list(), /Nothing matches “zzz”/);
  } finally {
    await shell.dispose();
  }
});

test("dragging a chat onto a Space moves it there", async () => {
  const shell = await mount("https://app.example/?chat=t3");
  try {
    const data = new Map<string, string>();
    const transfer = {
      types: ["application/x-copilotz-thread"],
      files: [],
      dropEffect: "none",
      effectAllowed: "all",
      setData: (type: string, value: string) => data.set(type, value),
      getData: (type: string) => data.get(type) ?? "",
    };
    const fire = (target: unknown, type: string) =>
      act(async () => {
        const event = new window.Event(type, {
          bubbles: true,
          cancelable: true,
        });
        Object.defineProperty(event, "dataTransfer", { value: transfer });
        (target as { dispatchEvent(event: unknown): void }).dispatchEvent(
          event,
        );
        await settle();
      });
    const row = byText("nav button", "Loose idea");
    await fire(row, "dragstart");
    const research = byText("nav button", "Research") as unknown as {
      closest(selector: string): unknown;
    };
    const group = research.closest("li");
    await fire(group, "dragover");
    await fire(group, "drop");
    assert.deepEqual(
      shell.calls.filter((call) => call.alias === "spaces").map((call) =>
        call.input
      ),
      [{
        operation: "attach",
        spaceId: "s1",
        collection: "thread",
        recordId: "t3",
      }],
    );
    assert.match(
      document.querySelector('[aria-label="Notifications"]')!.textContent!,
      /Moved to Research/,
    );
  } finally {
    await shell.dispose();
  }
});

test("an app can turn Spaces off: no switch and no Space data, chats stay", async () => {
  const shell = await mount("https://app.example/?chat=t1", {
    extra: {
      id: "no-spaces",
      resources: { shell: { features: { spaces: false } } },
    },
  });
  try {
    assert.equal(
      document.querySelector('[aria-label="Group conversations"]'),
      null,
    );
    const list = document.querySelector('nav[aria-label="Conversations"]')!
      .textContent!;
    assert.match(list, /Interview plan.*Deploy checklist.*Loose idea/s);
    assert.doesNotMatch(list, /Research|No Space/);
  } finally {
    await shell.dispose();
  }
});

test("an app replaces the agent selector with its own View", async () => {
  const shell = await mount("https://app.example/?chat=t1", {
    extra: {
      id: "team-picker",
      views: {
        picker: defineView<
          { threadId: string },
          React.ReactNode,
          BrowserViewContext
        >({
          id: "app.teamPicker",
          shows: "agentSelector",
          renderer: "react",
          modes: ["full", "panel"],
          render: ({ threadId }) => (
            <button type="button">{`Team for ${threadId}`}</button>
          ),
        }),
      },
      resources: {
        views: {
          // One preference per mode both Views declare.
          prefer: ["full", "panel"].map((mode) => ({
            shows: "agentSelector",
            mode,
            renderer: "react",
            view: "app.teamPicker",
          })),
        },
      },
    },
  });
  try {
    assert.match(
      document.querySelector('[data-slot="shell-header"]')!.textContent!,
      /Team for t1/,
    );
  } finally {
    await shell.dispose();
  }
});
