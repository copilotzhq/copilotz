/**
 * The live view of who's browser (ported from sandbox-lite, not yet wired to
 * a workload): viewers get screencast frames, newest first with one
 * unacknowledged at a time, and one who takes control may click, type and
 * navigate until they hand it back. Agents wait for that (see control.ts).
 */
import { randomUUID } from "node:crypto";
import { browserError, deadline, isBrowserError, message, race } from "./async.ts";
import { finite, keyPress, type Page } from "./page.ts";
import type { Session } from "./session.ts";

export type Input = {
  type: "input";
  id: string;
  sequence?: number;
  pageId: string;
  revision?: number;
  contextRevision?: number;
  command:
    | "click"
    | "text"
    | "key"
    | "scroll"
    | "navigate"
    | "back"
    | "forward"
    | "reload"
    | "dialog";
  x?: number;
  y?: number;
  text?: string;
  key?: string;
  deltaX?: number;
  deltaY?: number;
  url?: string;
  accept?: boolean;
};

export type ViewerMessage =
  | Input
  | { type: "ack"; id: number }
  | { type: "control"; id: string; command: "take" | "release" | "state" };

export type Frame = {
  type: "frame";
  id: number;
  revision: number;
  contextRevision: number;
  pageId: string;
  url: string;
  title: string;
  width: number;
  height: number;
  image: string;
  busy: boolean;
  dialog?: { type: string; message: string };
};

export type ServerMessage =
  | Frame
  | {
    type: "input-result";
    id: string;
    ok: boolean;
    sequence?: number;
    status: "accepted" | "dropped" | "stale" | "busy";
    contextRevision: number;
    error?: string;
    code?: string;
  }
  | { type: "ready"; viewerId: string }
  | {
    type: "control";
    controller: string;
    viewerId?: string;
    busy: boolean;
    contextRevision: number;
    pageId?: string;
    dialog?: { type: string; message: string };
  }
  | { type: "capture-unavailable"; retryAfterMs?: number }
  | { type: "disconnected"; message: string };

/** A viewer's connection, as parsed messages both ways (its transport frames them). */
export type Duplex = {
  readable: ReadableStream<ViewerMessage>;
  writable: WritableStream<ServerMessage>;
};

/** One frame in flight per viewer, and the newest waiting (older ones are dropped). */
export function createPacer(send: (frame: Frame) => void) {
  let outstanding: number | undefined;
  let latest: Frame | undefined;
  let sent = 0;
  const pump = () => {
    if (outstanding !== undefined || !latest || latest.id <= sent) return;
    outstanding = sent = latest.id;
    send(latest);
  };
  return {
    offer(frame: Frame) {
      latest = frame;
      pump();
    },
    ack(id: number) {
      if (id !== outstanding) return;
      outstanding = undefined;
      pump();
    },
    invalidate() {
      latest = undefined;
    },
  };
}

function text(value: unknown, max: number) {
  if (typeof value !== "string" || value.length > max) throw new Error("Invalid input text");
  return value;
}

/** A person's input to the page. */
export async function humanInput(page: Page, input: Input, signal: AbortSignal) {
  switch (input.command) {
    case "click": {
      const x = finite(input.x, "x", page.width);
      const y = finite(input.y, "y", page.height);
      if (x < 0 || y < 0 || x >= page.width || y >= page.height) {
        throw new Error("Input is outside the viewport");
      }
      await page.mouse({ action: "mouseClick", x, y }, signal);
      break;
    }
    case "text":
      await page.cdp.send("Input.insertText", { text: text(input.text, 4096) }, signal);
      break;
    case "key":
      await keyPress(page.cdp, text(input.key, 80), signal);
      break;
    case "scroll":
      await page.cdp.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: page.width / 2,
        y: page.height / 2,
        deltaX: finite(input.deltaX ?? 0, "deltaX", 10000),
        deltaY: finite(input.deltaY ?? 0, "deltaY", 10000),
      }, signal);
      break;
    case "navigate":
      await page.navigate(text(input.url, 4096), signal, "commit", true);
      break;
    case "back":
    case "forward":
      await page.history(input.command, signal);
      break;
    case "reload":
      await page.cdp.send("Page.reload", {}, signal);
      break;
    case "dialog":
      await page.cdp.send("Page.handleJavaScriptDialog", {
        accept: input.accept === true,
        promptText: input.text === undefined ? "" : text(input.text, 4096),
      }, signal);
      break;
    default:
      throw new Error("Unsupported browser input");
  }
}

