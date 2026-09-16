/** Collects and renders typed Context contributions for Core prompts. @module */

import type { ProcessorContext } from "@copilotz/copilotz/plugins";
import {
  type ContentValue,
  resolveContentInputs,
} from "@copilotz/copilotz/content";
import type { ContextContribution, ContextPurpose } from "./types.ts";
import { isContextResource } from "../index.ts";
import type { AgentResource } from "../../agent/index.ts";
import type {
  ConversationMessage,
  ConversationThread,
  Participant,
} from "../../../../core-collections/internal/contracts.ts";

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

/** Prepare a complete contribution batch before prompt rendering. */
export async function prepareContextContributions(
  context: ProcessorContext,
  contributions: readonly CollectedContextContribution[],
): Promise<
  readonly (Omit<CollectedContextContribution, "content"> & {
    content: ContentValue;
  })[]
> {
  context.signal.throwIfAborted();
  const values = await resolveContentInputs(
    contributions.map((entry) => entry.content),
    context.content,
  );
  context.signal.throwIfAborted();
  return (contributions.map((
    entry,
    index,
  ) => ({ ...entry, content: values[index] } as const)));
}

/** Pure prompt projection: all content is prepared before reaching the renderer. */
export function renderContextContent(content: ContentValue): string {
  if (typeof content === "string") return content;
  if (content.type === "text") return content.text;
  if (content.type === "json") return JSON.stringify(content.value, null, 2);
  return `[${content.type}:${
    content.name ?? content.mediaType
  }; ${content.bytes.byteLength} bytes]`;
}
