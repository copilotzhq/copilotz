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
let phoneScreen = false;
Object.defineProperty(globalThis, "matchMedia", {
  configurable: true,
  value: (query: string) => ({
    matches: query.includes("min-width")
      ? wideScreen
      : query.includes("max-width: 767px")
      ? phoneScreen
      : false,
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
const {
  bindShellSession,
  uiWebPlugin,
  shellNavigation,
  shellUrlStorageAdapter,
} = await import(
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
  /** Asset bodies by id, for results and attachments read on demand. */
  bodies = new Map<string, string>();
  /** Error codes by asset id, as Core HTTP refuses a read. */
  refusals = new Map<string, string>();
  assetReads: string[] = [];
  asset(
    _threadId: string,
    messageId: string,
    assetId: string,
  ): Promise<Blob> {
    this.assetReads.push(`${messageId}/${assetId}`);
    const body = this.bodies.get(assetId);
    const code = this.refusals.get(assetId);
    if (code) {
      return Promise.reject(
        Object.assign(new Error("Not found"), { status: 404, code }),
      );
    }
    return body === undefined
      ? Promise.reject(new Error("Not found"))
      : Promise.resolve(new Blob([body], { type: "application/json" }));
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
  {
    input?: { stdin?: string };
    output?: { stdout?: string };
    data?: { stdout?: string; exitCode?: number };
    status: string;
  },
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
        call.output?.stdout ?? call.data?.stdout ?? ""
      }${call.data ? ` (exit ${call.data.exitCode})` : ""}`}
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
        params: ["board", "card"],
      },
      unsafe: { label: "Unsafe", order: 30, view: "testUnsafe" },
      report: {
        label: "Report",
        order: 40,
        view: "testReport",
        params: ["range"],
      },
    },
    headerMenu: {
      fork: { label: "Fork", icon: "git-branch", action: "threadFork" },
      share: { label: "Share", icon: "share", dialog: "testShare" },
    },
    toolRenderers: {
      terminal: { view: "testTerminal", live: true, audience: "technical" },
    },
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
  /** Fail the next createThread after creating it (an observe error). */
  failCreateOnce?: () => boolean;
  url: () => URL;
  local: ReturnType<typeof memory>;
  container: {
    querySelector(selector: string): unknown;
    textContent: string | null;
  };
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
  const hooks: Partial<Mounted> = {};
  const actions: ActionTransport = {
    invoke(alias, input, invocation) {
      invocation.accepted(`op-${calls.length + 1}`);
      calls.push({ alias, input: input as Record<string, unknown> });
      const data = input as Record<string, unknown>;
      if (alias === "createThread") {
        const id = String(data.id);
        if (live.get("thread", id)) {
          return Promise.reject(
            Object.assign(new Error("Record already exists."), {
              code: "collection_conflict",
              status: 409,
            }),
          );
        }
        live.put("thread", {
          id,
          name: String(data.name ?? "New conversation"),
          status: "active",
          participantIds: ["p-ana", "p-north"],
          updatedAt: new Date().toISOString(),
        });
        if (hooks.failCreateOnce?.()) {
          return Promise.reject(new Error("Internal application error"));
        }
      }
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
        // As Core does: a visible message records activity on its thread.
        live.patch("thread", String(data.threadId), {
          updatedAt: new Date().toISOString(),
          lastMessageId: String(data.id),
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
  return Object.assign(hooks, {
    runtime,
    live,
    feed,
    calls,
    local,
    container: container as unknown as Mounted["container"],
    url: () => current,
    async dispose() {
      await act(() => {
        mounted?.dispose();
      });
      runtime.dispose();
      container.remove();
    },
  });
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

test("sidebar groups by Space, No Space too; the chevron expands and the name opens the Space", async () => {
  const shell = await mount("https://app.example/?chat=t1");
  try {
    const sidebar = () =>
      document.querySelector('nav[aria-label="Conversations"]')!.textContent!;
    assert.match(
      sidebar(),
      /Ops.*Research.*Interview plan.*No Space.*New Space/s,
    );
    assert.doesNotMatch(sidebar(), /Deploy checklist/, "Ops starts collapsed");
    assert.doesNotMatch(sidebar(), /Loose idea/, "No Space starts collapsed");
    const noSpace = byText("nav button", "No Space") as unknown as {
      getAttribute(name: string): string | null;
      click(): void;
      closest(selector: string): { textContent: string | null };
    };
    assert.equal(noSpace.getAttribute("aria-expanded"), "false");
    assert.match(
      noSpace.closest("div")!.textContent ?? "",
      /No Space1$/,
      "a collapsed group shows a count of its chats",
    );
    assert.match(main(), /Who should we interview first\?/);
    // No Space has no page: its name shows its chats, as a chevron does.
    await click(noSpace);
    assert.match(sidebar(), /No Space.*Loose idea.*New Space/s);
    assert.deepEqual(
      shell.runtime.collections.shellPreferences.get("main").value!.expanded,
      ["ana/~none"],
      "remembered for this person",
    );

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

test("a tablet keeps the same model: nothing closes on navigation", async () => {
  wideScreen = false;
  const shell = await mount("https://app.example/?chat=t1&panel=1");
  try {
    await click(byLabel("Expand sidebar"));
    const preferences = () =>
      shell.runtime.collections.shellPreferences.get("main").value!;
    assert.equal(preferences().sidebar, "expanded", "it overlays when narrow");
    await click(byLabel("Show conversations in No Space"));
    await click(byText("nav button", "Loose idea"));
    assert.equal(preferences().sidebar, "expanded");
    assert.equal(nav(shell).panel, true, "the panel stays open");
    assert.equal(nav(shell).threadId, "t3");
  } finally {
    wideScreen = true;
    await shell.dispose();
  }
});

test("on a phone the sidebar is a drawer: the menu opens it, picking a chat, Escape or its close button closes it", async () => {
  wideScreen = false;
  phoneScreen = true;
  const shell = await mount("https://app.example/?chat=t1");
  try {
    const drawer = () => document.querySelector("#shell-sidebar")!;
    const overlay = () =>
      shell.runtime.collections.shellOverlay.get("main").value!;
    const inert = () =>
      document.querySelector("#shell-main")!.closest("[inert]") !== null;
    assert.equal(drawer().getAttribute("data-state"), "closed");
    assert.equal(drawer().getAttribute("role"), null, "no dialog while hidden");
    assert.ok(!inert());
    const menu = byLabel("Open menu") as unknown as {
      click(): void;
      getAttribute(name: string): string | null;
    };
    assert.equal(menu.getAttribute("aria-controls"), "shell-sidebar");
    await click(menu);
    assert.equal(overlay().drawer, true);
    assert.equal(drawer().getAttribute("role"), "dialog");
    assert.equal(drawer().getAttribute("aria-modal"), "true");
    assert.ok(inert(), "the page behind is inert");
    // Showing a group's chats keeps it open; picking a chat closes it.
    await click(byLabel("Show conversations in Ops"));
    assert.equal(overlay().drawer, true);
    await click(byText("nav button", "Deploy checklist"));
    assert.equal(overlay().drawer, false);
    assert.equal(nav(shell).threadId, "t2");
    assert.ok(!inert());

    await click(menu);
    await act(async () => {
      // The shell listens on the global, as it does on a page's window; the
      // global's own event class (Event itself is the DOM's here) carries it.
      globalThis.dispatchEvent(
        Object.assign(new MessageEvent("keydown", { cancelable: true }), {
          key: "Escape",
        }),
      );
      await settle();
    });
    assert.equal(overlay().drawer, false, "Escape closes it");

    await click(menu);
    await click(byLabel("Close menu"));
    assert.equal(overlay().drawer, false);
    assert.equal(
      shell.runtime.collections.shellPreferences.get("main").value!.sidebar,
      "auto",
      "the rail preference is the desktop's alone",
    );

    // The side panel is a full-screen sheet over an inert page.
    await click(byLabel("Show the side panel"));
    const panel = document.querySelector('aside[aria-label="Side panel"]')!;
    assert.match(panel.className, /max-md:fixed/);
    assert.match(panel.className, /max-md:inset-0/);
    assert.ok(inert(), "the sheet covers the page");
  } finally {
    wideScreen = true;
    phoneScreen = false;
    await shell.dispose();
  }
});

test("opening a chat shows its group again, and each group's state is remembered", async () => {
  const local = memory();
  let shell = await mount("https://app.example/?chat=t3", { local });
  const list = () =>
    document.querySelector('nav[aria-label="Conversations"]')!.textContent!;
  try {
    assert.match(list(), /Loose idea/, "the open chat's group shows");
    await click(byLabel("Hide conversations in No Space"));
    assert.doesNotMatch(list(), /Loose idea/, "until the person hides it");
    await click(byLabel("Show conversations in Ops"));
    await act(async () => {
      shell.runtime.actions.shellOpenThread({ threadId: "t1" });
      await settle();
    });
    await act(async () => {
      shell.runtime.actions.shellOpenThread({ threadId: "t3" });
      await settle();
    });
    assert.match(list(), /Loose idea/, "opening it again shows it");
    await shell.runtime.flushStorage();
    await shell.dispose();
    shell = await mount("https://app.example/?chat=t1", { local });
    assert.match(list(), /Deploy checklist/, "Ops stays expanded");
    assert.doesNotMatch(list(), /Loose idea/);
  } finally {
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
    assert.deepEqual(
      sent.input.recipientIds,
      ["p-north"],
      "no mention addresses the thread's default agent only",
    );
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
    assert.match(live(), /Running the suite/);
    // A technical live view is a slim strip until the reader watches it.
    const frame = () =>
      document.querySelector('[data-slot="live-tool"][data-tool="terminal"]');
    assert.match(frame()?.textContent ?? "", /Using terminal…/);
    assert.match(frame()?.textContent ?? "", /Watch/);
    assert.doesNotMatch(frame()?.textContent ?? "", /4 passing/);
    await click(byText("button", "Watch"));
    assert.match(
      frame()?.textContent ?? "",
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

test("a section's tab gets a dot when an agent uses its tool, and none when the call failed", async () => {
  const shell = await mount("https://app.example/?chat=t1");
  try {
    await click(byLabel("Show the side panel"));
    const boards = () =>
      document.querySelector(
        'aside[aria-label="Side panel"] [role="tab"][aria-label^="Boards"]',
      )?.getAttribute("aria-label");
    assert.equal(boards(), "Boards");
    await act(async () => {
      await shell.feed.emit({
        kind: "output",
        output: {
          type: "stream.output",
          operationId: "op-board",
          streamId: "tools",
          role: "text",
          kind: "text",
          mediaType: "text/plain",
          metadata: {
            llmAttemptId: "run-board",
            lane: "tool-calls",
            providerAttemptIndex: 0,
            copilotzCore: {
              schema: "copilotz.core.llm-stream.v1",
              agent: { id: "north", name: "North" },
            },
          },
        },
      } as never);
      await shell.feed.emit({
        kind: "stream-chunk",
        streamId: "tools",
        offset: 0,
        bytes: new TextEncoder().encode(
          JSON.stringify({
            draftId: "d1",
            toolName: "kanban",
            phase: "complete",
            toolCallId: "c-board",
            delta: '{"action":"create_board"}',
          }) + "\n",
        ),
      } as never);
      await new Promise((r) => setTimeout(r, 80));
      await settle();
    });
    assert.equal(boards(), "Boards, new activity");
    await act(async () => {
      shell.live.put("message", {
        id: "r-board",
        threadId: "t1",
        senderId: "p-north",
        createdAt: "2026-10-21T10:05:00.000Z",
        content: [{ kind: "text", role: "tool.output", value: "Denied." }],
        metadata: {
          toolInvocation: { id: "c-board" },
          toolStatus: "failed",
        },
      });
      await settle();
    });
    assert.equal(boards(), "Boards", "a failed call lights no dot");
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
      'space {"order":{"field":"name","direction":"asc"},"limit":200}',
      'thread {"order":{"field":"updatedAt","direction":"desc"},"limit":200}',
      'thread {"where":{"spaceId":"s1"},"order":{"field":"updatedAt","direction":"desc"},"limit":200}',
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

test("refused live reads show a friendly state by reason, never a raw error", async () => {
  for (
    const [reason, copy] of [
      ["query_unsupported", /Live updates unavailable/],
      ["limit_exceeded", /Too much to follow live/],
      ["unbound_collection", /Not available here/],
      ["forbidden", /No access to these messages/],
      ["unavailable", /Couldn't load messages/],
    ] as const
  ) {
    const live = new FixtureLive(tables());
    live.refusals.set("message", { code: "subscription_failed", reason });
    const refused = await mount("https://app.example/?chat=t1", { live });
    try {
      assert.match(main(), copy, reason);
      assert.doesNotMatch(main(), /subscription_|refused\.|_/i, reason);
    } finally {
      await refused.dispose();
    }
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

test("a JSON tool result is read on demand, bounded, and reaches the step and the renderer", async () => {
  const shell = await mount("https://app.example/?chat=t1");
  try {
    shell.feed.bodies.set(
      "json-run",
      JSON.stringify({ stdout: "14 passed", exitCode: 0 }),
    );
    shell.feed.bodies.set(
      "json-big",
      JSON.stringify({ blob: "x".repeat(300_000) }),
    );
    const call = (id: string, action: string, at: string) => ({
      id: `m-${id}`,
      threadId: "t1",
      senderId: "p-north",
      createdAt: at,
      content: [],
      metadata: {
        llmToolCalls: [{ id, action, input: { stdin: "deno task test" } }],
      },
    });
    const result = (id: string, assetId: string, at: string) => ({
      id: `r-${id}`,
      threadId: "t1",
      senderId: "p-tool",
      createdAt: at,
      // As the window read returns JSON content: a reference, not a value.
      content: [{
        assetId,
        kind: "json",
        role: "tool.output",
        mediaType: "application/json",
        resolve: false,
      }],
      metadata: { toolInvocation: { id }, toolStatus: "completed" },
    });
    await act(async () => {
      shell.live.put("participant", {
        id: "p-tool",
        participantType: "tool",
        name: "terminal",
      });
      shell.live.put(
        "message",
        call("c-run", "terminal", "2026-10-21T10:01:00.000Z"),
        result("c-run", "json-run", "2026-10-21T10:01:01.000Z"),
        call("c-big", "search", "2026-10-21T10:02:00.000Z"),
        result("c-big", "json-big", "2026-10-21T10:02:01.000Z"),
      );
      await settle();
    });
    assert.ok(
      !shell.feed.assetReads.includes("r-c-big/json-big"),
      "a closed step reads nothing",
    );
    // The settled terminal is a strip; shown, its card reads its JSON
    // result once and the renderer draws it.
    assert.ok(!shell.feed.assetReads.includes("r-c-run/json-run"));
    await click(byText("button", "Show"));
    await settle();
    assert.match(
      document.querySelector('[data-slot="live-tool"][data-tool="terminal"]')
        ?.textContent ?? "",
      /14 passed \(exit 0\)/,
    );
    // A reply's one background step is its row; its details read the
    // JSON, and one over the bound says so instead.
    assert.match(
      document.querySelector('[data-slot="activity"]')?.textContent ?? "",
      /Used search · 1s/,
    );
    assert.ok(!shell.feed.assetReads.includes("r-c-big/json-big"));
    await click(byText("button", "View details"));
    await settle();
    assert.match(main(), /The result is too large to show here\./);
    assert.deepEqual(shell.feed.assetReads, [
      "r-c-run/json-run",
      "r-c-big/json-big",
    ]);
  } finally {
    await shell.dispose();
  }
});

test("a tool's output the viewer may not see says so quietly, with no read and no retry", async () => {
  const shell = await mount("https://app.example/?chat=t1");
  try {
    shell.feed.refusals.set("json-hidden", "message_content_not_found");
    const call = (id: string, at: string) => ({
      id: `m-${id}`,
      threadId: "t1",
      senderId: "p-north",
      createdAt: at,
      content: [],
      metadata: {
        llmToolCalls: [{ id, action: "search_memory", input: { limit: 20 } }],
      },
    });
    const result = (
      id: string,
      at: string,
      visibility?: Record<string, unknown>,
    ) => ({
      id: `r-${id}`,
      threadId: "t1",
      senderId: "p-tool",
      createdAt: at,
      ...(visibility ? { visibility } : {}),
      content: [{
        assetId: id === "c-status" ? "json-status" : "json-hidden",
        kind: "json",
        role: "tool.output",
        mediaType: "application/json",
        resolve: false,
      }],
      metadata: { toolInvocation: { id }, toolStatus: "completed" },
    });
    await act(async () => {
      shell.live.put("participant", {
        id: "p-tool",
        participantType: "tool",
        name: "search_memory",
      });
      shell.live.put(
        "message",
        call("c-status", "2026-10-21T10:01:00.000Z"),
        // Status only: the agent asked, so only the agent sees the output.
        result("c-status", "2026-10-21T10:01:01.000Z", {
          kind: "tool",
          policy: "public_status",
          requesterId: "p-north",
        }),
        call("c-refused", "2026-10-21T10:02:00.000Z"),
        result("c-refused", "2026-10-21T10:02:01.000Z"),
      );
      await settle();
    });
    // Each reply's row is its one step, with how long it took. Status
    // only: no details to open, and a quiet note says whose they are.
    const rows = all('[data-slot="activity"]').map((row) => row.textContent);
    assert.equal(rows.length, 2);
    assert.match(rows[0] ?? "", /Used search memory · 1s/);
    assert.match(rows[0] ?? "", /Output visible to the agent only$/);
    assert.match(rows[1] ?? "", /View details$/);
    assert.equal(
      all("button").filter((button) => button.textContent === "View details")
        .length,
      1,
    );
    // The other result says so once its read is refused.
    await click(byText("button", "View details"));
    await settle();
    const text = main();
    assert.match(text, /Output visible to the agent only\./);
    assert.doesNotMatch(text, /couldn't be loaded|Try again/);
    assert.match(text, /limit: 20/, "the input the read delivered shows");
    assert.deepEqual(
      shell.feed.assetReads,
      ["r-c-refused/json-hidden"],
      "metadata decides up front; a refused read is not retried",
    );
  } finally {
    await shell.dispose();
  }
});

test("Show technical details is each person's: it opens the steps and technical live views", async () => {
  const local = memory();
  const shell = await mount("https://app.example/?chat=t1", { local });
  try {
    shell.feed.bodies.set(
      "json-run",
      JSON.stringify({ stdout: "14 passed", exitCode: 0 }),
    );
    await act(async () => {
      shell.live.put("participant", {
        id: "p-tool",
        participantType: "tool",
        name: "tool",
      });
      shell.live.put(
        "message",
        {
          id: "m-work",
          threadId: "t1",
          senderId: "p-north",
          createdAt: "2026-10-21T10:01:00.000Z",
          content: [{ kind: "text", value: "All set." }],
          metadata: {
            llmToolCalls: [
              { id: "c-find", action: "search_memory", input: { q: "x" } },
              { id: "c-web", action: "web_search", input: { query: "y" } },
              { id: "c-run", action: "terminal", input: { stdin: "ls" } },
            ],
          },
        },
        ...[["c-find", "completed"], ["c-web", "failed"], [
          "c-run",
          "completed",
        ]].map(([id, status], index) => ({
          id: `r-${id}`,
          threadId: "t1",
          senderId: "p-tool",
          createdAt: `2026-10-21T10:01:0${index + 2}.000Z`,
          content: id === "c-run"
            ? [{
              assetId: "json-run",
              kind: "json",
              role: "tool.output",
              mediaType: "application/json",
              resolve: false,
            }]
            : [{
              kind: "text",
              value: status === "failed" ? "Timed out" : "[]",
            }],
          metadata: { toolInvocation: { id }, toolStatus: status },
        })),
      );
      await settle();
    });
    // Calm by default: one row for the background work, a closed strip.
    const row = () =>
      document.querySelector('[data-slot="activity"] > button')!;
    assert.equal(row().getAttribute("aria-expanded"), "false");
    assert.match(row().textContent ?? "", /Used 2 tools · 1 failed · 3s/);
    const strip = () =>
      document.querySelector('[data-slot="live-tool"] > button')!;
    assert.equal(strip().getAttribute("aria-expanded"), "false");
    assert.deepEqual(shell.feed.assetReads, [], "nothing read while closed");
    await pointer(byLabel("Account: Ana"));
    const toggle = all('[role="menuitemcheckbox"]').find((item) =>
      item.textContent?.startsWith("Show technical details")
    );
    assert.ok(toggle, "the account menu offers the preference");
    assert.equal(toggle.getAttribute("aria-checked"), "false");
    await click(toggle as unknown as { click(): void });
    assert.deepEqual(
      shell.runtime.collections.shellPreferences.get("main").value!.technical,
      ["ana"],
      "kept for this person",
    );
    assert.equal(row().getAttribute("aria-expanded"), "true");
    assert.match(main(), /Used web search · failed/);
    // Each step's details, and the terminal's raw input and result.
    assert.equal(
      all("button").filter((button) => button.textContent === "View details")
        .length,
      3,
    );
    assert.equal(strip().getAttribute("aria-expanded"), "true");
    await settle();
    assert.match(
      document.querySelector('[data-slot="live-tool"]')?.textContent ?? "",
      /14 passed \(exit 0\)/,
    );
  } finally {
    await shell.dispose();
  }
});

test("the header title keeps priority; the agent selector slot collapses by container width", async () => {
  const shell = await mount("https://app.example/?chat=t1");
  try {
    const slot = document.querySelector('[data-slot="agent-selector"]')!;
    // The slot takes the width the title leaves (at least an icon) and is a
    // size container, so the core selector (and an app's) collapses inside it.
    for (
      const name of [
        "@container/agents",
        "flex-1",
        "basis-0",
        "min-w-9",
        "overflow-x-clip",
      ]
    ) {
      assert.ok(slot.className.split(/\s+/).includes(name), name);
    }
    const title = document.querySelector('[data-slot="shell-header"] h1')!;
    assert.ok(!title.className.includes("shrink-0"));
    const button = slot.querySelector("button")!;
    assert.match(
      button.getAttribute("aria-label") ?? "",
      /^Agents in this conversation: North$/,
      "collapsed to an icon, it keeps its name",
    );
  } finally {
    await shell.dispose();
  }
});

test("message text a window read deferred loads when it shows; too long says so", async () => {
  const shell = await mount("https://app.example/?chat=t1");
  try {
    shell.feed.bodies.set("long-a", "The **rest** of a long answer.");
    shell.feed.bodies.set("long-b", "x".repeat(1024 * 1024 + 1));
    const deferred = (assetId: string) => ({
      assetId,
      kind: "text",
      role: "body",
      mediaType: "text/markdown",
      resolve: false,
      deferred: "budget",
      byteLength: 4096,
    });
    await act(async () => {
      shell.live.put(
        "message",
        {
          id: "m-long-a",
          threadId: "t1",
          senderId: "p-north",
          createdAt: "2026-10-21T10:03:00.000Z",
          content: [deferred("long-a")],
          metadata: {},
        },
        {
          id: "m-long-b",
          threadId: "t1",
          senderId: "p-north",
          createdAt: "2026-10-21T10:04:00.000Z",
          content: [deferred("long-b")],
          metadata: {},
        },
      );
      await settle();
    });
    await act(async () => {
      await settle();
    });
    assert.match(main(), /The rest of a long answer\./);
    assert.match(main(), /This message is too long to show here\./);
    assert.deepEqual(shell.feed.assetReads.sort(), [
      "m-long-a/long-a",
      "m-long-b/long-b",
    ]);
  } finally {
    await shell.dispose();
  }
});

test("a revoked session routes to sign-in, reads nothing and waits for the app to restore it", async () => {
  const shell = await mount("https://app.example/?chat=t1", {
    extra: {
      id: "sign-in",
      resources: { shell: { signIn: { href: "/login?next=chat" } } },
    },
  });
  const listeners = new Set<
    (event: { state: string; code?: string }) => void
  >();
  const stop = bindShellSession(shell.runtime, {
    onAuthState(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  try {
    assert.ok(shell.live.subscriptionCount > 0);
    await act(async () => {
      for (const listener of listeners) {
        listener({ state: "revoked", code: "session_revoked" });
      }
      await settle();
    });
    const screen = document.querySelector('[data-slot="signed-out"]');
    assert.match(screen?.textContent ?? "", /You've been signed out/);
    assert.equal(
      screen?.querySelector("a")?.getAttribute("href"),
      "/login?next=chat",
    );
    assert.equal(shell.live.subscriptionCount, 0, "every read is released");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    assert.equal(shell.live.subscriptionCount, 0, "and nothing reconnects");
    // The app signed in again and reauthenticated the device.
    await act(async () => {
      await shell.runtime.actions.shellSessionRestored({}).result();
      await settle();
    });
    assert.equal(document.querySelector('[data-slot="signed-out"]'), null);
    assert.ok(shell.live.subscriptionCount > 0, "the shell reads again");
    assert.equal(nav(shell).threadId, "t1", "on the same conversation");
  } finally {
    stop();
    await shell.dispose();
  }
});

test("an empty sidebar offers New Space; with groups it comes after No Space", async () => {
  const empty = await mount("https://app.example/", {
    live: new FixtureLive({ ...tables(), thread: [], space: [], message: [] }),
  });
  try {
    const nav = document.querySelector('nav[aria-label="Conversations"]')!;
    assert.match(nav.textContent ?? "", /No conversations yet\./);
    assert.ok(
      [...nav.querySelectorAll("button")].some((button) =>
        button.textContent?.trim() === "New Space"
      ),
      "New Space is offered before any group exists",
    );
  } finally {
    await empty.dispose();
  }
  const shell = await mount("https://app.example/?chat=t1");
  try {
    const text = document.querySelector('nav[aria-label="Conversations"]')!
      .textContent!;
    assert.ok(text.indexOf("No Space") < text.indexOf("New Space"), text);
  } finally {
    await shell.dispose();
  }
});

test("a second tab's Recent list reorders live when a conversation gets a message", async () => {
  const live = new FixtureLive(tables());
  const first = await mount("https://app.example/?chat=t3", { live });
  const second = await mount("https://app.example/?chat=t1", { live });
  try {
    await act(async () => {
      await second.runtime.actions.shellPreference({ groupBy: "date" })
        .result();
      await settle();
    });
    const order = () =>
      Array.from(
        (second.container as unknown as {
          querySelectorAll(selector: string): ArrayLike<
            { textContent: string | null }
          >;
        }).querySelectorAll('nav[aria-label="Conversations"] [data-nav-item]'),
      ).map((row) => (row.textContent ?? "").replace(/^[A-Z]{2}/, ""));
    assert.deepEqual(order(), [
      "Interview plan",
      "Deploy checklist",
      "Loose idea",
    ]);
    // The first tab sends in the oldest conversation; Core records the
    // activity on the thread, and the second tab's window reorders.
    await act(async () => {
      await first.runtime.actions.chatSend({ threadId: "t3", text: "Bump" })
        .result();
      await settle();
    });
    assert.deepEqual(order(), [
      "Loose idea",
      "Interview plan",
      "Deploy checklist",
    ]);
  } finally {
    await first.dispose();
    await second.dispose();
  }
});

test("URL parameters a section owns leave when another section shows", async () => {
  const shell = await mount(
    "https://app.example/?chat=t1&panel=1&section=boards&board=b1&card=c1&ref=mail",
  );
  try {
    assert.equal(shell.url().searchParams.get("board"), "b1");
    await click(byLabel("Report"));
    const url = shell.url();
    assert.equal(url.searchParams.get("section"), "report");
    assert.equal(url.searchParams.get("board"), null);
    assert.equal(url.searchParams.get("card"), null);
    assert.equal(url.searchParams.get("ref"), "mail", "others stay");
  } finally {
    await shell.dispose();
  }
});

test("people that can't be read show neutrally: no Participant, no bot, no 0 agents", async () => {
  const live = new FixtureLive(tables());
  live.refusals.set("participant", {
    code: "subscription_query_refused",
    reason: "query_unsupported",
  });
  const shell = await mount("https://app.example/?chat=t1", { live });
  try {
    assert.match(main(), /Someone/);
    assert.doesNotMatch(main(), /Participant/);
    const selector = document.querySelector(
      '[data-slot="agent-selector"] button',
    );
    assert.equal(
      selector?.getAttribute("aria-label"),
      "Agents in this conversation",
    );
    assert.doesNotMatch(selector?.textContent ?? "", /0 agents/);
  } finally {
    await shell.dispose();
  }
});

async function typeAndSend(text: string) {
  const field = document.querySelector('textarea[aria-label="Message"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(field, text);
    (field as unknown as { selectionStart: number; selectionEnd: number })
      .selectionStart = text.length;
    (field as unknown as { selectionEnd: number }).selectionEnd = text.length;
    field.dispatchEvent(new window.Event("input", { bubbles: true }));
    await settle();
  });
  return {
    async submit() {
      await act(async () => {
        document.querySelector('form[aria-label="Message composer"]')!
          .dispatchEvent(
            new window.Event("submit", { bubbles: true, cancelable: true }),
          );
        await settle();
      });
    },
  };
}

test("@ opens a mention picker of the agents; a mention becomes the recipients", async () => {
  const live = new FixtureLive(tables());
  // Even when people can't be read, the app's configured agents are offered.
  live.refusals.set("participant", {
    code: "subscription_query_refused",
    reason: "query_unsupported",
  });
  const shell = await mount("https://app.example/?chat=t1", { live });
  try {
    await typeAndSend("Hey @");
    const options = [...document.querySelectorAll(
      '#composer-mentions [role="option"]',
    )].map((option) => option.textContent ?? "");
    assert.ok(options.some((text) => /North/.test(text)), options.join("|"));
    await (await typeAndSend("@North what's the risk?")).submit();
    const sent = shell.calls.find((call) =>
      call.alias === "createThreadMessage"
    )!;
    assert.deepEqual(sent.input.recipientIds, []);
    assert.deepEqual(
      (sent.input.membership as { recipients: unknown[] }).recipients,
      [{ externalId: "north" }],
      "the mentioned agent, by its external id",
    );
  } finally {
    await shell.dispose();
  }
});

test("an app can address every agent by default instead of the first", async () => {
  const shell = await mount("https://app.example/?chat=t1", {
    extra: {
      id: "all-agents",
      resources: { chat: { defaultRecipients: "all" } },
    },
  });
  try {
    await (await typeAndSend("Hello team")).submit();
    const sent = shell.calls.find((call) =>
      call.alias === "createThreadMessage"
    )!;
    assert.equal("recipientIds" in sent.input, false, "Core addresses all");
  } finally {
    await shell.dispose();
  }
});

test("a new chat shows its first message at once and a retry continues the same thread", async () => {
  const shell = await mount("https://app.example/");
  let failCreate = true;
  try {
    // The first create fails after the server already made the thread (an
    // observe error): the retry must continue it, not orphan it.
    shell.failCreateOnce = () => {
      if (!failCreate) return false;
      failCreate = false;
      return true;
    };
    await (await typeAndSend("Plan the launch")).submit();
    const threadId = nav(shell).threadId!;
    assert.ok(threadId, "the new conversation opened at once");
    assert.match(main(), /Plan the launch/, "the first message shows at once");
    assert.match(main(), /Retry/, "the failed send offers Retry");
    assert.doesNotMatch(main(), /not found/i);
    await click(byText("button", "Retry"));
    const creates = shell.calls.filter((call) => call.alias === "createThread");
    assert.equal(creates.length, 2);
    assert.ok(creates.every((call) => call.input.id === threadId));
    const sends = shell.calls.filter((call) =>
      call.alias === "createThreadMessage"
    );
    assert.equal(sends.length, 1);
    assert.equal(sends[0].input.threadId, threadId);
    assert.doesNotMatch(main(), /Retry/);
  } finally {
    await shell.dispose();
  }
});

test("the sidebar search box opens the palette, which finds chats by title and Space name", async () => {
  const shell = await mount("https://app.example/?chat=t1");
  try {
    await click(
      document.querySelector(
        '[data-slot="sidebar"] button[aria-keyshortcuts]',
      ) as unknown as { click(): void },
    );
    assert.equal(
      nav(shell).threadId,
      "t1",
      "opening search leaves the conversation",
    );
    const input = document.querySelector(
      'input[aria-label="Search conversations, Spaces and commands"]',
    )!;
    assert.ok(input, "the palette is open");
    const type = async (value: string) =>
      await act(async () => {
        Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          "value",
        )!.set!.call(input, value);
        input.dispatchEvent(new window.Event("input", { bubbles: true }));
        await settle();
      });
    const results = () =>
      [...document.querySelectorAll('[role="option"]')].map((option) =>
        option.textContent ?? ""
      ).join(" | ");
    await type("deploy");
    assert.match(results(), /Deploy checklist/);
    assert.doesNotMatch(results(), /Interview plan/);
    await type("research");
    assert.match(results(), /Interview plan/, "a chat matches its Space name");
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
