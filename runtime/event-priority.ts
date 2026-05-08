import type { MessagePayload } from "@/types/index.ts";

export const EVENT_PRIORITIES = {
  /** Commit already-produced work before yielding the thread. */
  SETTLEMENT: 3000,
  /** Human input should take the next conversational turn before agents continue. */
  USER_INPUT: 2000,
  /** Let an agent produce the next generated turn. */
  AGENT_CONTINUATION: 1000,
  /** Default queue priority for neutral work. */
  NORMAL: 0,
  /** Background work that should not block the interactive path. */
  BACKGROUND: -100,
} as const;

export function priorityForInboundMessage(
  message: Pick<MessagePayload, "sender">,
): number {
  const senderType = message.sender?.type;
  if (senderType === "user") return EVENT_PRIORITIES.USER_INPUT;
  if (senderType === "tool") return EVENT_PRIORITIES.SETTLEMENT;
  if (senderType === "agent") return EVENT_PRIORITIES.AGENT_CONTINUATION;
  return EVENT_PRIORITIES.NORMAL;
}

export function priorityForAgentLlmCall(
  sourceMessage: Pick<MessagePayload, "sender">,
): number {
  return sourceMessage.sender?.type === "user"
    ? EVENT_PRIORITIES.USER_INPUT
    : EVENT_PRIORITIES.AGENT_CONTINUATION;
}
