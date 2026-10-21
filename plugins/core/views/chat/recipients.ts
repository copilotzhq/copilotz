/**
 * Who a message addresses: the agents it @mentions, otherwise the app's
 * default (`resources.chat.defaultRecipients`). The composer always sends
 * explicit recipients for "first", so Core's own default (every agent in the
 * thread) applies only when the app chooses "all".
 * @module
 */
import type { BrowserViewContext } from "@copilotz/copilotz/web";
import type { ChatSender } from "../../shared/chat-messages.ts";
import type { MentionTarget } from "./composer.tsx";

/** `first`: the default agent only (the default); `all`: every thread agent. */
export type RecipientPolicy = "first" | "all";

/** An agent the app configures (`resources.chat.agents`), as Core takes it. */
export type ConfiguredAgent = Readonly<
  Record<string, unknown> & {
    externalId: string;
    agentId?: string;
    name?: string;
    description?: string;
    /** The agent a message without a mention addresses. */
    default?: boolean;
  }
>;

/** What `chatSend` sends: participant ids, and agents named by external id. */
export type Recipients = Readonly<{
  recipientIds: readonly string[];
  /** Agents addressed by external id; they join the thread if needed. */
  agents: readonly ConfiguredAgent[];
}>;

const AGENT = "agent:";

export function configuredAgents(ctx: BrowserViewContext): ConfiguredAgent[] {
  const agents = (ctx.resources.chat as Record<string, unknown> | undefined)
    ?.agents;
  return (Array.isArray(agents) ? agents : []).flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const agent = value as Record<string, unknown>;
    const externalId = typeof agent.externalId === "string"
      ? agent.externalId
      : typeof agent.agentId === "string"
      ? agent.agentId
      : "";
    return externalId
      ? [{ participantType: "agent", ...agent, externalId } as ConfiguredAgent]
      : [];
  });
}

export function recipientPolicy(ctx: BrowserViewContext): RecipientPolicy {
  const chat = ctx.resources.chat as Record<string, unknown> | undefined;
  return chat?.defaultRecipients === "all" ? "all" : "first";
}

/**
 * The agents a message may @mention: the thread's agents that could be read,
 * then the app's configured agents (by external id) not among them, so
 * mentions work even when people can't be read.
 */
export function mentionTargets(
  threadAgents: readonly ChatSender[],
  configured: readonly ConfiguredAgent[],
): MentionTarget[] {
  const known = new Set(
    threadAgents.flatMap((agent) => [agent.agentId, agent.externalId]),
  );
  return [
    ...threadAgents.map((sender) => ({
      id: sender.id,
      name: sender.name,
      sender,
    })),
    ...configured.filter((agent) =>
      !known.has(agent.agentId) && !known.has(agent.externalId)
    ).map((agent) => {
      const name = agent.name ?? agent.externalId;
      return {
        id: `${AGENT}${agent.externalId}`,
        name,
        ...(agent.description ? { description: agent.description } : {}),
        sender: {
          id: `${AGENT}${agent.externalId}`,
          type: "agent" as const,
          name,
          externalId: agent.externalId,
          ...(agent.agentId ? { agentId: agent.agentId } : {}),
        },
      };
    }),
  ];
}

/**
 * The recipients of a message: the mentioned targets; without a mention the
 * policy's default. `undefined` lets Core choose (every thread agent).
 */
export function resolveRecipients(
  input: {
    mentioned: readonly string[];
    threadAgents: readonly ChatSender[];
    configured: readonly ConfiguredAgent[];
    policy: RecipientPolicy;
  },
): Recipients | undefined {
  const byExternalId = new Map(
    input.configured.map((agent) => [agent.externalId, agent]),
  );
  if (input.mentioned.length) {
    const recipientIds: string[] = [], agents: ConfiguredAgent[] = [];
    for (const id of input.mentioned) {
      const agent = id.startsWith(AGENT)
        ? byExternalId.get(id.slice(AGENT.length))
        : undefined;
      if (agent) agents.push(agent);
      else if (!id.startsWith(AGENT)) recipientIds.push(id);
    }
    return { recipientIds, agents };
  }
  if (input.policy === "all") return undefined;
  const preferred = input.configured.find((agent) => agent.default);
  const inThread = preferred
    ? input.threadAgents.find((agent) =>
      agent.agentId === preferred.agentId ||
      agent.externalId === preferred.externalId
    )
    : undefined;
  if (inThread) return { recipientIds: [inThread.id], agents: [] };
  if (input.threadAgents.length) {
    return { recipientIds: [input.threadAgents[0].id], agents: [] };
  }
  const fallback = preferred ?? input.configured[0];
  return fallback ? { recipientIds: [], agents: [fallback] } : undefined;
}

/** `chatSend`'s recipient fields for resolved recipients. */
export function sendRecipients(
  recipients: Recipients | undefined,
): {
  recipientIds?: readonly string[];
  recipientAgents?: readonly ConfiguredAgent[];
} {
  return recipients
    ? {
      recipientIds: recipients.recipientIds,
      ...(recipients.agents.length
        ? { recipientAgents: recipients.agents }
        : {}),
    }
    : {};
}
