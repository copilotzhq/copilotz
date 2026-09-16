/** Collects and renders typed Context contributions for Core prompts. @module */

import type { ProcessorContext } from "@copilotz/copilotz/plugins";

import type { ContextContribution, ContextPurpose } from "./types.ts";
import { isContextResource } from "../authoring/define-context/index.ts";
import type { AgentResource } from "../authoring/define-agent/index.ts";
import type {
  ConversationMessage,
  ConversationThread,
  Participant,
} from "./contracts.ts";

function requiredText(value: unknown, label: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new TypeError(`${label} must be non-empty.`);
  return normalized;
}

export type CollectedContextContribution =
  & ContextContribution
  & Readonly<{
    resourceId: string;
    /** Reserved for the built-in long-term-memory context resource. */
    historyAfterMessageId?: string;
  }>;

export async function collectContextContributions(
  context: ProcessorContext,
  input: Readonly<{
    purpose: ContextPurpose;
    agent: AgentResource;
    participant: Participant;
    thread: ConversationThread;
    historyScopeId?: string;
    sourceRange?: Readonly<{
      startMessageId: string;
      endMessageId: string;
      messages: readonly ConversationMessage[];
    }>;
  }>,
): Promise<readonly CollectedContextContribution[]> {
  const collected: CollectedContextContribution[] = [];
  const ids = new Set<string>();
  for (
    const resource of Object.values(context.resources.promptContext ?? {})
      .filter(
        isContextResource,
      )
  ) {
    if (!resource.purposes.includes(input.purpose)) continue;
    const value = await resource.contribute({
      ...input,
      context,
      collections: context.collections,
      signal: context.signal,
      idempotencyKey:
        `${context.operationKey}:context:${resource.id}:${input.purpose}`,
    });
    const contributions = value === null
      ? []
      : Array.isArray(value)
      ? value
      : [value];
    for (const contribution of contributions) {
      const id = `${resource.id}:${
        requiredText(contribution.id, "Context contribution id")
      }`;
      if (ids.has(id)) {
        throw new TypeError(`Duplicate context contribution '${id}'.`);
      }
      ids.add(id);
      if (contribution.role !== "context" && contribution.role !== "evidence") {
        throw new TypeError(
          `Context contribution '${id}' has an invalid role.`,
        );
      }
      if (contribution.role === "evidence" && !contribution.source) {
        throw new TypeError(`Evidence contribution '${id}' requires a source.`);
      }
      collected.push(
        {
          ...structuredClone(contribution),
          id: requiredText(contribution.id, "Context contribution id"),
          resourceId: resource.id,
          title: requiredText(contribution.title, "Context contribution title"),
          ...(typeof (contribution as Record<string, unknown>)
                  .historyAfterMessageId === "string" &&
              (contribution as Record<string, unknown>).historyAfterMessageId
            ? {
              historyAfterMessageId: String(
                (contribution as Record<string, unknown>).historyAfterMessageId,
              ),
            }
            : {}),
        } as const,
      );
    }
  }
  return collected;
}
