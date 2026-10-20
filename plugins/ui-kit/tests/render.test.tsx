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
  CopyField,
  Dialog,
  DropdownMenu,
  DropdownMenuTrigger,
  EmptyState,
  Field,
  Frame,
  Input,
  NativeSelect,
  Notice,
  PaneBoundary,
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
