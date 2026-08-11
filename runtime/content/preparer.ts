import { digestContent } from "./digest.ts";
import { createContentError } from "./errors.ts";
import {
  cloneContentRef,
  materializeContentInput,
  withoutUndefined,
} from "./input.ts";
import type {
  ContentInput,
  ContentRef,
  NormalizeContentOptions,
  PreparedAsset,
  PreparedContent,
} from "./types.ts";

export type ContentPreparer = Readonly<{
  prepare(
    input: ContentInput | readonly ContentInput[],
    options: NormalizeContentOptions,
  ): Promise<PreparedContent>;
}>;

export type CreateContentPreparerOptions = Readonly<{
  createId?: () => string;
  digest?: (bytes: Uint8Array) => Promise<`sha256:${string}`>;
}>;

function defaultCreateId(): string {
  if (!globalThis.crypto?.randomUUID) {
    throw createContentError(
      "content_invalid",
      "A Web Crypto randomUUID implementation is required to prepare content.",
    );
  }
  return globalThis.crypto.randomUUID();
}

/** Prepares refs and immutable bodies without making either visible. */
export function createContentPreparer(
  options: CreateContentPreparerOptions = {},
): ContentPreparer {
  const createId = options.createId ?? defaultCreateId;
  const digest = options.digest ?? digestContent;

  return Object.freeze({
    async prepare(input, normalizeOptions) {
      const namespace = normalizeOptions.namespace.trim();
      const assets: PreparedAsset[] = [];
      const content = await materializeContentInput(
        input,
        normalizeOptions,
        {
          async materialize(candidate) {
            const body = candidate.body.slice();
            const id = createId();
            assets.push(Object.freeze(withoutUndefined({
              id,
              namespace,
              mediaType: candidate.mediaType,
              body,
              byteLength: body.byteLength,
              digest: await digest(body),
              idempotencyKey: candidate.idempotencyKey,
            })) as PreparedAsset);
            return withoutUndefined({
              assetId: id,
              kind: candidate.kind,
              role: candidate.role,
              mediaType: candidate.mediaType,
              ...candidate.fields,
            }) as ContentRef;
          },
          reference(ref) {
            return Promise.resolve(cloneContentRef(ref));
          },
        },
      );
      return Object.freeze({
        content: Object.freeze(content.map(cloneContentRef)),
        assets: Object.freeze(assets),
      });
    },
  });
}
