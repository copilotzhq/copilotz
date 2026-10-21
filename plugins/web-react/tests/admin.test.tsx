/** @jsxRuntime classic */
/** @jsx React.createElement */
// deno-lint-ignore verbatim-module-syntax -- classic JSX requires this runtime import.
import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { createBrowserRuntime } from "@copilotz/copilotz/web";
import {
  MemorySubscriptions,
  record,
  tick,
} from "../../../client/testing/live-transport.test.ts";
import { createAdminWebPlugin } from "@copilotz/copilotz/admin/web";
import { ObservedView, reactRenderer } from "../index.ts";

test("admin query and agent detail resolve configured Action aliases", async () => {
  const calls: string[] = [];
  const sections = [
    "overview",
    "agents",
    "activity",
    "threads",
    "participants",
    "usage",
  ] as const;
  const actionAliases = Object.fromEntries(
    sections.map((section) => [section, `audit${section}`]),
  );
  const runtime = await createBrowserRuntime({
    renderer: reactRenderer,
    plugins: [createAdminWebPlugin({ actionAliases })],
    live: new MemorySubscriptions(),
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
      assert.ok(calls.includes(actionAliases[section]));
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
    assert.ok(calls.every((id) => id.startsWith("audit")));
    output.dispose();
  } finally {
    runtime.dispose();
  }
});

test("participant detail reads its ID even outside a paginated admin list", async () => {
  const live = new MemorySubscriptions();
  live.publish({ collection: "participant", id: "p" }, {
    t: "snapshot",
    complete: true,
    rows: [record({
      id: "p",
      name: "Participant name",
      participantType: "human",
      namespace: "example",
    })],
    sequence: "1",
    checkpoint: "1",
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
    // The subscription transport delivers the snapshot asynchronously.
    await tick();
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

test("the administration page reads its section; from a link it waits for Load", async () => {
  const calls: string[] = [];
  const runtime = await createBrowserRuntime({
    renderer: reactRenderer,
    plugins: [createAdminWebPlugin()],
    live: new MemorySubscriptions(),
    actions: {
      invoke(id) {
        calls.push(id);
        return Promise.resolve({
          seq: 1,
          value: {
            status: 200,
            data: { threadTotals: { total: 9, active: 7, archived: 2 } },
          },
        });
      },
      cancel: () => Promise.resolve(),
    },
  });
  try {
    const linked = runtime.observe(() =>
      runtime.render({
        shows: "admin",
        value: { section: "overview" },
        origin: "url",
      } as never)
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const held = renderToStaticMarkup(<ObservedView output={linked} />);
    assert.match(held, /Opened from a link/);
    assert.deepEqual(calls, [], "a link never runs the query by itself");
    linked.dispose();
    const opened = runtime.observe(() =>
      runtime.render({ shows: "admin", value: null })
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const html = renderToStaticMarkup(<ObservedView output={opened} />);
    assert.deepEqual(calls, ["adminOverview"]);
    for (
      const text of ["Conversations", "7 active · 2 archived", 'role="tab"']
    ) {
      assert.ok(html.includes(text), `${text}: ${html}`);
    }
    opened.dispose();
  } finally {
    runtime.dispose();
  }
});

test("a refused admin section says so in plain words", async () => {
  const runtime = await createBrowserRuntime({
    renderer: reactRenderer,
    plugins: [createAdminWebPlugin()],
    live: new MemorySubscriptions(),
    actions: {
      invoke: () =>
        Promise.resolve({ seq: 1, value: { status: 403, data: null } }),
      cancel: () => Promise.resolve(),
    },
  });
  try {
    const output = runtime.observe(() =>
      runtime.render({ shows: "adminQuery", value: { section: "usage" } })
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const html = renderToStaticMarkup(<ObservedView output={output} />);
    assert.match(html, /You don&#x27;t have access to this section\./);
    assert.doesNotMatch(html, /Forbidden|403/);
    output.dispose();
  } finally {
    runtime.dispose();
  }
});

test("apps add, order, gate and hide administration sections; a query embeds without a Screen", async () => {
  const { defineView } = await import("@copilotz/copilotz/views");
  const ledger = defineView<{ section: string }, React.ReactNode>({
    id: "app.ledger",
    shows: "appLedger",
    renderer: "react",
    modes: ["full"],
    render: ({ section }) => <p>{`Ledger section ${section}`}</p>,
  });
  const app = {
    id: "app",
    views: { ledger },
    actions: {
      ledgerQuery: { id: "app.ledger", placement: "server" as const },
    },
    resources: {
      adminSections: {
        ledger: {
          label: "Ledger",
          icon: "book",
          order: 45,
          view: "appLedger",
          requires: "ledgerQuery",
        },
        profiles: {
          label: "Profiles",
          view: "appProfiles",
          requires: ["profilesQuery"], // not composed: hidden
        },
        activity: null, // hide a built-in
      },
    },
  };
  const runtime = await createBrowserRuntime({
    renderer: reactRenderer,
    plugins: [createAdminWebPlugin(), app],
    live: new MemorySubscriptions(),
    actions: {
      invoke: () =>
        Promise.resolve({ seq: 1, value: { status: 200, data: [] } }),
      cancel: () => Promise.resolve(),
    },
  });
  try {
    const page = runtime.observe(() =>
      runtime.render({ shows: "admin", value: { section: "ledger" } })
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const html = renderToStaticMarkup(<ObservedView output={page} />);
    const tabs = [...html.matchAll(/role="tab"[^>]*aria-label="([^"]+)"/g)]
      .map((match) => match[1]);
    assert.deepEqual(tabs, [
      "Overview",
      "Agents",
      "Conversations",
      "People",
      "Ledger",
      "Usage",
    ]);
    assert.match(html, /Ledger section ledger/);
    page.dispose();
    const embedded = runtime.observe(() =>
      runtime.render({
        shows: "adminQuery",
        value: { section: "agents", embedded: true },
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const body = renderToStaticMarkup(<ObservedView output={embedded} />);
    assert.ok(!body.includes("<h1"), "no Screen title when embedded");
    assert.match(body, /No agents yet/);
    embedded.dispose();
  } finally {
    runtime.dispose();
  }
});
