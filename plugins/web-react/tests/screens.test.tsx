import { renderToStaticMarkup } from "react-dom/server";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  type BrowserRuntime,
  createBrowserRuntime,
  MemoryLiveReads,
} from "@copilotz/copilotz/web";
import { coreWebPlugin } from "@copilotz/copilotz/core/web";
import { adminWebPlugin } from "@copilotz/copilotz/admin/web";
import { usageWebPlugin } from "@copilotz/copilotz/usage/web";
import { uiWebPlugin, workspaceNavigation } from "@copilotz/copilotz/ui/web";
import { Button, Markdown } from "@copilotz/copilotz/web/kit";
import { ObservedView, reactRenderer } from "../index.ts";

test("React adapter server renders tracked chat/admin/usage screens in both densities", async () => {
  const live = new MemoryLiveReads();
  const publish = (
    collection: string,
    query: Record<string, unknown> | undefined,
    rows: Record<string, unknown>[],
    id?: string,
  ) =>
    live.publish({
      collection,
      ...(collection === "message"
        ? {
          content: {
            fields: ["content"],
            byteLimit: 262144,
            exclude: [{ kind: "image" }, { kind: "audio" }, { kind: "video" }, {
              kind: "file",
            }, { kind: "json" }],
          },
        }
        : {}),
      ...(query ? { query } : {}),
      ...(id ? { id } : {}),
    }, {
      kind: "snapshot",
      rows: rows.map((row, order) => ({ row: row as { id: string }, order })),
      seq: 1,
      checkpoint: "1",
    });
  publish("thread", undefined, [{ id: "t", title: "A conversation" }], "t");
  publish("thread", { limit: 100 }, [{ id: "t", title: "A conversation" }]);
  publish("message", { where: { threadId: "t" }, limit: 100 }, [{
    id: "m",
    content: [{
      assetId: "body",
      kind: "text",
      role: "message",
      mediaType: "text/plain",
      value: "Hello **reader**",
    }],
    role: "assistant",
  }]);
  publish("participant", { limit: 100 }, [{ id: "p", name: "Reader" }]);
  publish("usage", { limit: 100 }, [{
    id: "u",
    model: "Example model",
    totalTokens: 123,
    totalCostUsd: .01,
  }]);
  const runtime = await createBrowserRuntime({
    renderer: reactRenderer,
    plugins: [coreWebPlugin, adminWebPlugin, usageWebPlugin],
    live,
  });
  for (const mode of ["full", "panel"]) {
    for (
      const [shows, value, expected] of [
        ["thread", { id: "t" }, "Hello <strong>reader</strong>"],
        ["admin", null, "Administration"],
        ["usage", null, "123"],
      ] as const
    ) {
      const output = runtime.observe(() =>
        runtime.render({ shows, value }, { mode })
      );
      const html = renderToStaticMarkup(<ObservedView output={output} />);
      assert.ok(html.includes(expected), html);
      assert.ok(html.includes(`data-density="${mode}"`));
      output.dispose();
    }
  }
  runtime.dispose();
  assert.equal(live.subscriptions, 0);
});

test("workspace restores panes, navigation chooses focus/context, and swap exchanges density", async () => {
  const runtime: BrowserRuntime = await createBrowserRuntime({
    renderer: reactRenderer,
    plugins: [
      coreWebPlugin,
      adminWebPlugin,
      usageWebPlugin,
      uiWebPlugin("url"),
    ],
    live: new MemoryLiveReads(),
    show: workspaceNavigation(() => runtime),
    storage: {
      url: {
        load: () => [{
          id: "main",
          focus: { shows: "admin", value: null },
          context: null,
        }],
        save() {},
      },
    },
  });
  await runtime.actions.uiOpen({
    reference: { shows: "usage", value: null },
    source: "link",
  }).result();
  const output = runtime.observe(() =>
    runtime.render({ shows: "workspace", value: null })
  );
  let html = renderToStaticMarkup(<ObservedView output={output} />);
  assert.ok(html.includes('aria-label="Context"'));
  assert.ok(html.includes('data-density="panel"'));
  assert.ok(html.includes("Search ⌘K"));
  await runtime.actions.uiSwap({}).result();
  assert.equal(
    (runtime.collections.workspace.get("main").value?.focus as {
      shows: string;
    }).shows,
    "usage",
  );
  await runtime.actions.uiOpen({
    reference: { shows: "admin", value: null },
    source: "command",
  }).result();
  assert.equal(
    (runtime.collections.workspace.get("main").value?.focus as {
      shows: string;
    }).shows,
    "admin",
  );
  html = renderToStaticMarkup(<ObservedView output={output} />);
  assert.ok(html.includes("Administration"));
  runtime.dispose();
});

test("shared Markdown rejects raw HTML and unsafe URLs while preserving escaped code", () => {
  for (
    const source of [
      "<script>alert(1)</script>",
      "<img src=x onerror=alert(1)>",
      "[click](javascript:alert%281%29)",
      "[click](data:text/html,test)",
      "<svg onload=alert(1)>",
      '<iframe srcdoc="x"></iframe>',
    ]
  ) {
    const html = renderToStaticMarkup(<Markdown>{source}</Markdown>);
    assert.doesNotMatch(
      html,
      /<script|<img|<svg|<iframe|href="javascript:|href="data:|onerror=/,
    );
  }
  const code = renderToStaticMarkup(
    <Markdown>{"```html\n<img src=x onerror=alert(1)>\n```"}</Markdown>,
  );
  assert.ok(code.includes("&lt;img"));
  assert.ok(!code.includes("<img"));
  const button = renderToStaticMarkup(
    <Button asChild>
      <a href="/safe">Open</a>
    </Button>,
  );
  assert.ok(button.includes('data-slot="button"'));
  assert.ok(button.includes("<a"));
});

test("admin query Views render existing authorized Action results", async () => {
  const runtime = await createBrowserRuntime({
    renderer: reactRenderer,
    plugins: [adminWebPlugin],
    live: new MemoryLiveReads(),
    actions: {
      invoke: () =>
        Promise.resolve({
          seq: 1,
          value: {
            status: 200,
            data: [{ id: "a", name: "Example agent", role: "Assistant" }],
          },
        }),
      cancel: () => Promise.resolve(),
    },
  });
  const output = runtime.observe(() =>
    runtime.render({ shows: "adminQuery", value: { section: "agents" } })
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  const html = renderToStaticMarkup(<ObservedView output={output} />);
  assert.ok(html.includes("Example agent"));
  assert.ok(html.includes("Assistant"));
  runtime.dispose();
});
