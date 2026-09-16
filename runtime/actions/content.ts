import { decodeContentBody } from "../content/decode.ts";
import type { ContentKind } from "../content/types.ts";
import type { ContentRef } from "../content/types.ts";
import { digestContent } from "../content/digest.ts";
import type { ContentBodyValue } from "../content/types.ts";
import type { RuntimeContent } from "./types.ts";
import { durableActionValue, sameActionValue } from "./value.ts";

/** Declared sequences use dotted fields and [] for array traversal. */
export type ActionContentDeclaration = Readonly<{
  input: readonly string[];
  /** Aggregate body budget per invocation, including cached values. */
  byteLimit?: number;
}>;

/** Explicit descriptors are never loaded; ordinary entries are prepared values. */
export type ActionContentEntry =
  | Readonly<
    Omit<ContentRef, "assetId"> & {
      assetId?: string;
      value: ContentBodyValue;
      resolve?: never;
    }
  >
  | Readonly<ContentRef & { resolve: false; value?: never }>;

export function actionContentDeclaration(
  value: unknown,
): ActionContentDeclaration {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Action content must be a declaration object.");
  }
  const config = value as Record<string, unknown>;
  if (
    Object.keys(config).some((key) => key !== "input" && key !== "byteLimit") ||
    !Array.isArray(config.input) || !config.input.length ||
    config.input.length > 32
  ) {
    throw new TypeError("Action content requires 1–32 input paths.");
  }
  const paths = config.input as unknown[];
  for (const path of paths) {
    if (
      typeof path !== "string" || path.length > 256 ||
      !/^[A-Za-z_][A-Za-z0-9_]*(\[\])?(\.[A-Za-z_][A-Za-z0-9_]*(\[\])?)*$/.test(
        path,
      ) ||
      path.split(".").some((part) =>
        ["__proto__", "prototype", "constructor"].includes(
          part.replace("[]", ""),
        )
      )
    ) {
      throw new TypeError("Invalid Action content path.");
    }
  }
  if (new Set(paths).size !== paths.length) {
    throw new TypeError("Duplicate Action content path.");
  }
  const byteLimit = config.byteLimit ?? 32 * 1024 * 1024;
  if (!Number.isSafeInteger(byteLimit) || Number(byteLimit) < 0) {
    throw new TypeError("Invalid Action content byte limit.");
  }
  return ({
    input: [...paths] as string[],
    byteLimit: Number(byteLimit),
  } as const);
}

/** Returns only declared sequences; arbitrary payload objects are never interpreted. */
export function actionContentSequences(
  input: unknown,
  declaration: ActionContentDeclaration,
): unknown[][] {
  const sequences: unknown[][] = [];
  const seen = new Set<unknown[]>();
  for (const path of declaration.input) {
    let nodes: unknown[] = [input];
    for (const segment of path.split(".")) {
      const many = segment.endsWith("[]");
      const key = many ? segment.slice(0, -2) : segment;
      nodes = nodes.flatMap((node) => {
        if (node === undefined || node === null) return [];
        if (typeof node !== "object" || Array.isArray(node)) {
          throw new TypeError(`Invalid content path '${path}'.`);
        }
        if (!Object.hasOwn(node, key)) return [];
        const value = (node as Record<string, unknown>)[key];
        if (value === undefined) return [];
        if (!many) return [value];
        if (!Array.isArray(value)) {
          throw new TypeError(`Expected array in '${path}'.`);
        }
        return value;
      });
    }
    for (const node of nodes) {
      if (!Array.isArray(node)) {
        throw new TypeError(`Content '${path}' must be a sequence.`);
      }
      if (seen.has(node)) {
        throw new TypeError("Overlapping Action content paths.");
      }
      seen.add(node);
      sequences.push(node);
    }
  }
  return sequences;
}

function encode(kind: string, value: unknown): Uint8Array {
  if (kind === "text" && typeof value === "string") {
    return new TextEncoder().encode(value);
  }
  if (kind === "json") {
    const canonical = durableActionValue(value);
    return new TextEncoder().encode(JSON.stringify(canonical));
  }
  if (!["text", "json"].includes(kind) && value instanceof Uint8Array) {
    return value.slice();
  }
  throw new TypeError(`Invalid prepared '${kind}' content value.`);
}

