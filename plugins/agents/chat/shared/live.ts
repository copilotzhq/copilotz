/**
 * Writing a turn's `live` document as it streams: at most every LIVE_MS, one
 * write at a time. It is there from the step's start (an agent at work,
 * before its first token). Before the commit that writes what the step
 * became, it stops (`settle`), and that commit removes the document (`done`).
 * When the model's call breaks and is tried again (`retry`), it says when,
 * and keeps what it showed until the new attempt writes something.
 */
import type { Context, TransactionScope } from "../../../../runtime/mod.ts";
import type { Live, LiveCall } from "../collections/live.ts";
import { NO_ANSWER, now } from "./agents.ts";
import type { Turn } from "./types.ts";

/** How often a turn's live document is written, at most (ms). */
export const LIVE_MS = 50;

export type LiveWriter = {
  /** A step starts: the document shows the agent at work. */
  begin(): void;
  /** Tokens of the step's answer. */
  text(delta: string): void;
  /** The model's call broke: it's tried again in `wait` ms. */
  retry(at: { attempt: number; wait: number; reason: string }): void;
  /** A tool call starting, then what it returned. */
  call(call: LiveCall): void;
  result(id: string, output: string): void;
  /** Stops writing and waits for what's on its way: the step's commit comes next. */
  settle(): Promise<void>;
  /** In the step's commit: removes the document. The next step starts a new one. */
  done(tx: TransactionScope): Promise<unknown>;
};

export function liveWriter(ctx: Context, t: Turn, run: string, space?: string): LiveWriter {
  const live = ctx.db.collection<Omit<Live, "_id">>("live");
  let doc: Omit<Live, "_id"> = fresh();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let writing = Promise.resolve();
  let dirty = false;

  function fresh(): Omit<Live, "_id"> {
    return {
      thread: t.thread,
      agent: t.agent,
      turn: run,
      text: "",
      calls: [],
      ...(space ? { in: space } : {}),
      at: now(),
    };
  }
  const write = () => {
    timer = undefined;
    if (!dirty) return;
    dirty = false;
    const shown = structuredClone(doc);
    writing = writing.then(() =>
      live.replaceOne({ _id: run }, shown, { upsert: true }).then(() => {}, () => {})
    );
  };
  const soon = () => {
    dirty = true;
    timer ??= setTimeout(write, LIVE_MS);
  };

  /** After a retry, what the new attempt writes replaces what the broken one did. */
  const over = () => {
    if (!doc.retry) return;
    const { retry: _, ...rest } = doc;
    doc = { ...rest, text: "", calls: [] };
  };

  return {
    begin: soon,
    text(delta) {
      over();
      doc.text += delta;
      soon();
    },
    retry({ attempt, wait, reason }) {
      doc.retry = { attempt, at: new Date(Date.now() + wait).toISOString(), reason };
      soon();
    },
    call(call) {
      over();
      doc.calls.push(call);
      soon();
    },
    result(id, output) {
      const call = doc.calls.find((c) => c.id === id);
      if (call) call.output = output;
      soon();
    },
    async settle() {
      clearTimeout(timer);
      timer = undefined;
      dirty = false;
      await writing;
    },
    done(tx) {
      doc = fresh();
      return tx.db.collection("live").deleteOne({ _id: run }, NO_ANSWER);
    },
  };
}
