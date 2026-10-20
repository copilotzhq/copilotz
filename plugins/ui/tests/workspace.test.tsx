/** @jsxRuntime classic */
/** @jsx React.createElement */
import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import {
  type BrowserRuntime,
  type BrowserViewContext,
  createBrowserRuntime,
} from "@copilotz/copilotz/web";
import {
  defineView,
  type ViewReference,
  type ViewRendererAdapter,
} from "@copilotz/copilotz/views";
import { coreWebPlugin } from "@copilotz/copilotz/core/web";
import {
  uiWebPlugin,
  workspaceNavigation,
  type WorkspaceUrlCodec,
  workspaceUrlStorageAdapter,
} from "../web.ts";
import { ObservedView, reactRenderer } from "../../web-react/index.ts";
import {
  MemorySubscriptions,
  record as liveRecord,
  tick,
} from "../../../client/testing/live-transport.test.ts";

const reference = (id: string): ViewReference => ({
  shows: "record",
  value: { id },
});
const record = defineView<{ id: string }, React.ReactNode, BrowserViewContext>({
  id: "test.record",
  shows: "record",
  renderer: "react",
  modes: ["full", "panel", "dialog"],
  url: true,
  render({ id }, ctx) {
    return <p data-density={ctx.hints.mode}>Record {id}</p>;
  },
});
async function boot() {
  const runtime: BrowserRuntime = await createBrowserRuntime({
    renderer: reactRenderer,
    plugins: [uiWebPlugin(), {
      id: "app",
      views: { record },
      resources: {
        navigation: { home: { label: "Home", ...reference("home") } },
      },
    }],
    show: workspaceNavigation(() => runtime),
  });
  return runtime;
}
function render(runtime: BrowserRuntime, shows: string) {
  const output = runtime.observe(() => runtime.render({ shows, value: null }));
  try {
    return renderToStaticMarkup(<ObservedView output={output} />);
  } finally {
    output.dispose();
  }
}

test("panes and navigator render independently and workspace composes both", async () => {
  const runtime = await boot();
  try {
    await runtime.actions.uiSet({
      focus: reference("a"),
      context: reference("b"),
    }).result();
    const panes = render(runtime, "workspacePanes"),
      nav = render(runtime, "workspaceNavigator"),
      both = render(runtime, "workspace");
    assert.match(panes, /Record a/);
    assert.match(panes, /Record b/);
    assert.match(panes, /data-density="full"/);
    assert.match(panes, /data-density="panel"/);
    assert.doesNotMatch(panes, /Search ⌘K/);
    assert.match(nav, /Search ⌘K/);
    assert.match(nav, /Home/);
    assert.doesNotMatch(nav, /Record a/);
    assert.match(both, /Search ⌘K/);
    assert.match(both, /Record a/);
    assert.match(both, /Record b/);
  } finally {
    runtime.dispose();
  }
});

test("replace preserves the other panes, exact set/restore clears omissions, and mutations are atomic", async () => {
  const runtime = await boot();
  const state = () => runtime.collections.workspace.get("main").value;
  try {
    await runtime.actions.uiSet({
      focus: reference("a"),
      context: reference("b"),
      dialog: reference("d"),
    }).result();
    const before = structuredClone(state());
    let changes = 0;
    const tracked = runtime.observe(() => state());
    const off = tracked.subscribe(() => changes++);
    await runtime.actions.uiReplace({
      region: "focus",
      reference: reference("c"),
    }).result();
    assert.equal(changes, 1);
    assert.deepEqual(state()?.context, reference("b"));
    assert.deepEqual(state()?.dialog, reference("d"));
    await runtime.actions.uiSwap({}).result();
    assert.deepEqual(state()?.focus, reference("b"));
    assert.deepEqual(state()?.context, reference("c"));
    await runtime.actions.uiRestore(before).result();
    assert.deepEqual(state(), before);
    await runtime.actions.uiSet({ focus: reference("c") }).result();
    assert.deepEqual(state(), {
      id: "main",
      focus: reference("c"),
      context: null,
      dialog: null,
    });
    await runtime.actions.uiOpen({
      reference: reference("a"),
      source: "navigator",
    }).result();
    assert.deepEqual(state()?.context, reference("c"));
    await runtime.actions.uiOpen({ reference: reference("d"), mode: "dialog" })
      .result();
    assert.deepEqual(state()?.focus, reference("a"));
    assert.deepEqual(state()?.dialog, reference("d"));
    await runtime.actions.uiClose({ region: "dialog" }).result();
    assert.equal(state()?.dialog, null);
    await assert.rejects(
      runtime.actions.uiReplace({ region: "bad", reference: reference("a") })
        .result(),
      /Unknown workspace region/,
    );
    off();
    tracked.dispose();
  } finally {
    runtime.dispose();
  }
});

