import { orderedJson as ordered } from "../data-only-json.ts";
import { snapshotStreamMetadata } from "../streams/json.ts";

/** Pure digest of the scope and authority-bearing execution fields of one schedule. */
export async function scheduledJobDelegationDigest(
  input: Readonly<{
    databaseSchema: string;
    namespace: string;
    record: Readonly<Record<string, unknown>>;
  }>,
): Promise<`sha256:${string}`> {
  const captured = snapshotStreamMetadata(input, { maxBytes: 1024 * 1024 });
  const text = (value: unknown): string => {
    if (typeof value !== "string" || !value || value.trim() !== value) {
      throw new TypeError("Scheduled delegation scope is invalid.");
    }
    return value;
  };
  const object = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError("Scheduled delegation record is invalid.");
    }
    return value as Readonly<Record<string, unknown>>;
  };
  const namespace = text(captured.namespace);
  const record = object(captured.record);
  if (
    (record.namespace !== undefined && record.namespace !== namespace) ||
    !["active", "paused", "cancelled"].includes(String(record.status)) ||
    (record.content !== undefined && !Array.isArray(record.content))
  ) {
    throw new TypeError("Scheduled delegation record is invalid.");
  }
  const value = {
    schema: "copilotz.scheduled-job.delegation.v1",
    databaseSchema: text(captured.databaseSchema),
    namespace,
    record: {
      id: text(record.id),
      spaceId: record.spaceId === undefined ? null : text(record.spaceId),
      status: record.status,
      schedule: object(record.schedule),
      payload: object(record.payload),
      content: record.content ?? null,
      metadata: object(record.metadata),
    },
  };
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(ordered(value))),
    ),
  );
  return `sha256:${
    Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")
  }`;
}
