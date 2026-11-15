/**
 * What front ends do before a conversation's composer sends: the
 * `conversation` resource's `beforeSend` hooks, in their entries' order,
 * each after the one before. The first to hold the message (`false`) or
 * throw stops the rest, and nothing goes. Whether it goes.
 */
import type { ViewContext } from "../../../../../runtime/mod.ts";
import type { ConversationView, Sending } from "../../shared/types.ts";

export async function beforeSend(
  entries: ConversationView[],
  sending: Sending,
  call: ViewContext["call"],
): Promise<boolean> {
  for (const entry of entries) {
    if (entry.beforeSend && (await entry.beforeSend(sending, call)) === false) return false;
  }
  return true;
}
