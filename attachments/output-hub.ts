import type { CopilotzEvent } from "@/events/types.ts";
import {
  AsyncBroadcast,
  type StreamSubscription,
} from "@/runtime/async-queue.ts";
import type { AttachmentOutput, AttachmentStreamOutput } from "./types.ts";
import type { EventBus } from "@/execution/event-bus.ts";

export class OutputHub {
  readonly #broadcast = new AsyncBroadcast<AttachmentOutput>();
  readonly #stopObserving: () => void;

  constructor(events: EventBus) {
    this.#stopObserving = events.observe((event) =>
      this.#broadcast.publish(event)
    );
  }

  subscribe(
    filter?: (output: AttachmentOutput) => boolean,
  ): StreamSubscription<AttachmentOutput> {
    return this.#broadcast.subscribe(filter);
  }

  publishStream(output: AttachmentStreamOutput): void {
    this.#broadcast.publish(output);
  }

  close(): void {
    this.#stopObserving();
    this.#broadcast.close();
  }
}

export function isEventOutput(
  output: AttachmentOutput,
): output is CopilotzEvent {
  return !("kind" in output && output.kind === "stream");
}
