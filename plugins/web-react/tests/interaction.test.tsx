/** @jsxRuntime classic */
/** @jsx React.createElement */
import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import type {
  BrowserRuntime,
  BrowserViewContext,
} from "@copilotz/copilotz/web";

// Install the DOM before loading ReactDOM/Radix, which detect it at module load.
const NativeEvent = globalThis.Event;
const window = new Window({ url: "https://app.example" });
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
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");
const {
  Button,
  ConfirmAction,
  PaneBoundary,
  CopyField,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} = await import("../../ui-kit/index.ts");
const { createBrowserRuntime } = await import(
  "@copilotz/copilotz/web"
);
const { uiWebPlugin, workspaceNavigation, workspaceUrlStorageAdapter } =
  await import("../../ui/web.ts");
const { createAdminWebPlugin } = await import("../../admin/web.ts");
const { MemorySubscriptions } = await import(
  "../../../client/testing/live-transport.test.ts"
);
const { coreWebPlugin } = await import("../../core/web.ts");
const { defineView } = await import("@copilotz/copilotz/views");
const { reactRenderer } = await import("../index.ts");
const { act } = React;
const document = window.document;
const button = (text: string) => {
  const node = [...document.querySelectorAll("button")].find((node) =>
    node.textContent?.trim() === text
  );
  assert.ok(node, `Missing button ${text}: ${document.body.innerHTML}`);
  return node;
};
async function click(text: string) {
  await act(async () => {
    button(text).click();
    await Promise.resolve();
  });
}
function host() {
  const element = document.createElement("div");
  document.body.appendChild(element);
  return element;
}

// One test owns this DOM and explicitly cleans up each mounted tree.
test("DOM interactions: confirmation, failure recovery, menus, copy and pane boundaries", async () => {
  const container = host();
  const root = createRoot(container as unknown as Element);
  let calls = 0, fail = true;
  const copied: string[] = [];
  try {
    await act(() =>
      root.render(
        <div>
          <ConfirmAction
            trigger={<Button>Delete</Button>}
            title="Delete record?"
            onConfirm={() => {
              calls++;
              if (fail) throw new Error("Try later");
              return true;
            }}
          />
          <CopyField
            label="Token"
            value="example"
            copy={(text) => {
              copied.push(text);
              return Promise.resolve();
            }}
          />
          <DropdownMenu>
            <DropdownMenuTrigger>Menu</DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem>Menu item</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>,
      )
    );
    await click("Delete");
    assert.equal(calls, 0);
    assert.match(document.body.textContent, /Delete record\?/);
    await click("Cancel");
    assert.equal(calls, 0);
    await click("Delete");
    await click("Confirm");
    assert.equal(calls, 1);
    assert.match(document.body.textContent, /Try later/);
    fail = false;
    await click("Confirm");
    assert.equal(calls, 2);
    assert.equal(document.querySelector('[role="dialog"]'), null);
    await click("Copy");
    assert.deepEqual(copied, ["example"]);
    assert.ok(button("Copied"));
    await act(() =>
      button("Menu").dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      )
    );
    assert.match(document.body.textContent, /Menu item/);
    const Broken = (): React.ReactNode => {
      throw new Error("Pane error");
    };
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args) => {
      errors.push(args);
    };
    try {
      await act(() =>
        root.render(
          <div>
            <PaneBoundary label="Context">
              <Broken />
            </PaneBoundary>
            <p>Focus survives</p>
          </div>,
        )
      );
    } finally {
      console.error = original;
    }
    assert.match(document.body.textContent, /Context failed to render/);
    assert.match(document.body.textContent, /Focus survives/);
    assert.ok(errors.length);
    await act(() =>
      root.render(
        <PaneBoundary key="next" label="Context">Recovered</PaneBoundary>,
      )
    );
    assert.match(document.body.textContent, /Recovered/);
  } finally {
    await act(() => root.unmount());
    container.remove();
  }
});

test("mounted workspace navigator, palette, swap, close and dialog compose with tracked panes", async () => {
  const view = defineView<{ id: string }, React.ReactNode, BrowserViewContext>({
    id: "test.item",
    shows: "item",
    renderer: "react",
    modes: ["full", "panel", "dialog"],
    render: ({ id }, ctx) => <p data-mode={ctx.hints.mode}>{id}</p>,
  });
  const runtime: BrowserRuntime = await createBrowserRuntime({
    renderer: reactRenderer,
    plugins: [uiWebPlugin(), {
      id: "app",
      views: { view },
      resources: {
        navigation: {
          a: { label: "Alpha", shows: "item", value: { id: "alpha" } },
          b: { label: "Beta", shows: "item", value: { id: "beta" } },
        },
      },
    }],
    show: workspaceNavigation(() => runtime),
  });
  const container = host();
  let mounted: { dispose(): void } | undefined;
  try {
    await act(() => {
      mounted = runtime.mount(container, { shows: "workspace", value: null });
    });
    await click("Alpha");
    assert.match(document.querySelector("main")!.textContent, /alpha/);
    await click("Beta");
    assert.match(document.querySelector("aside")!.textContent, /alpha/);
    await act(() =>
      document.querySelector('[aria-label="Swap focus and context"]')!
        .dispatchEvent(new window.MouseEvent("click", { bubbles: true }))
    );
    assert.match(document.querySelector("main")!.textContent, /alpha/);
    await click("Close context");
    assert.equal(document.querySelector("aside"), null);
    await act(() =>
      globalThis.dispatchEvent(
        Object.assign(new NativeEvent("keydown"), { key: "k", ctrlKey: true }),
      )
    );
    assert.ok(document.querySelector('[aria-label="Find a view"]'));
    // Dialog opens from application navigation without changing either pane.
    await act(() =>
      runtime.actions.uiOpen({
        reference: { shows: "item", value: { id: "dialog body" } },
        mode: "dialog",
      }).result()
    );
    assert.match(document.body.textContent, /dialog body/);
    await act(() => runtime.actions.uiClose({ region: "dialog" }).result());
  } finally {
    await act(() => mounted?.dispose());
    runtime.dispose();
    container.remove();
  }
});