const codec: WorkspaceUrlCodec = {
  decode(url) {
    if (url.pathname !== "/records") return undefined;
    const pane = (name: string) => {
      const value = url.searchParams.get(name);
      return value ? reference(value) : null;
    };
    return {
      focus: pane("focus"),
      context: pane("context"),
      dialog: pane("dialog"),
    };
  },
  encode(url, state) {
    url.pathname = "/records";
    for (const region of ["focus", "context", "dialog"] as const) {
      const pane = state[region];
      if (pane) url.searchParams.set(region, (pane.value as { id: string }).id);
      else url.searchParams.delete(region);
    }
  },
};
const fromUrl = (id: string) => ({ ...reference(id), origin: "url" });
test("readable deep links round trip through storage, runtime restore and history navigation", async () => {
  let url = new URL(
    "https://app.example/records?focus=a&context=b&lang=en#section",
  );
  const events = new EventTarget();
  const storage = workspaceUrlStorageAdapter({
    read: () => url,
    replace: (next) => {
      url = next;
    },
    events,
  }, codec);
  const runtime = await createBrowserRuntime({
    renderer: reactRenderer,
    plugins: [uiWebPlugin("url"), { id: "app", views: { record } }],
    storage: { url: storage },
  });
  try {
    // Decoded panes are admitted as URL state and still render their View.
    assert.deepEqual(
      runtime.collections.workspace.get("main").value?.focus,
      fromUrl("a"),
    );
    const panes = render(runtime, "workspacePanes");
    assert.match(panes, /Record a/);
    assert.match(panes, /Record b/);
    await runtime.actions.uiSet({
      focus: reference("a /?&"),
      dialog: reference("d"),
    }).result();
    await runtime.flushStorage();
    assert.equal(url.searchParams.get("lang"), "en");
    assert.equal(url.hash, "#section");
    assert.equal(url.searchParams.get("context"), null);
    assert.equal(url.searchParams.get("focus"), "a /?&");
    url = new URL("https://app.example/records?focus=back");
    events.dispatchEvent(new Event("popstate"));
    await tick();
    assert.deepEqual(runtime.collections.workspace.get("main").value, {
      id: "main",
      focus: fromUrl("back"),
      context: null,
      dialog: null,
    });
    assert.equal(
      codec.decode(new URL("https://app.example/elsewhere")),
      undefined,
    );
  } finally {
    runtime.dispose();
  }
});

