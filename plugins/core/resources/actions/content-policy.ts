import type {
  ContentInput,
  ContentRef,
  ContentSequence,
  DurableContentInput,
  PreparedContent,
} from "@copilotz/copilotz/content";
import type { ActionContext } from "@copilotz/copilotz/actions";

/** Shared content helpers for Core Actions. */

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isContentRef(value: unknown): value is ContentRef {
  const record = asRecord(value);
  return typeof record.assetId === "string" &&
    typeof record.kind === "string" &&
    typeof record.role === "string" &&
    typeof record.mediaType === "string";
}

export async function prepareActionContent(
  value: unknown,
  context: Pick<ActionContext, "content">,
  operationKey: string,
): Promise<DurableContentInput> {
  if (Array.isArray(value) && value.every(isContentRef)) {
    return Object.freeze(structuredClone(value)) as ContentSequence;
  }
  if (preparedContent(value)) {
    throw new TypeError(
      "PreparedContent cannot cross an Action boundary; pass canonical refs or source content.",
    );
  }
  return await context.content.prepare(
    value as ContentInput | readonly ContentInput[],
    { operationKey },
  );
}

function preparedContent(value: unknown): PreparedContent | undefined {
  return value && typeof value === "object" && !Array.isArray(value) &&
      Array.isArray((value as PreparedContent).content) &&
      Array.isArray((value as PreparedContent).assets)
    ? value as PreparedContent
    : undefined;
}

export function requiredText(value: unknown, name: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new TypeError(`${name} must be non-empty.`);
  return normalized;
}
