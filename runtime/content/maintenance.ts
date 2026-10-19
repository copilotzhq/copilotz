import type { BodyStore, WriterCapability } from "./body-store.ts";
import type { ContentCatalog, ContentCopy, LogicalBody } from "./catalog.ts";
import { digestCatalogPrefix } from "./prefix-digest.ts";
export type ProgressiveBodyMaintenanceError = Readonly<
  { bodyId: string; message: string }
>;
export type ProgressiveBodyMaintenanceResult = Readonly<
  {
    examined: number;
    aborted: number;
    sealed: number;
    terminated: number;
    deferred: number;
    errors: readonly ProgressiveBodyMaintenanceError[];
    after?: string;
  }
>;
export const EMPTY_PROGRESSIVE_BODY_MAINTENANCE:
  ProgressiveBodyMaintenanceResult = {
    examined: 0,
    aborted: 0,
    sealed: 0,
    terminated: 0,
    deferred: 0,
    errors: [],
  };
/** Recovery authority comes exclusively from a catalog revocation claim. */
export async function recoverLogicalBody(
  catalog: ContentCatalog,
  body: LogicalBody,
  store: BodyStore,
): Promise<"sealed" | "terminated" | "deferred"> {
  if (body.terminal) return "deferred";
  let head = await store.head({ bodyId: body.copy.key });
  if (
    body.sealIntent && head?.state === "ready" &&
    head.byteLength === body.sealIntent.length &&
    head.digest === body.sealIntent.digest
  ) {
    await catalog.sealAccepted({ ...body, head });
    return "sealed";
  }
  const claimed = await catalog.beginRevocation({ ...body, expiredOnly: true });
  if (claimed.terminal || claimed.revocation === "active") return "deferred";
  const original: WriterCapability = {
    bodyId: body.copy.key,
    mediaType: head?.mediaType ?? "application/octet-stream",
    reservationId: body.writerId,
    generation: body.generation,
    byteLength: head?.byteLength ?? 0,
    discarded: 0,
  };
  const writer = await store.fence({ writer: original });
  const length = await catalog.revoked(body);
  head = await store.head({ bodyId: body.copy.key });
  // A seal that won the physical fence is accepted only against the prior intent.
  if (
    body.sealIntent && head?.state === "ready" &&
    head.byteLength === body.sealIntent.length &&
    head.digest === body.sealIntent.digest
  ) {
    await catalog.sealAccepted({ ...body, head });
    return "sealed";
  }
  if (
    body.sealIntent && head && head.byteLength >= body.sealIntent.length &&
    (head.state === "open" || head.state === "sealing" ||
      head.state === "terminating")
  ) {
    const digest = await digestCatalogPrefix(
      store,
      body.copy.key,
      body.sealIntent.length,
    );
    if (digest === body.sealIntent.digest) {
      const sealed = await store.seal({
        writer,
        expectedByteLength: body.sealIntent.length,
        expectedDigest: digest,
      });
      await catalog.sealAccepted({ ...body, head: sealed });
      return "sealed";
    }
  }
  const digest = await digestCatalogPrefix(store, body.copy.key, length);
  if (
    head?.state === "open" || head?.state === "sealing" ||
    head?.state === "terminating"
  ) {
    await store.terminate({
      writer,
      expectedByteLength: length,
      expectedDigest: digest,
    });
  }
  await catalog.recordFailure({ ...body, digest, reason: "abandoned" });
  return "terminated";
}
export async function maintainProgressiveBodies(
  catalog: ContentCatalog,
  storeFor: (copy: ContentCopy) => BodyStore,
  input: Readonly<{ limit?: number; after?: string }> = {},
): Promise<ProgressiveBodyMaintenanceResult> {
  const page = await catalog.recoveryCandidates(input);
  let sealed = 0, terminated = 0, deferred = 0;
  const errors: ProgressiveBodyMaintenanceError[] = [];
  for (const body of page) {
    try {
      const result = await recoverLogicalBody(
        catalog,
        body,
        storeFor(body.copy),
      );
      if (result === "sealed") sealed++;
      else if (result === "terminated") terminated++;
      else deferred++;
    } catch (error) {
      await catalog.deferRecovery(body.bodyId);
      errors.push({
        bodyId: body.bodyId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    examined: page.length,
    aborted: 0,
    sealed,
    terminated,
    deferred,
    errors,
    ...(page.length === (input.limit ?? 100)
      ? { after: page.at(-1)!.bodyId }
      : {}),
  };
}
