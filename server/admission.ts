/** Applies the existing observation capacity before admitting more HTTP work. */
import type { InternalCopilotzApplication } from "../runtime/application/types.ts";
import type { FacadeContext } from "./context.ts";

export async function admitHttpOperation(
  application: InternalCopilotzApplication,
  context: FacadeContext,
  idempotencyKey: string,
): Promise<FacadeContext> {
  const admission = context.serverConstraints.admission;
  if (!admission || !idempotencyKey.trim()) return context;
  if (!admission.key?.trim()) {
    throw new TypeError("Admission requires a trusted group key.");
  }
  const runtime = context.databaseSchema &&
      context.databaseSchema !== application.config.databaseSchema
    ? await application.databaseScope(context.databaseSchema)
    : application;
  const namespace = context.namespace ?? application.config.namespace!;
  const group = {
    httpAdmissionKey: admission.key,
    ...(context.serverScope.actor
      ? { actorId: context.serverScope.actor.id }
      : {}),
  };
  const recovered = await runtime.operations.list({
    namespace,
    metadata: {
      operationMetadata: { ...group, httpIdempotencyKey: idempotencyKey },
    },
    limit: 1,
  });
  if (
    !recovered.length &&
    (await runtime.operations.list({
        namespace,
        metadata: { operationMetadata: group },
        states: ["accepted", "running"],
        limit: 32,
      })).length === 32
  ) {
    throw Object.assign(new Error("Conversation has 32 active operations."), {
      status: 409,
      code: "operation_replay_capacity_exceeded",
    });
  }
  return {
    ...context,
    operationMetadata: {
      ...context.operationMetadata,
      ...group,
      httpIdempotencyKey: idempotencyKey,
      ...(admission.threadId ? { threadId: admission.threadId } : {}),
    },
  };
}
