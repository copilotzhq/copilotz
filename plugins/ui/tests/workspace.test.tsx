/** @jsxRuntime classic */
/** @jsx React.createElement */
// deno-lint-ignore verbatim-module-syntax -- classic JSX requires this runtime import.
import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import {
  type BrowserRuntime,
  type BrowserViewContext,
  createBrowserRuntime,
} from "@copilotz/copilotz/web";
import { defineView, type ViewReference } from "@copilotz/copilotz/views";
import {
  uiWebPlugin,
  workspaceNavigation,
  type WorkspaceUrlCodec,
  workspaceUrlStorageAdapter,
} from "../web.ts";
import { ObservedView, reactRenderer } from "../../web-react/index.ts";

const reference = (id: string): ViewReference => ({
  shows: "record",
  value: { id },
});
const record = defineView<{ id: string }, React.ReactNode, BrowserViewContext>({
  id: "test.record",
  shows: "record",
  renderer: "react",
  modes: ["full", "panel", "dialog"],
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
test("readable deep links round trip through storage, runtime restore and exact history restore", async () => {
  let url = new URL(
    "https://app.example/records?focus=a&context=b&lang=en#section",
  );
  const storage = workspaceUrlStorageAdapter({
    read: () => url,
    replace: (next) => {
      url = next;
    },
  }, codec);
  const runtime = await createBrowserRuntime({
    plugins: [uiWebPlugin("url")],
    storage: { url: storage },
  });
  try {
    assert.deepEqual(
      runtime.collections.workspace.get("main").value?.focus,
      reference("a"),
    );
    await runtime.actions.uiSet({
      focus: reference("a /?&"),
      dialog: reference("d"),
    }).result();
    await runtime.flushStorage();
    assert.equal(url.searchParams.get("lang"), "en");
    assert.equal(url.hash, "#section");
    assert.equal(url.searchParams.get("context"), null);
    const saved = await storage.load("workspace");
    assert.deepEqual(
      saved?.[0],
      runtime.collections.workspace.get("main").value,
    );
    url = new URL("https://app.example/records?focus=back");
    await runtime.actions.uiRestore(codec.decode(url)).result();
    assert.deepEqual(runtime.collections.workspace.get("main").value, {
      id: "main",
      focus: reference("back"),
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