test("core conversation creation sends name and Stop cancels only after confirmation", async () => {
  const live =
    new (await import("../../../client/testing/live-transport.test.ts"))
      .MemorySubscriptions();
  const calls: { id: string; input: unknown }[] = [];
  const cancelled: string[] = [];
  let finish: ((value: { value: unknown; seq: number }) => void) | undefined;
  const runtime = await createBrowserRuntime({
    renderer: reactRenderer,
    plugins: [coreWebPlugin, {
      id: "app",
      resources: { chat: { sender: { id: "p" } } },
    }],
    live,
    actions: {
      invoke(id, input, options) {
        calls.push({ id, input });
        if (id === "createThreadMessage") {
          options.accepted("active-operation");
          return new Promise((resolve) => {
            finish = resolve;
          });
        }
        return Promise.resolve({ value: {}, seq: 1 });
      },
      cancel(id) {
        cancelled.push(id);
        finish?.({ value: {}, seq: 1 });
        return Promise.resolve();
      },
    },
    show: () => {},
  });
  const container = host();
  let mounted: { dispose(): void } | undefined;
  try {
    await act(() => {
      mounted = runtime.mount(container, {
        shows: { list: "thread" },
        value: null,
      });
    });
    await click("New conversation");
    const input = document.querySelector("input")!;
    await act(() => {
      Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, "Named conversation");
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    await act(() =>
      document.querySelector("form")!.dispatchEvent(
        new window.Event("submit", { bubbles: true, cancelable: true }),
      )
    );
    assert.equal(
      (calls[0]?.input as { name: string })?.name,
      "Named conversation",
    );
    assert.ok(!("title" in (calls[0].input as object)));
    await act(() => mounted!.dispose());
    await runtime.actions.setDraft({ threadId: "t", text: "Hello" }).result();
    await act(() => {
      mounted = runtime.mount(container, {
        shows: "composer",
        value: { threadId: "t" },
      });
    });
    await act(() =>
      document.querySelector("form")!.dispatchEvent(
        new window.Event("submit", { bubbles: true, cancelable: true }),
      )
    );
    await click("Stop");
    assert.deepEqual(cancelled, []);
    await click("Cancel");
    assert.deepEqual(cancelled, []);
    await click("Stop");
    await click("Stop response");
    assert.deepEqual(cancelled, ["active-operation"]);
  } finally {
    finish?.({ value: {}, seq: 1 });
    await act(() => mounted?.dispose());
    runtime.dispose();
    container.remove();
  }
});

test("URL state: an admin query waits for Load and a refused View stays in its pane", async () => {
  const calls: { id: string; input: unknown }[] = [];
  const url = new URL(
    "https://app.example/?admin=threads&spoof=%2A%2ASpoofed%2A%2A",
  );
  const runtime: BrowserRuntime = await createBrowserRuntime({
    renderer: reactRenderer,
    plugins: [uiWebPlugin("url"), createAdminWebPlugin()],
    live: new MemorySubscriptions(),
    actions: {
      invoke(id, input) {
        calls.push({ id, input });
        return Promise.resolve({
          seq: 1,
          value: { status: 200, data: [{ id: "t", name: "Loaded thread" }] },
        });
      },
      cancel: () => Promise.resolve(),
    },
    storage: {
      url: workspaceUrlStorageAdapter({ read: () => url, replace() {} }, {
        decode: (url) => ({
          focus: {
            shows: "adminQuery",
            value: { section: url.searchParams.get("admin") },
          },
          context: {
            shows: "message",
            value: { id: "m", content: url.searchParams.get("spoof") },
          },
          dialog: null,
        }),
        encode() {},
      }),
    },
  });
  const container = host();
  let mounted: { dispose(): void } | undefined;
  const original = console.error;
  console.error = () => {}; // React logs the contained pane error.
  try {
    await act(() => {
      mounted = runtime.mount(container, {
        shows: "workspacePanes",
        value: null,
      });
    });
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    assert.equal(calls.length, 0, "URL state must not submit the query");
    assert.match(
      document.querySelector("main")!.textContent,
      /Opened from a link/,
    );
    const aside = document.querySelector("aside")!.textContent;
    assert.match(aside, /cannot be opened from a URL/);
    assert.doesNotMatch(document.body.textContent, /Spoofed/);
    await click("Load");
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    assert.deepEqual(calls.map((call) => call.id), ["adminThreads"]);
    assert.match(document.querySelector("main")!.textContent, /Loaded thread/);
  } finally {
    console.error = original;
    await act(() => mounted?.dispose());
    runtime.dispose();
    container.remove();
  }
});
