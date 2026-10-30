/**
 * One tab, driven over its DevTools session: where it is, what it says
 * (text and an accessibility snapshot with element refs), and input to it
 * (clicks, typing, keys) that waits for its element to be visible and still.
 */
import { randomUUID } from "node:crypto";
import process from "node:process";
import { browserError, delay } from "./async.ts";
import type { DevTools, Params } from "./cdp.ts";
import { holdMath } from "./math.ts";
import { type AXNode, createRefs, type Refs } from "./refs.ts";
import type { Action } from "./types.ts";

type Remote = {
  result: { value?: unknown; objectId?: string; description?: string };
  exceptionDetails?: { text: string };
};

export type Box = { x: number; y: number; width: number; height: number };

export type Page = {
  readonly id: string;
  readonly cdp: DevTools;
  readonly width: number;
  readonly height: number;
  readonly refs: Refs;
  /** Changes with each document (the live view's page identity). */
  identity: string;
  revision: number;
  url: string;
  title: string;
  frameId: string;
  httpStatus?: number;
  dialog?: { type: string; message: string };
  /** Heard when anything a viewer shows changes. */
  readonly changes: Set<() => void>;
  changed(): void;
  dispose(): void;
  init(signal: AbortSignal, ignoreHTTPSErrors?: boolean): Promise<void>;
  evaluate<T = unknown>(expression: string, signal: AbortSignal): Promise<T>;
  summary(signal: AbortSignal): Promise<{ url: string; title: string; httpStatus?: number }>;
  snapshot(signal: AbortSignal, maxChars?: number): Promise<ReturnType<Refs["snapshot"]>>;
  read(action: Action, signal: AbortSignal): Promise<Record<string, unknown>>;
  object(action: Pick<Action, "ref" | "selector" | "text">, signal: AbortSignal): Promise<string>;
  call<T>(objectId: string, functionDeclaration: string, signal: AbortSignal): Promise<T>;
  release(objectId: string): Promise<void>;
  box(objectId: string, signal: AbortSignal, hitTest?: boolean): Promise<Box>;
  click(action: Action, signal: AbortSignal): Promise<void>;
  fill(action: Action, signal: AbortSignal): Promise<void>;
  mouse(action: Action, signal: AbortSignal, move?: boolean): Promise<void>;
  wait(until: string, signal: AbortSignal): Promise<void>;
  navigate(url: string, signal: AbortSignal, until?: string, renderMath?: boolean): Promise<void>;
  history(direction: "back" | "forward", signal: AbortSignal): Promise<void>;
};

/** A number in range, or an error naming it. */
export function finite(value: unknown, name: string, limit = 100_000): number {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > limit) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}

