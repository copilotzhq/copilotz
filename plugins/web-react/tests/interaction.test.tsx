/** @jsxRuntime classic */
/** @jsx React.createElement */
import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";

// Install the DOM before loading ReactDOM/Radix, which detect it at module load.
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