export async function prepareActionContentInput(
  input: unknown,
  declaration: ActionContentDeclaration,
  content: RuntimeContent,
  signal: AbortSignal,
): Promise<{ durableInput: unknown; hydrate(): Promise<unknown> }> {
  const snapshot = structuredClone(input);
  const entries = actionContentSequences(snapshot, declaration).flat();
  if (entries.length && !content.authorize) {
    throw new Error("Action content requires an authorization service.");
  }
  if (entries.length > 4096) {
    throw new RangeError("Action content entry limit exceeded.");
  }
  const cached = new Map<string, Uint8Array>();
  const hashes = new Map<string, string>();
  const refs: ContentRef[] = [];
  let bytesUsed = 0;
  const limit = declaration.byteLimit ?? 32 * 1024 * 1024;
  const account = (bytes: number) => {
    bytesUsed += bytes;
    if (bytesUsed > limit) {
      throw new RangeError("Action content byte limit exceeded.");
    }
  };
  const existingIds = [
    ...new Set(entries.flatMap((entry) => {
      if (
        !entry || typeof entry !== "object" || Array.isArray(entry)
      ) throw new TypeError("Invalid Action content entry.");
      const id = (entry as Record<string, unknown>).assetId;
      return typeof id === "string" ? [id] : [];
    })),
  ];
  signal.throwIfAborted();
  const assets = new Map(
    (await content.getMany(existingIds)).map((asset) => [asset.id, asset]),
  );
  for (const entry of entries as Record<string, unknown>[]) {
    signal.throwIfAborted();
    const { kind, mediaType, role } = entry;
    if (
      typeof kind !== "string" ||
      !["text", "json", "image", "audio", "video", "file"].includes(kind) ||
      typeof mediaType !== "string" || !mediaType.trim() ||
      typeof role !== "string"
    ) throw new TypeError("Invalid Action content metadata.");
    if (entry.resolve !== undefined && entry.resolve !== false) {
      throw new TypeError("Invalid content resolution policy.");
    }
    const hasValue = Object.hasOwn(entry, "value");
    if (entry.resolve === false && hasValue) {
      throw new TypeError("Reference-only content cannot include a value.");
    }
    let asset = typeof entry.assetId === "string"
      ? assets.get(entry.assetId)
      : undefined;
    if (entry.assetId !== undefined && !asset) {
      throw new Error("Action content Asset was not found in this scope.");
    }
    if (asset && (asset.state !== "ready" || asset.mediaType !== mediaType)) {
      throw new Error(
        "Action content Asset is not ready or has a different media type.",
      );
    }
    if (asset) {
      if (content.authorize) {
        await content.authorize(entry as unknown as ContentRef);
      } else {throw new Error(
          "Action content requires an authorization service.",
        );}
    }
    if (hasValue) {
      let bytes = encode(kind, entry.value);
      if (bytes.byteLength > limit) {
        throw new RangeError("Action content byte limit exceeded.");
      }
      const hash = await digestContent(bytes);
      if (
        asset &&
        (asset.digest !== hash || asset.byteLength !== bytes.byteLength)
      ) {
        // JSON reads preserve values, not the original whitespace/key serialization.
        if (kind !== "json") {
          throw new Error("Prepared content does not match its Asset.");
        }
        const original =
          (await content.resolveMany([entry as unknown as ContentRef]))[0];
        if (!original || !sameActionValue(original.value, entry.value)) {
          throw new Error("Prepared content does not match its Asset.");
        }
        bytes = original.bytes;
      }
      const key = `${mediaType}:${hash}`;
      if (!asset) {
        const duplicate = hashes.get(key);
        if (duplicate) asset = assets.get(duplicate);
        if (!asset) {
          account(bytes.byteLength);
          asset = await content.publish({ mediaType, body: bytes }, {
            operationKey: `action-content:${key}`,
          });
          assets.set(asset.id, asset);
          hashes.set(key, asset.id);
          cached.set(asset.id, bytes);
        }
      }
      if (!cached.has(asset.id)) {
        account(bytes.byteLength);
        cached.set(asset.id, bytes);
      }
      entry.assetId = asset.id;
      // Hash-based reuse must not turn knowledge of bytes into access authority.
      if (!existingIds.includes(asset.id)) {
        await content.authorize!(entry as unknown as ContentRef);
      }
      delete entry.value;
    } else if (!asset) {
      throw new TypeError("Content requires a value or an Asset reference.");
    }
    if (entry.resolve !== false) refs.push(entry as unknown as ContentRef);
  }
  signal.throwIfAborted();
  const durableInput = durableActionValue(snapshot);
  return {
    durableInput,
    async hydrate() {
      signal.throwIfAborted();
      const missing = [
        ...new Map(
          refs.filter((ref) => !cached.has(ref.assetId)).map(
            (ref) => [ref.assetId, ref],
          ),
        ).values(),
      ];
      for (const ref of missing) account(assets.get(ref.assetId)!.byteLength);
      const resolved = missing.length ? await content.resolveMany(missing) : [];
      for (const item of resolved) cached.set(item.ref.assetId, item.bytes);
      signal.throwIfAborted();
      const execution = structuredClone(durableInput);
      for (const sequence of actionContentSequences(execution, declaration)) {
        for (const entry of sequence as Record<string, unknown>[]) {
          if (entry.resolve === false) continue;
          const id = String(entry.assetId);
          if (!cached.has(id)) {
            throw new Error("Incomplete Action content hydration.");
          }
          const bytes = cached.get(id)!;
          entry.value = decodeContentBody(bytes, entry.kind as ContentKind, {
            assetId: id,
            namespace: assets.get(id)?.namespace,
          }).value;
        }
      }
      return execution;
    },
  };
}