type Viewer = {
  id: string;
  send(value: ServerMessage): Promise<void>;
  pacer: ReturnType<typeof createPacer>;
  abort: AbortController;
  done: Promise<void>;
};

/** The live view of `session`; `serialize` runs input in turn with the agents' batches. */
export function createLiveHub(
  session: Session,
  serialize: <T>(fn: () => Promise<T>) => Promise<T>,
) {
  const viewers = new Map<string, Viewer>();
  let page: Page | undefined;
  const off: (() => void)[] = [];
  let last: Frame | undefined;
  let next = 0;
  let context = 0;
  let closed = false;
  let switching: Promise<void> = Promise.resolve();

  const state = (): ServerMessage => ({
    type: "control",
    ...session.control.state(),
    contextRevision: context,
    pageId: session.page?.identity,
    dialog: session.page?.dialog,
  });

  const stateChanged = () => {
    context++;
    last = undefined;
    for (const viewer of viewers.values()) {
      viewer.pacer.invalidate();
      void viewer.send(state()).catch(() => viewer.abort.abort());
    }
  };

  const controlChanged = () => {
    const frame = last;
    stateChanged();
    if (frame && frame.pageId === session.page?.identity) {
      last = { ...frame, id: ++next, contextRevision: context, busy: session.control.agent };
      for (const viewer of viewers.values()) viewer.pacer.offer(last);
    }
  };

  const unavailable = () => {
    for (const viewer of viewers.values()) {
      void viewer.send({ type: "capture-unavailable", retryAfterMs: 1000 })
        .catch(() => viewer.abort.abort());
    }
  };

  const switchPage = () => {
    switching = switching.then(async () => {
      for (const stop of off.splice(0)) stop();
      if (page) await page.cdp.send("Page.stopScreencast").catch(() => {});
      page = session.page;
      stateChanged();
      const current = page;
      if (!current || !viewers.size) return;
      const firstFrame = setTimeout(unavailable, 5000);
      off.push(() => clearTimeout(firstFrame));
      current.changes.add(stateChanged);
      off.push(() => current.changes.delete(stateChanged));
      off.push(
        current.cdp.on<{ data: string; sessionId: number }>("Page.screencastFrame", (event) => {
          clearTimeout(firstFrame);
          // Chrome's ACK is apart from the viewers': only the newest pixels are kept.
          void current.cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId })
            .catch(() => {});
          if (current !== page || event.data.length > 2 * 1024 * 1024) return unavailable();
          const frame: Frame = {
            type: "frame",
            id: ++next,
            revision: current.revision,
            contextRevision: context,
            pageId: current.identity,
            url: current.url,
            title: current.title,
            width: current.width,
            height: current.height,
            image: event.data,
            busy: session.control.agent,
            dialog: current.dialog,
          };
          last = frame;
          for (const viewer of viewers.values()) viewer.pacer.offer(frame);
        }),
      );
      await current.cdp.send("Page.startScreencast", {
        format: "jpeg",
        quality: 65,
        maxWidth: current.width,
        maxHeight: current.height,
        everyNthFrame: 1,
      });
    }).catch(unavailable);
  };

  const close = async () => {
    closed = true;
    const all = [...viewers.values()];
    for (const viewer of all) {
      void viewer.send({ type: "disconnected", message: "The browser is closing" }).catch(() => {});
      viewer.abort.abort();
    }
    await Promise.all(all.map((viewer) => viewer.done));
    await switching;
    for (const stop of off.splice(0)) stop();
    session.control.changes.delete(controlChanged);
    session.pageChanges.delete(switchPage);
    session.closing.delete(close);
  };

  session.control.changes.add(controlChanged);
  session.pageChanges.add(switchPage);
  session.closing.add(close);

  /** Serves one viewer until it leaves (or the browser closes). */
  async function attach(duplex: Duplex, signal?: AbortSignal) {
    if (closed) throw browserError("disconnected", "The browser closed");
    const id = randomUUID();
    const abort = new AbortController();
    const parentAbort = () => abort.abort(signal?.reason);
    signal?.addEventListener("abort", parentAbort, { once: true });
    if (signal?.aborted) parentAbort();
    const reader = duplex.readable.getReader();
    const writer = duplex.writable.getWriter();
    const send = async (value: ServerMessage) => {
      const limit = deadline(5000, abort.signal);
      try {
        await race(writer.write(value), limit.signal);
      } finally {
        limit.dispose();
      }
    };
    let finish!: () => void;
    const done = new Promise<void>((resolve) => finish = resolve);
    const viewer: Viewer = {
      id,
      send,
      abort,
      done,
      pacer: createPacer((frame) => void send(frame).catch(() => abort.abort())),
    };
    viewers.set(id, viewer);
    let sequence = -1;
    try {
      await send({ type: "ready", viewerId: id });
      await send(state());
      if (viewers.size === 1) {
        switchPage();
        await switching;
      } else if (last) viewer.pacer.offer(last);
      while (!abort.signal.aborted) {
        const { value: input, done } = await race(reader.read(), abort.signal);
        if (done) break;
        if (!input || typeof input !== "object") throw new Error("Invalid viewer message");
        if (input.type === "ack") {
          viewer.pacer.ack(input.id);
          continue;
        }
        if (input.type !== "input" && input.type !== "control") {
          throw new Error("Unknown viewer message");
        }
        text(input.id, 160);
        try {
          if (input.type === "control") {
            if (input.command === "take") session.control.take(id);
            else if (input.command === "release") session.control.release(id);
            else if (input.command !== "state") throw new Error("Unknown control command");
            await send(state());
          } else {
            if (input.sequence !== undefined) {
              if (!Number.isSafeInteger(input.sequence) || input.sequence <= sequence) {
                throw browserError("stale", "Input sequence was already consumed");
              }
              sequence = input.sequence;
            }
            // Checked again in turn, after the agents' work before it.
            await race(
              serialize(async () => {
                abort.signal.throwIfAborted();
                session.control.assertHuman(id);
                const current = session.page;
                if (
                  !current || input.pageId !== current.identity ||
                  (input.contextRevision !== undefined
                    ? input.contextRevision !== context
                    : input.revision !== current.revision)
                ) {
                  throw browserError("stale", "Page or controller changed; wait for a fresh frame");
                }
                const limit = deadline(15_000, abort.signal);
                try {
                  await humanInput(current, input, limit.signal);
                  await session.followPopup(limit.signal);
                } finally {
                  limit.dispose();
                }
              }),
              abort.signal,
            );
          }
          await send({
            type: "input-result",
            id: input.id,
            ok: true,
            status: "accepted",
            sequence: input.type === "input" ? input.sequence : undefined,
            contextRevision: context,
          });
        } catch (error) {
          const code = isBrowserError(error) ? error.code : "input_failed";
          await send({
            type: "input-result",
            id: input.id,
            ok: false,
            status: code === "stale" ? "stale" : code === "busy" ? "busy" : "dropped",
            sequence: input.type === "input" ? input.sequence : undefined,
            contextRevision: context,
            code,
            error: message(error),
          });
        }
      }
    } catch (error) {
      if (!abort.signal.aborted) {
        await send({ type: "disconnected", message: message(error) }).catch(() => {});
      }
    } finally {
      viewers.delete(id);
      session.control.release(id);
      abort.abort();
      signal?.removeEventListener("abort", parentAbort);
      await reader.cancel().catch(() => {});
      // A stalled transport can't keep the browser open.
      void writer.abort().catch(() => {});
      reader.releaseLock();
      if (!viewers.size) {
        switchPage();
        await switching;
      }
      finish();
    }
  }

  return {
    attach,
    close,
    get closed() {
      return closed;
    },
    /** How many watch. */
    get watching() {
      return viewers.size;
    },
  };
}
