/** Fenced, bounded control-history access. These helpers expose evidence only;
 * the recovery command must separately prove the business recovery decision. */
import { quoteEventIdentifier } from "../events/schema.ts";
import type { OwnerCommitContext } from "./boundary.ts";
import {
  OWNER_ASSIGNMENT_BINDING_MAX_BYTES,
  type OwnerStoredAssignment,
  parseOwnerStoredAssignment,
} from "./assignments.ts";
export type { OwnerStoredAssignment } from "./assignments.ts";

function text(value: unknown): asserts value is string {
  if (
    typeof value !== "string" || !value || value !== value.trim() ||
    value.length > 1024
  ) {
    throw new TypeError("Invalid assignment storage coordinate.");
  }
}
function lost(): never {
  throw Object.assign(
    new Error("Owner assignment storage authority was lost."),
    {
      name: "ActionOwnershipLost",
      code: "ActionOwnershipLost",
    },
  );
}
export function createOwnerAssignmentStorage(
  options: Readonly<{ ownerId: string; schema: string }>,
) {
  const ownerId = options.ownerId;
  text(ownerId);
  const schema = quoteEventIdentifier(options.schema);
  const assignments = `${schema}."owner_assignments"`;
  const epochs = `${schema}."owner_epochs"`;
  function authority(input: OwnerCommitContext): OwnerCommitContext {
    const value = { ...input };
    if (!value.transaction || typeof value.transaction.query !== "function") {
      throw new TypeError(
        "Assignment storage requires a command-local transaction.",
      );
    }
    text(value.ownerId);
    text(value.holderId);
    if (
      value.ownerId !== ownerId || !Number.isSafeInteger(value.epoch) ||
      value.epoch < 1
    ) lost();
    if (
      typeof value.commandTime !== "string" ||
      !Number.isFinite(Date.parse(value.commandTime))
    ) {
      throw new TypeError("Invalid assignment storage command time.");
    }
    return {
      ...value,
      transaction: { query: value.transaction.query.bind(value.transaction) },
    };
  }
  async function fence(value: OwnerCommitContext): Promise<void> {
    const result = await value.transaction.query(
      `SELECT owner FROM ${epochs} WHERE owner=$1 AND epoch=$2 AND holder=$3 FOR UPDATE`,
      [ownerId, value.epoch, value.holderId],
    );
    if (result.rows.length !== 1) lost();
  }
  async function listDelivery(
    ownerCommit: OwnerCommitContext,
    input: Readonly<{
      namespace: string;
      deliveryId: string;
      maxAssignments?: number;
    }>,
  ): Promise<readonly OwnerStoredAssignment[]> {
    // Snapshot every caller-owned coordinate before the first await.
    const context = authority(ownerCommit);
    const namespace = input.namespace;
    const deliveryId = input.deliveryId;
    const maximum = input.maxAssignments ?? 100;
    text(namespace);
    text(deliveryId);
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1000) {
      throw new TypeError("Assignment history limit is invalid.");
    }
    await fence(context);
    // No namespace predicate or retired/epoch filter may hide corrupt or
    // conflicting evidence. The validated unfiltered index bounds this lookup;
    // no sort over the entire history is required before the cap+1 stop.
    const result = await context.transaction.query(
      `SELECT owner,epoch,assignment_key,delivery_id,
         CASE WHEN octet_length(binding::text)<=${OWNER_ASSIGNMENT_BINDING_MAX_BYTES} THEN binding ELSE '{}'::jsonb END AS binding,retired
       FROM ${assignments} WHERE owner=$1 AND delivery_id=$2 LIMIT $3 FOR UPDATE`,
      [ownerId, deliveryId, maximum + 1],
    );
    if (result.rows.length > maximum) {
      throw new RangeError(
        "Assignment history is incomplete: bounded inventory exceeded.",
      );
    }
    return result.rows.map((raw) => {
      const row = parseOwnerStoredAssignment(raw);
      if (
        row.owner !== ownerId || row.binding.deliveryId !== deliveryId ||
        row.binding.namespace !== namespace
      ) {
        throw new TypeError(
          "Assignment history does not match delivery namespace or owner.",
        );
      }
      return row;
    });
  }
  async function retirePrior(
    ownerCommit: OwnerCommitContext,
    input: OwnerStoredAssignment,
  ): Promise<boolean> {
    const context = authority(ownerCommit);
    const row = parseOwnerStoredAssignment({
      owner: input.owner,
      epoch: input.epoch,
      assignment_key: input.key,
      delivery_id: input.binding.deliveryId,
      binding: input.binding,
      retired: input.retired,
    });
    if (row.owner !== ownerId) {
      throw new TypeError("Prior assignment owner does not match.");
    }
    await fence(context);
    if (row.epoch >= context.epoch || row.retired) return false;
    const result = await context.transaction.query(
      `UPDATE ${assignments} SET retired=TRUE,retired_at=$1::timestamptz
       WHERE owner=$2 AND assignment_key=$3 AND epoch=$4 AND epoch<$5
         AND delivery_id=$6 AND binding=$7::jsonb AND retired=FALSE RETURNING assignment_key`,
      [
        context.commandTime,
        ownerId,
        row.key,
        row.epoch,
        context.epoch,
        row.binding.deliveryId,
        JSON.stringify(row.binding),
      ],
    );
    return result.rows.length === 1;
  }
  return { listDelivery, retirePrior };
}
