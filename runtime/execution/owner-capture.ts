/** Portable authored-content normalization. Bodies cross the owner boundary only
 * through bounded writes to an owner-held capture writer; no storage descriptor
 * or persistence implementation is available here. */
import { captureContentInput } from "../content/input.ts";
import { createContentPreparer } from "../content/preparer.ts";
import { digestContent } from "../content/digest.ts";
import { capturePendingContentRef } from "../content/schema.ts";
import type {
  AssetOrigin,
  ContentInput,
  ContentRef,
  PreparedContent,
} from "../content/types.ts";
import { deriveWorkflowId } from "../events/workflow-id.ts";

export const CAPTURE_CHUNK_BYTES = 64 * 1024;
type Data = Readonly<Record<string, unknown>>;
export type CaptureWriter = Readonly<{
  append(input: { bytes: Uint8Array; appendId: string }): Promise<unknown>;
  close(input: Data): Promise<unknown>;
  abort(input: { reason: string }): Promise<unknown>;
}>;
export type CapturePort = Readonly<{
  namespace: string;
  signal: AbortSignal;
  open(input: Data): Promise<CaptureWriter>;
  reference(input: ContentRef, options: Data): Promise<readonly unknown[]>;
}>;

/** Capture is tracked as one worker capability operation, including preparation
 * and all writes. Detachment happens synchronously, before the first await. */
export async function captureWorkerContent(
  input: unknown,
  options: unknown,
  port: CapturePort,
): Promise<readonly unknown[]> {
  const captured = captureContentInput({ input, options });
  const settings = captured.options as {
    operationKey: string;
    origin?: AssetOrigin;
  };
  if (
    !settings || typeof settings !== "object" || Array.isArray(settings) ||
    typeof settings.operationKey !== "string" ||
    !settings.operationKey.trim() ||
    Object.keys(settings).some((key) =>
      key !== "operationKey" && key !== "origin"
    )
  ) {
    throw new TypeError(
      "Content capture requires an operation key and optional origin.",
    );
  }
  port.signal.throwIfAborted();
  let nextId = 0;
  const suppliedPrepared = captured.input &&
    typeof captured.input === "object" &&
    !Array.isArray(captured.input) && "content" in captured.input &&
    "assets" in captured.input;
  const prepared = suppliedPrepared
    ? captured.input as PreparedContent
    : await createContentPreparer({
      createId: () => `capture-input:${nextId++}`,
    }).prepare(
      captured.input as ContentInput | readonly ContentInput[],
      {
        namespace: port.namespace,
        idempotencyKey: settings.operationKey,
        origin: settings.origin,
      },
    );
  if (!Array.isArray(prepared.content) || !Array.isArray(prepared.assets)) {
    throw new TypeError("Prepared content requires content and assets arrays.");
  }
  const assets = new Map<string, PreparedContent["assets"][number]>();
  // Validate the entire plan before any physical writer is opened. Owner-only
  // ready-body candidates are never interpreted or forwarded by a worker.
  for (const asset of prepared.assets) {
    if (
      !asset || typeof asset !== "object" || typeof asset.id !== "string" ||
      !asset.id ||
      assets.has(asset.id) || asset.namespace !== port.namespace ||
      typeof asset.mediaType !== "string" || !asset.mediaType.trim() ||
      !(asset.body instanceof Uint8Array) ||
      asset.body.byteLength !== asset.byteLength ||
      ["readyBody", "location", "logicalBodyId", "pendingAdoption"].some((
        key,
      ) => key in asset)
    ) {
      throw new TypeError(
        "Worker capture requires byte-backed prepared assets in its namespace.",
      );
    }
    if (suppliedPrepared && await digestContent(asset.body) !== asset.digest) {
      throw new TypeError("Prepared capture digest does not match its bytes.");
    }
    assets.set(asset.id, asset);
  }
  for (const ref of prepared.content) {
    if (!ref || typeof ref !== "object" || typeof ref.assetId !== "string") {
      throw new TypeError("Prepared capture requires content references.");
    }
    const source = assets.get(ref.assetId);
    if (source && source.mediaType !== ref.mediaType) {
      throw new TypeError(
        "Prepared capture media type does not match its reference.",
      );
    }
  }
  const result: unknown[] = [];
  for (let index = 0; index < prepared.content.length; index++) {
    port.signal.throwIfAborted();
    const ref = prepared.content[index];
    const source = assets.get(ref.assetId);
    const operationKey = await deriveWorkflowId(
      "capture-item",
      settings.operationKey,
      String(index),
    );
    if (!source) {
      const refs = await port.reference(ref, { ...settings, operationKey });
      if (refs.length !== 1) {
        throw new TypeError("Invalid owner capture reference result.");
      }
      result.push(refs[0]);
      continue;
    }
    const { assetId: _assetId, mediaType, ...reference } = ref;
    const descriptor = {
      reference,
      asset: {
        ...(settings.origin ? { origin: settings.origin } : {}),
        metadata: source.metadata ?? {},
      },
    };
    const writer = await port.open({ ...reference, mediaType, operationKey });
    try {
      // Always use stable absolute chunk identities. An owner may safely replay
      // an acknowledged append; the worker never assumes a resumed byte offset.
      for (
        let offset = 0;
        offset < source.body.byteLength;
        offset += CAPTURE_CHUNK_BYTES
      ) {
        port.signal.throwIfAborted();
        await writer.append({
          bytes: source.body.slice(offset, offset + CAPTURE_CHUNK_BYTES),
          appendId: `chunk:${offset}`,
        });
      }
      port.signal.throwIfAborted();
      const pending = capturePendingContentRef(
        await writer.close({ assetId: operationKey, descriptor }),
      );
      if (
        pending.byteLength !== source.byteLength ||
        pending.digest !== source.digest ||
        pending.mediaType !== source.mediaType
      ) {
        throw new Error(
          "Captured content does not match its complete prepared body.",
        );
      }
      result.push(pending);
    } catch (error) {
      // Failure of cleanup is itself significant (the worker fatal latch sees
      // every underlying RPC); do not turn an uncertain upload into success.
      try {
        await writer.abort({ reason: "capture_failed" });
      } catch (cleanup) {
        throw new AggregateError(
          [error, cleanup],
          "Capture and cleanup failed.",
        );
      }
      throw error;
    }
  }
  port.signal.throwIfAborted();
  return result;
}