/** An app codec with a JSON fallback: the URL can name any reference. */
const jsonCodec: WorkspaceUrlCodec = {
  decode(url) {
    const pane = (name: string) => {
      const value = url.searchParams.get(name);
      return value ? JSON.parse(value) : null;
    };
    return {
      focus: pane("focus"),
      context: pane("context"),
      dialog: pane("dialog"),
    };
  },
  encode(url, state) {
    for (const region of ["focus", "context", "dialog"] as const) {
      const pane = state[region];
      if (pane) url.searchParams.set(region, JSON.stringify(pane));
      else url.searchParams.delete(region);
    }
  },
};
/** Whole-output rendering, so a refused nested View becomes a local notice. */
const wholeOutput: ViewRendererAdapter = {
  id: "react",
  mount: () => ({ dispose() {} }),
};
async function bootFromUrl(params: Record<string, unknown>) {
  const url = new URL("https://app.example/");
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, JSON.stringify(value));
  }
  const live = new MemorySubscriptions();
  const runtime = await createBrowserRuntime({
    renderer: wholeOutput,
    plugins: [coreWebPlugin, uiWebPlugin("url"), {
      id: "app",
      views: { record },
    }],
    live,
    storage: {
      url: workspaceUrlStorageAdapter({
        read: () => url,
        replace: () => {},
      }, jsonCodec),
    },
  });
  return { runtime, live };
}
function renderPanes(runtime: BrowserRuntime) {
  const output = runtime.observe(() =>
    runtime.render({ shows: "workspacePanes", value: null })
  );
  try {
    return renderToStaticMarkup(
      <div>{output.getSnapshot() as React.ReactNode}</div>,
    );
  } finally {
    output.dispose();
  }
}

test("a crafted URL cannot mount a View that did not opt in", async () => {
  // The core message View renders Markdown; a link must not spoof one.
  const { runtime } = await bootFromUrl({
    focus: {
      shows: "message",
      value: { id: "m", role: "assistant", content: "**Spoofed** notice" },
    },
    context: { shows: "record", value: { id: "d" } },
  });
  try {
    const html = renderPanes(runtime);
    assert.match(html, /Focus is unavailable/);
    assert.match(html, /core\.message&#x27;? cannot be opened from a URL/);
    assert.doesNotMatch(html, /Spoofed/);
    // An addressable View named in the same URL still renders.
    assert.match(html, /Record d/);
  } finally {
    runtime.dispose();
  }
});

test("a URL carrying a record payload is never rendered from the URL", async () => {
  const { runtime } = await bootFromUrl({
    focus: {
      shows: "record",
      value: { id: "a", content: [{ type: "text", text: "Spoofed" }] },
    },
    context: { shows: "record", value: { id: "b" } },
  });
  try {
    const state = runtime.collections.workspace.get("main").value;
    assert.equal(state?.focus, null);
    assert.deepEqual(state?.context, fromUrl("b"));
    assert.doesNotMatch(renderPanes(runtime), /Spoofed/);
    // A host URL open goes through the same admission.
    await assert.rejects(
      runtime.actions.uiOpen({
        source: "url",
        reference: { shows: "record", value: { id: "x", rows: [1] } },
      }).result(),
      /identifiers only/,
    );
    await runtime.actions.uiOpen({
      source: "url",
      reference: { shows: "message", value: { id: "m", content: "Spoofed" } },
    }).result();
    assert.deepEqual(runtime.collections.workspace.get("main").value?.focus, {
      shows: "message",
      value: { id: "m", content: "Spoofed" },
      origin: "url",
    });
    const html = renderPanes(runtime);
    assert.match(html, /cannot be opened from a URL/);
    assert.doesNotMatch(html, /Spoofed/);
  } finally {
    runtime.dispose();
  }
});

test("a deep link to an addressable View reads its record by ID", async () => {
  const { runtime, live } = await bootFromUrl({
    focus: { shows: "thread", value: { id: "t", name: "From the URL" } },
  });
  await live.publish({ collection: "thread", id: "t" }, {
    t: "snapshot",
    complete: true,
    rows: [liveRecord({ id: "t", name: "Authorized name" })],
    sequence: "1",
    checkpoint: "1",
  });
  try {
    const output = runtime.observe(() =>
      runtime.render({ shows: "workspacePanes", value: null })
    );
    await tick();
    const html = renderToStaticMarkup(
      <div>{output.getSnapshot() as React.ReactNode}</div>,
    );
    output.dispose();
    assert.match(html, /Authorized name/);
    assert.doesNotMatch(html, /From the URL/);
  } finally {
    runtime.dispose();
  }
});
