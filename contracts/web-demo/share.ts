/**
 * Shares the demo's records and live feed between tabs of the same browser,
 * as a server would, so a second tab follows a conversation live.
 * @module
 */
import type { FeedFrame } from "@copilotz/copilotz/core/web";
import type { FixtureLive } from "../../plugins/ui/tests/fixture-live.test.ts";
import type { DemoFeed } from "./host.ts";

type Message =
  | { kind: "put" | "patch" | "remove"; args: unknown[] }
  | { kind: "frame"; threadId: string; frame: FeedFrame };

type Channel = {
  postMessage(message: unknown): void;
  close(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
};

export function shareAcrossTabs(
  live: FixtureLive,
  feed: DemoFeed,
  name = "copilotz-demo",
): () => void {
  const Broadcast = (globalThis as {
    BroadcastChannel?: new (name: string) => Channel;
  }).BroadcastChannel;
  if (!Broadcast) return () => {};
  const channel = new Broadcast(name);
  let remote = false;
  const post = (message: Message) => {
    if (!remote) channel.postMessage(message);
  };
  const methods = live as unknown as Record<
    "put" | "patch" | "remove",
    (...args: unknown[]) => void
  >;
  for (const kind of ["put", "patch", "remove"] as const) {
    const local = methods[kind].bind(live);
    methods[kind] = (...args: unknown[]) => {
      local(...args);
      post({ kind, args });
    };
  }
  const emit = feed.emit.bind(feed);
  feed.emit = (threadId: string, frame: FeedFrame) => {
    emit(threadId, frame);
    post({ kind: "frame", threadId, frame });
  };
  channel.onmessage = ({ data }) => {
    const message = data as Message;
    remote = true;
    try {
      if (message.kind === "frame") feed.emit(message.threadId, message.frame);
      else methods[message.kind](...message.args);
    } finally {
      remote = false;
    }
  };
  return () => channel.close();
}
