import type { ProcessorContext } from "@copilotz/copilotz/plugins";
import {
  type ContentValue,
  resolveContentInputs,
} from "@copilotz/copilotz/content";
import type { CollectedContextContribution } from "../../../shared/contributions.ts";

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
