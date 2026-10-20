/** @jsxRuntime classic */
/** @jsx React.createElement */
import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { createBrowserRuntime, MemoryLiveReads } from "@copilotz/copilotz/web";
import { createAdminWebPlugin } from "@copilotz/copilotz/admin/web";
import { ObservedView, reactRenderer } from "../index.ts";

test("admin query and agent detail resolve configured Action IDs through aliases", async () => {
  const calls: string[] = [];
  const sections = [
    "overview",
    "agents",
    "activity",
    "threads",
    "participants",
    "usage",
  ] as const;
  const actionIds = Object.fromEntries(
    sections.map((section) => [section, `app.audit.${section}`]),
  );
  const runtime = await createBrowserRuntime({
    renderer: reactRenderer,
    plugins: [createAdminWebPlugin({ actionIds })],
    live: new MemoryLiveReads(),
    actions: {
      invoke(id) {
        calls.push(id);
        return Promise.resolve({
          seq: 1,
          value: {
            status: 200,
            data: [{
              id: "a",
              name: "Configured agent",
              role: "Assistant",
              capabilities: { search: true },
            }],
          },
        });
      },
      cancel: () => Promise.resolve(),
    },
  });
  try {
    for (const section of sections) {
      const output = runtime.observe(() =>
        runtime.render({ shows: "adminQuery", value: { section } })
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      renderToStaticMarkup(<ObservedView output={output} />);
      assert.ok(calls.includes(actionIds[section]));
      output.dispose();
    }
    const output = runtime.observe(() =>
      runtime.render({ shows: "agent", value: { id: "a" } })
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const html = renderToStaticMarkup(<ObservedView output={output} />);
    for (const text of ["Configured agent", "Assistant", "search"]) {
      assert.ok(html.includes(text), html);
    }
    assert.ok(calls.every((id) => id.startsWith("app.audit.")));
    output.dispose();
  } finally {
    runtime.dispose();
  }
});

test("participant detail reads its ID even outside a paginated admin list", async () => {
  const live = new MemoryLiveReads();
  live.publish({ collection: "participant", id: "p" }, {
    kind: "snapshot",
    seq: 1,
    checkpoint: "1",
    rows: [{
      order: 0,
      row: {
        id: "p",
        name: "Participant name",
        participantType: "human",
        namespace: "example",
      },
    }],
  });
  const runtime = await createBrowserRuntime({
    renderer: reactRenderer,
    plugins: [createAdminWebPlugin()],
    live,
  });
  try {
    const output = runtime.observe(() =>
      runtime.render({ shows: "participant", value: { id: "p" } }, {
        mode: "panel",
      })
    );
    const html = renderToStaticMarkup(<ObservedView output={output} />);
    assert.match(html, /Participant name/);
    assert.match(html, /human/);
    assert.match(html, /data-density="panel"/);
    output.dispose();
  } finally {
    runtime.dispose();
  }
  assert.equal(live.subscriptions, 0);
});
