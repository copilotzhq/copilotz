/** @jsxRuntime classic */
/** @jsx React.createElement */
import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import type { ReadFailure, ReadState } from "@copilotz/copilotz/web";

// Install the DOM before ReactDOM and Radix load; they detect it at import.
const window = new Window({ url: "https://app.example/" });
for (
  const name of [
    "document",
    "navigator",
    "HTMLElement",
    "HTMLButtonElement",
    "Element",
    "Node",
    "Event",
    "MouseEvent",
    "getComputedStyle",
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

const { act } = React;
const { createRoot } = await import("react-dom/client");
const { isReconnecting, ReadStatus } = await import("../index.ts");

/** The structured 503 an Action read and a dropped socket both report. */
const unavailable: ReadFailure = {
  kind: "unavailable",
  code: "unavailable",
  message: "Computer is reconnecting",
  status: 503,
  retryable: true,
};

async function mount(element: React.ReactElement) {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container as never);
  const root = createRoot(container as unknown as HTMLElement);
  await act(() => root.render(element));
  return {
    container,
    button: (label: string) =>
      [...container.querySelectorAll("button")].find((button) =>
        button.textContent?.trim() === label
      ),
    async unmount() {
      await act(() => root.unmount());
      container.remove();
    },
  };
}

test("a failed Action read says so at once and Try again refreshes it", async () => {
  let refreshed = 0;
  const state: ReadState & { refresh(): void } = {
    value: undefined,
    status: "failed",
    pending: false,
    error: unavailable,
    refresh() {
      refreshed++;
    },
  };
  assert.equal(isReconnecting(state), false, "nothing retries it by itself");
  // Even in a View that leaves reconnecting to the shell's indicator.
  const view = await mount(
    <ReadStatus state={state} noun="files" compact transient="quiet" />,
  );
  try {
    assert.match(view.container.textContent ?? "", /Couldn't load files/);
    const retry = view.button("Try again");
    assert.ok(retry, "a failed read offers Try again");
    await act(() => retry.click());
    assert.equal(refreshed, 1);
  } finally {
    await view.unmount();
  }
});

test("a live read that is reconnecting stays quiet and offers no button", async () => {
  // The same structured 503, on a live read: it reconnects by itself.
  const state: ReadState & { refresh(): void } = {
    value: [],
    status: "stale",
    pending: false,
    error: unavailable,
    refresh() {
      throw new Error("A reconnecting read is not retried by hand.");
    },
  };
  assert.equal(isReconnecting(state), true);
  const quiet = await mount(<ReadStatus state={state} transient="quiet" />);
  try {
    assert.equal(quiet.container.textContent, "", "the shell's indicator");
  } finally {
    await quiet.unmount();
  }
  const notice = await mount(<ReadStatus state={state} noun="files" />);
  try {
    // Nothing during a brief reconnect, then one quiet line.
    assert.equal(notice.container.textContent, "");
    await act(() => new Promise((resolve) => setTimeout(resolve, 2600)));
    assert.match(notice.container.textContent ?? "", /Reconnecting…/);
    assert.doesNotMatch(notice.container.textContent ?? "", /Couldn't load/);
    assert.equal(notice.button("Try again"), undefined);
  } finally {
    await notice.unmount();
  }
});
