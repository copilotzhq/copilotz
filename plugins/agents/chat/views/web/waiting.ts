/**
 * Which agents a message waits for: those it's to that are at work in its
 * chat on something else (a `live` turn not started by it), and that haven't
 * started on it (no live turn or step of its own: a turn a message starts is
 * `<message>:<agent>`) or answered it yet. The server queues it for them; it
 * goes to each once it's done.
 */
import type { Live } from "../../collections/live.ts";
import type { Message } from "../../collections/message.ts";

export function waitingOn(
  m: Pick<Message, "_id" | "thread" | "to">,
  live: Pick<Live, "thread" | "agent" | "turn">[],
  said: Pick<Message, "from" | "turn" | "replyTo">[],
): string[] {
  return m.to.filter((agent) => {
    const own = `${m._id}:${agent}`;
    const busy = live.some((l) => l.thread === m.thread && l.agent === agent && l.turn !== own);
    const started = live.some((l) => l.turn === own) ||
      said.some((x) => x.turn === own || (x.from === agent && x.replyTo === m._id));
    return busy && !started;
  });
}