/** The page of target `id`, on its DevTools session `cdp`. */
export function createPage(id: string, cdp: DevTools, width: number, height: number): Page {
  let loaderId = "";
  const requests = new Set<string>();
  let lastNetwork = Date.now();
  const off: (() => void)[] = [];

  const page: Page = {
    id,
    cdp,
    width,
    height,
    refs: createRefs(),
    identity: randomUUID(),
    revision: 0,
    url: "about:blank",
    title: "",
    frameId: "",
    changes: new Set(),
    changed() {
      page.revision++;
      for (const fn of page.changes) fn();
    },
    dispose() {
      for (const stop of off.splice(0)) stop();
      page.changes.clear();
    },
    async init(signal, ignoreHTTPSErrors = true) {
      for (const domain of ["Page", "Runtime", "DOM", "Accessibility", "Network"]) {
        await cdp.send(`${domain}.enable`, {}, signal);
      }
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      }, signal);
      if (ignoreHTTPSErrors) {
        await cdp.send("Security.setIgnoreCertificateErrors", { ignore: true }, signal);
      }
      const tree = await cdp.send<{ frameTree: { frame: { id: string; url: string } } }>(
        "Page.getFrameTree",
        {},
        signal,
      );
      page.frameId = tree.frameTree.frame.id;
      page.url = tree.frameTree.frame.url;
      await page.summary(signal);
    },
    async evaluate<T>(expression: string, signal: AbortSignal) {
      const response = await cdp.send<Remote>("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
      }, signal);
      if (response.exceptionDetails) {
        throw browserError(
          "evaluation_error",
          response.result.description ?? response.exceptionDetails.text,
        );
      }
      return response.result.value as T;
    },
    async summary(signal) {
      if (!page.dialog) {
        const state = await page.evaluate<{ url: string; title: string }>(
          "({url: location.href, title: document.title})",
          signal,
        );
        page.url = state.url;
        page.title = state.title;
      }
      return {
        url: page.url,
        title: page.title,
        ...(page.httpStatus === undefined ? {} : { httpStatus: page.httpStatus }),
      };
    },
    async snapshot(signal, maxChars) {
      const { nodes } = await cdp.send<{ nodes: AXNode[] }>(
        "Accessibility.getFullAXTree",
        {},
        signal,
      );
      return page.refs.snapshot(nodes, maxChars);
    },
    async read(action, signal) {
      const max = Math.max(1, Math.min(action.maxChars ?? 100_000, 1_000_000));
      const state = await page.summary(signal);
      if (page.dialog) return { ...state, dialog: page.dialog };
      let objectId: string | undefined;
      try {
        if (action.selector || action.ref) objectId = await page.object(action, signal);
        const fn =
          `function() { const n = this === window ? document.body : this; const text = n?.innerText ?? n?.textContent ?? ''; const html = ${
            action.includeHtml === true
          } ? (n?.outerHTML ?? '') : undefined; return {text: text.slice(0, ${max}), textTruncated: text.length > ${max}, ...(html === undefined ? {} : {html: html.slice(0, ${max}), htmlTruncated: html.length > ${max}})}; }`;
        const content = objectId
          ? await page.call<Params>(objectId, fn, signal)
          : await page.evaluate<Params>(`(${fn}).call(window)`, signal);
        return { ...state, ...content, ...await page.snapshot(signal, max) };
      } finally {
        if (objectId) await page.release(objectId);
      }
    },
    async object(action, signal) {
      const ref = action.ref ?? (action.selector?.startsWith("@") ? action.selector : undefined);
      if (ref) {
        const result = await cdp.send<{ object: { objectId?: string } }>(
          "DOM.resolveNode",
          { backendNodeId: page.refs.resolve(ref) },
          signal,
        );
        if (!result.object.objectId) throw browserError("stale_ref", "Element no longer exists");
        return result.object.objectId;
      }
      if (!action.selector && !action.text) throw new Error("selector, ref or text is required");
      const expression = action.selector
        ? `document.querySelector(${JSON.stringify(action.selector)})`
        : `Array.from(document.querySelectorAll('body *')).find(n => n.textContent.includes(${
          JSON.stringify(action.text)
        }) && !Array.from(n.children).some(c => c.textContent.includes(${
          JSON.stringify(action.text)
        })))`;
      while (true) {
        signal.throwIfAborted();
        const response = await cdp.send<Remote>("Runtime.evaluate", { expression }, signal);
        if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
        if (response.result.objectId) return response.result.objectId;
        await delay(50, signal);
      }
    },
    async call<T>(objectId: string, functionDeclaration: string, signal: AbortSignal) {
      const result = await cdp.send<Remote>("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
      }, signal);
      if (result.exceptionDetails) {
        throw new Error(result.result.description ?? result.exceptionDetails.text);
      }
      return result.result.value as T;
    },
    async release(objectId) {
      await cdp.send("Runtime.releaseObject", { objectId }).catch(() => {});
    },
    async box(objectId, signal, hitTest = true) {
      await cdp.send("DOM.scrollIntoViewIfNeeded", { objectId }, signal);
      let previous = "";
      while (true) {
        signal.throwIfAborted();
        const value = await page.call<Box & { visible: boolean; hit: boolean }>(
          objectId,
          `function() { const r = this.getBoundingClientRect(), s = getComputedStyle(this); const x = Math.max(0,r.left), y = Math.max(0,r.top), right = Math.min(innerWidth,r.right), bottom = Math.min(innerHeight,r.bottom); const hit = this.ownerDocument.elementFromPoint((x+right)/2,(y+bottom)/2); return {x,y,width:right-x,height:bottom-y,visible:!!this.isConnected && s.visibility !== 'hidden' && s.display !== 'none' && !this.disabled,hit:hit === this || this.contains(hit)}; }`,
          signal,
        );
        const current = JSON.stringify(value);
        if (
          value.visible && value.width > 0 && value.height > 0 && (!hitTest || value.hit) &&
          current === previous
        ) return value;
        previous = current;
        await delay(50, signal);
      }
    },
    async click(action, signal) {
      const objectId = await page.object(action, signal);
      try {
        const box = await page.box(objectId, signal);
        await page.mouse(
          { ...action, x: box.x + box.width / 2, y: box.y + box.height / 2 },
          signal,
        );
      } finally {
        await page.release(objectId);
      }
    },
    async fill(action, signal) {
      if (typeof action.text !== "string") throw new Error("type.text must be a string");
      const objectId = await page.object(action, signal);
      try {
        await page.box(objectId, signal, false);
        const editable = await page.call<boolean>(
          objectId,
          "function() { if (this.readOnly || this.disabled) return false; if (this.isContentEditable) { this.focus(); const r=document.createRange(); r.selectNodeContents(this); const s=getSelection(); s.removeAllRanges(); s.addRange(r); return true; } if (this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement) { this.focus(); this.select(); return true; } return false; }",
          signal,
        );
        if (!editable) throw new Error("Element is not an editable text field");
        if (action.text === "") await keyPress(cdp, "Backspace", signal);
        else await cdp.send("Input.insertText", { text: action.text }, signal);
      } finally {
        await page.release(objectId);
      }
    },
    async mouse(action, signal, move = false) {
      const x = finite(action.x, "x");
      const y = finite(action.y, "y");
      const params = { x, y, button: action.button ?? "left", clickCount: action.clickCount ?? 1 };
      if (move) {
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, signal);
        return;
      }
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...params }, signal);
      try {
        if (action.delayMs) await delay(action.delayMs, signal);
      } finally {
        await cdp.send(
          "Input.dispatchMouseEvent",
          { type: "mouseReleased", ...params },
          signal.aborted ? undefined : signal,
        );
      }
    },
    async wait(until, signal) {
      if (until === "commit") return;
      while (true) {
        const ready = await page.evaluate<string>("document.readyState", signal);
        if (
          until === "networkidle"
            ? ready !== "loading" && !requests.size && Date.now() - lastNetwork >= 500
            : until === "load"
            ? ready === "complete"
            : ready !== "loading"
        ) return;
        await delay(50, signal);
      }
    },
    async navigate(url, signal, until = "domcontentloaded", renderMath = false) {
      const parsed = new URL(url);
      if (!["http:", "https:", "about:"].includes(parsed.protocol)) {
        throw new Error("Only HTTP(S) and about navigation is supported");
      }
      page.httpStatus = undefined;
      const release = renderMath ? undefined : await holdMath(cdp, signal);
      try {
        const result = await cdp.send<{ errorText?: string; loaderId?: string }>(
          "Page.navigate",
          { url },
          signal,
        );
        if (result.errorText) throw new Error(result.errorText);
        while (result.loaderId && result.loaderId !== loaderId) await delay(20, signal);
        await page.wait(until, signal);
      } finally {
        await release?.();
      }
    },
    async history(direction, signal) {
      const history = await cdp.send<{ currentIndex: number; entries: { id: number }[] }>(
        "Page.getNavigationHistory",
        {},
        signal,
      );
      const entry = history.entries[history.currentIndex + (direction === "back" ? -1 : 1)];
      if (entry) {
        await cdp.send("Page.navigateToHistoryEntry", { entryId: entry.id }, signal);
        await page.wait("domcontentloaded", signal);
      }
    },
  };

  off.push(
    cdp.on<{ frame: { id: string; loaderId?: string; parentId?: string; url: string } }>(
      "Page.frameNavigated",
      ({ frame }) => {
        if (frame.parentId) return;
        page.frameId = frame.id;
        loaderId = frame.loaderId ?? "";
        page.url = frame.url;
        page.identity = randomUUID();
        page.refs.reset();
        page.changed();
      },
    ),
    cdp.on<{ url: string; frameId: string }>("Page.navigatedWithinDocument", (e) => {
      if (e.frameId !== page.frameId) return;
      page.url = e.url;
      page.changed();
    }),
    cdp.on<{ type: string; message: string }>("Page.javascriptDialogOpening", (e) => {
      page.dialog = { type: e.type, message: e.message.slice(0, 2048) };
      page.changed();
    }),
    cdp.on("Page.javascriptDialogClosed", () => {
      page.dialog = undefined;
      page.changed();
    }),
    cdp.on<{ requestId: string; type: string }>("Network.requestWillBeSent", (e) => {
      if (!["WebSocket", "EventSource"].includes(e.type)) requests.add(e.requestId);
      lastNetwork = Date.now();
    }),
    ...["Network.loadingFinished", "Network.loadingFailed"].map((name) =>
      cdp.on<{ requestId: string }>(name, (e) => {
        requests.delete(e.requestId);
        lastNetwork = Date.now();
      })
    ),
    cdp.on<{ type: string; frameId: string; response: { status: number } }>(
      "Network.responseReceived",
      (e) => {
        if (e.type === "Document" && e.frameId === page.frameId) {
          page.httpStatus = e.response.status;
        }
      },
    ),
  );
  return page;
}

