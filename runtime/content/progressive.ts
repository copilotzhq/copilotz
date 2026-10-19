/** Convenience API over the single catalog-authoritative stream runtime. */
import { createContentStreamRuntime } from "../streams/stream.ts";
import type { ContentCatalog } from "./catalog.ts";
import type {
  AppendResult,
  BodyStore,
  IncompleteBodyHead,
  ReadyBodyHead,
} from "./body-store.ts";
export type ProgressiveBodyWriter = Readonly<
  {
    bodyId: string;
    offset(): number;
    append(
      input: { bytes: Uint8Array; appendId: string },
    ): Promise<AppendResult>;
    write(chunk: Uint8Array): Promise<void>;
    finalize(): Promise<ReadyBodyHead>;
    terminate(): Promise<IncompleteBodyHead>;
    fence(): void;
    abandon(): Promise<void>;
  }
>;
export type ProgressiveBodyFollower = Readonly<
  {
    bodyId: string;
    offset: number;
    mediaType: string;
    body: ReadableStream<Uint8Array>;
  }
>;
type Scope = Readonly<
  { bodyId: string; namespace: string; catalog: ContentCatalog }
>;
function runtime(store: BodyStore, input: Scope) {
  return createContentStreamRuntime({
    namespace: input.namespace,
    store,
    catalog: input.catalog,
    onOpen(_opened, publication) {
      publication.established();
    },
  });
}
function logicalId(input: Scope) {
  return `content-streams/${
    encodeURIComponent(input.namespace).replaceAll("%2F", "%252F")
  }/${encodeURIComponent(input.bodyId).replaceAll("%2F", "%252F")}`;
}
export async function createProgressiveBodyWriter(
  store: BodyStore,
  input: Scope & { mediaType: string },
): Promise<ProgressiveBodyWriter> {
  const writer = await runtime(store, input).open({
    id: input.bodyId,
    mediaType: input.mediaType,
    role: "content",
  });
  let fenced = false;
  const head = async () => {
    const logical = await input.catalog.read(logicalId(input));
    if (!logical) throw new Error("Progressive catalog body is missing.");
    return await store.head({ bodyId: logical.copy.key });
  };
  const append = async (value: { bytes: Uint8Array; appendId: string }) => {
    if (fenced) throw new Error("Progressive writer is settling.");
    const receipt = await writer.append(value);
    const current = await head();
    if (!current) throw new Error("Progressive copy is missing.");
    return { ...receipt, versionToken: current.versionToken };
  };
  return {
    bodyId: logicalId(input),
    offset: writer.offset,
    append,
    async write(source) {
      const bytes = new Uint8Array(source);
      for (let offset = 0; offset < bytes.length; offset += 1024 * 1024) {
        await append({
          bytes: bytes.slice(offset, offset + 1024 * 1024),
          appendId: crypto.randomUUID(),
        });
      }
    },
    async finalize() {
      await writer.close({ assetId: input.bodyId });
      const current = await head();
      if (current?.state !== "ready") {
        throw new Error(
          "Catalog seal did not produce Ready content.",
        );
      }
      return current;
    },
    async terminate() {
      await writer.abort({ reason: "abandoned" });
      const current = await head();
      if (current?.state !== "incomplete") {
        throw new Error(
          "Catalog revocation did not freeze the prefix.",
        );
      }
      return current;
    },
    fence() {
      fenced = true;
    },
    async abandon() {
      await writer.abort({ reason: "abandoned" });
    },
  };
}
export async function openProgressiveBodyFollower(
  store: BodyStore,
  input: Scope & { offset?: number },
): Promise<ProgressiveBodyFollower> {
  return await runtime(store, input).follow({
    id: input.bodyId,
    offset: input.offset,
  });
}
