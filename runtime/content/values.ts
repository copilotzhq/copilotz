import { isContentRef } from "./schema.ts";
import type { ContentInput, ContentRef, ResolvedContent } from "./types.ts";

/** Content ready for consumption, with no deferred Asset references. */
export type ContentValue = Exclude<ContentInput, ContentRef>;

/** Resolve reference inputs in one authorized batch; literal values are not persisted. */
export async function resolveContentInputs(
  inputs: readonly ContentInput[],
  content: {
    resolveMany(
      refs: readonly ContentRef[],
    ): Promise<readonly ResolvedContent[]>;
  },
): Promise<readonly ContentValue[]> {
  const snapshot = structuredClone(inputs);
  for (const input of snapshot) {
    if (
      typeof input === "object" && input !== null && "assetId" in input &&
      !isContentRef(input)
    ) {
      throw new TypeError("Invalid content reference metadata.");
    }
  }
  const refs = snapshot.filter(isContentRef);
  const resolved = refs.length ? await content.resolveMany(refs) : [];
  if (resolved.length !== refs.length) {
    throw new Error("Content resolution returned an incomplete batch.");
  }
  let index = 0;
  return (snapshot.map((input): ContentValue => {
    if (!isContentRef(input)) return input;
    const item = resolved[index++];
    if (item.ref.assetId !== input.assetId) {
      throw new Error("Content resolution returned an unexpected reference.");
    }
    const { assetId: _assetId, kind, ...metadata } = input;
    if (kind === "text") {
      if (item.text === undefined) {
        throw new TypeError("Expected text content.");
      }
      return { ...metadata, type: "text", text: item.text };
    }
    if (kind === "json") {
      return { ...metadata, type: "json", value: structuredClone(item.value) };
    }
    return { ...metadata, type: kind, bytes: item.bytes.slice() };
  }));
}