/** A key (or chord, `Control+a`), as Playwright's keyboard.press names them. */
export async function keyPress(cdp: DevTools, chord: string, signal: AbortSignal, delayMs = 0) {
  const parts = chord.split("+");
  const key = parts.pop()!;
  const bits: Record<string, number> = {
    Alt: 1,
    Control: 2,
    Ctrl: 2,
    Meta: 4,
    Shift: 8,
    ControlOrMeta: process.platform === "darwin" ? 4 : 2,
  };
  let modifiers = 0;
  for (const part of parts) {
    if (!bits[part]) throw new Error(`Unknown key modifier ${part}`);
    modifiers |= bits[part];
  }
  const codes: Record<string, number> = {
    Enter: 13,
    Tab: 9,
    Backspace: 8,
    Delete: 46,
    Escape: 27,
    ArrowLeft: 37,
    ArrowUp: 38,
    ArrowRight: 39,
    ArrowDown: 40,
    Home: 36,
    End: 35,
    PageUp: 33,
    PageDown: 34,
    Space: 32,
  };
  const actual = key === "Space" ? " " : key;
  const code = codes[key] ??
    (key.length === 1
      ? key.toUpperCase().charCodeAt(0)
      : /^F([1-9]|1[0-2])$/.test(key)
      ? 111 + Number(key.slice(1))
      : undefined);
  if (code === undefined) throw new Error(`Unsupported key ${key}`);
  const text = !(modifiers & 7)
    ? (actual.length === 1 ? actual : key === "Enter" ? "\r" : undefined)
    : undefined;
  const params = {
    key: actual,
    modifiers,
    windowsVirtualKeyCode: code,
    ...(text ? { text, unmodifiedText: text } : {}),
  };
  await cdp.send(
    "Input.dispatchKeyEvent",
    { type: text ? "keyDown" : "rawKeyDown", ...params },
    signal,
  );
  try {
    if (delayMs) await delay(delayMs, signal);
  } finally {
    await cdp.send(
      "Input.dispatchKeyEvent",
      { type: "keyUp", ...params },
      signal.aborted ? undefined : signal,
    );
  }
}
