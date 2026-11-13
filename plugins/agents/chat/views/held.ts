/**
 * What stands where a reply went that not everyone here could read (a
 * message's `held`), in the reader's words, wherever messages show (the web,
 * the terminal): to whose Personal space (by `name`, as it is when read), or
 * that it was held back; an answer handed back from another space, that it
 * went to its asker alone, or stayed where it was written. Never what it
 * said. Agents are told it in English (`heldTold`).
 */
import type { Message } from "../collections/message.ts";
import { DELEGATED } from "../shared/types.ts";
import { say } from "./web/words.ts";

export function heldSaid(m: Pick<Message, "held" | "via">, name?: string): string {
  const back = m.via?.kind === DELEGATED;
  if (m.held?.for) {
    const whom = { name: name ?? m.held.for };
    return back ? say("answerWentTo", whom) : say("heldMoved", whom);
  }
  return say(back ? "answerStayed" : "heldBack");
}
