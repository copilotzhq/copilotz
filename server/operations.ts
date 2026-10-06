import {
  listThreadOperations,
  threadEventWatermark,
} from "@copilotz/copilotz/core/server";
/** One bounded observation coordinator for operation selections and conversations. */
import { coreThreadObservationKey } from "@copilotz/copilotz/core";
import { watchSelection } from "./selection-watch.ts";
import { watchHttpRead } from "./reads.ts";
import type {
  ApplicationOperationAttachment,
  ApplicationOutput,
  InternalCopilotzApplication,
} from "../runtime/application/types.ts";
import {
  createOperationReplayCursorTracker,
  decodeOperationReplayCursor,
  encodeOperationReplayCursor,
} from "../runtime/streams/cursor.ts";
import type { HttpReadServices } from "../plugins/server/authoring/http-adapter/index.ts";
import type {
  ServerAuthorizedScope,
  ServerConstraints,
} from "../plugins/server/shared/contracts.ts";
import { HTTP_OBSERVATION, type HttpObservation } from "./http-types.ts";

function failure(code: string, status: number, message: string) {
  return Object.assign(new Error(message), { code, status });
}

export async function createHttpOperations(
  application: InternalCopilotzApplication,
  scope: ServerAuthorizedScope,
  constraints: ServerConstraints,
  read: HttpReadServices,
) {
  const namespace = scope.namespace ?? application.config.namespace!;
  const databaseSchema = scope.databaseSchema ??
    application.config.databaseSchema;
  const runtime = databaseSchema === application.config.databaseSchema
    ? application
    : await application.databaseScope(databaseSchema);
  const authorizedOperationMetadata = (candidate: unknown): boolean => {
    const metadata = candidate && typeof candidate === "object" &&
        !Array.isArray(candidate)
      ? candidate as Record<string, unknown>
      : {};
    return Object.entries(constraints.operations?.metadata ?? {}).every((
      [key, value],
    ) => JSON.stringify(metadata[key]) === JSON.stringify(value));
  };
  const get = async (operationId: string) => {
    const status = await application.operationStatus({
      operationId,
      namespace,
      databaseSchema,
    });
    if (!status || !authorizedOperationMetadata(status.metadata)) {
      throw failure("operation_not_found", 404, "Operation was not found.");
    }
    return status;
  };
  const thread = async (id: string) => {
    if (!await read.get("thread", id)) {
      throw failure("thread_not_found", 404, "Thread was not found.");
    }
  };
  const discover = async (
    threadId: string,
    afterPosition?: string,
    operationIds?: readonly string[],
  ) => {
    await thread(threadId);
    const operations = await listThreadOperations(runtime.operations, {
      namespace,
      threadId,
      operationIds,
      afterPosition,
      ...(afterPosition ? {} : { states: ["accepted", "running"] as const }),
      limit: 33,
    });
    if (operations.length > 32) {
      throw failure(
        "operation_replay_capacity_exceeded",
        409,
        "Observation exceeds 32 operations.",
      );
    }
    for (const operation of operations) {
      if (!authorizedOperationMetadata(operation.metadata.operationMetadata)) {
        throw failure("operation_not_found", 404, "Operation was not found.");
      }
    }
    return operations.map((operation) => operation.operationId);
  };
  return ({
    get,
    async checkpoint(
      threadId: string,
      coverage?: { checkpoint: string; actionRunIds: readonly string[] },
    ) {
      await thread(threadId);
      if (coverage) {
        const position = decodeOperationReplayCursor(coverage.checkpoint);
        let tracker = createOperationReplayCursorTracker(position);
        const covered = new Set(coverage.actionRunIds);
        for (
          const operationId of await discover(
            threadId,
            position.selectionPosition,
          )
        ) {
          let afterStreamOrdinal: string | undefined;
          while (true) {
            const page = await runtime.operations.listStreams({
              namespace,
              operationId,
              afterStreamOrdinal,
              limit: 1000,
            });
            for (const stream of page) {
              if (
                stream.state === "terminal" &&
                covered.has(
                  String(stream.descriptor.metadata.sourceActionRunId),
                )
              ) {
                const candidate = createOperationReplayCursorTracker(
                  decodeOperationReplayCursor(tracker.cursor()),
                );
                try {
                  candidate.commit([{
                    kind: "operation-stream",
                    action: "end",
                    operationId,
                    streamOrdinal: stream.streamOrdinal,
                    offset: stream.committedOffset,
                  }]);
                  // commit() validates ordinal jumps, while cursor() validates
                  // aggregate sparse-lane and encoded-byte capacity. Treat
                  // either capacity failure as optional coverage and keep the
                  // previous valid tracker intact.
                  candidate.cursor();
                  tracker = candidate;
                } catch (error) {
                  // Sparse coverage is optional: replay the omitted prefix instead
                  // of exceeding the cursor's existing concurrent-lane bound.
                  if (
                    (error as { code?: string }).code !==
                      "operation_replay_capacity_exceeded"
                  ) throw error;
                }
              }
            }
            if (page.length < 1000) break;
            afterStreamOrdinal = page.at(-1)!.streamOrdinal;
          }
        }
        return tracker.cursor();
      }
      const position =
        await threadEventWatermark(runtime.operations, namespace, threadId) ??
          "0";
      return encodeOperationReplayCursor({ selectionPosition: position });
    },
    async observe(
      selection: {
        operationIds?: readonly string[];
        threadId?: string;
        checkpoint?: string;
        signal?: AbortSignal;
      },
    ): Promise<HttpObservation> {
      const abort = new AbortController();
      const attachments = new Map<string, ApplicationOperationAttachment>();
      const draining = new Set<ApplicationOperationAttachment>();
      const attaching = new Set<string>();
      const terminal = new Map<string, ApplicationOutput>();
      const pumps = new Set<Promise<void>>();
      let stopAccess: (() => void) | undefined;
      let feed: Awaited<ReturnType<typeof watchSelection>> | undefined;
      let wake: (() => void) | undefined;
      let changed = true;
      const notify = () => {
        changed = true;
        wake?.();
      };
      const transport = new TransformStream<
        ApplicationOutput,
        ApplicationOutput
      >(
        undefined,
        { highWaterMark: 1 },
        { highWaterMark: 1 },
      );
      const writer = transport.writable.getWriter();
      let detached = false;
      let renewalFailure: unknown;
      let renewalDraining = false;
      const detach = async (
        reason: unknown = "observation_detached",
        drain = false,
      ) => {
        stopAccess?.();
        feed?.close();
        if (detached) {
          if (!drain && renewalDraining) {
            renewalDraining = false;
            await Promise.allSettled(
              [...new Set([...attachments.values(), ...draining])].map((item) =>
                item.detach("observation_detached")
              ),
            );
            await writer.abort(reason).catch(() => undefined);
          }
          return;
        }
        detached = true;
        if (drain) {
          renewalFailure = reason;
          renewalDraining = true;
        }
        abort.abort(reason);
        notify();
        stopAccess?.();
        feed?.close();
        selection.signal?.removeEventListener("abort", cancelled);
        await Promise.allSettled(
          [...new Set([...attachments.values(), ...draining])].map((item) =>
            item.detach(
              drain ? "observation_renewal_draining" : "observation_detached",
            )
          ),
        );
        if (drain) await writer.close().catch(() => undefined);
        else await writer.abort(reason).catch(() => undefined);
      };
      const cancelled = () => {
        void detach(selection.signal?.reason);
      };
      selection.signal?.addEventListener("abort", cancelled, { once: true });
      void writer.closed.catch((error) => detach(error));
      let checkpoint: string | undefined;
      let position: ReturnType<typeof decodeOperationReplayCursor>;
      let ids: string[] = [];
      let selectionPosition = "0";
      const retired = new Map<string, string>();
      let bootstrap:
        | { streamId: string; offset: number; terminal: boolean }[]
        | undefined;
      try {
        if (selection.signal?.aborted) throw selection.signal.reason;
        if (selection.threadId) {
          await thread(selection.threadId);
          feed = await watchSelection(
            runtime.operations,
            namespace,
            coreThreadObservationKey(selection.threadId),
            notify,
          );
          stopAccess = watchHttpRead(
            read,
            "thread",
            selection.threadId,
            (error) => {
              void detach(error);
            },
          );
        }
        checkpoint = selection.checkpoint ??
          (selection.threadId
            ? encodeOperationReplayCursor({
              selectionPosition: await threadEventWatermark(
                runtime.operations,
                namespace,
                selection.threadId,
              ) ?? "0",
            })
            : undefined);
        position = decodeOperationReplayCursor(checkpoint);
        selectionPosition = position.selectionPosition ?? "0";
        for (
          const [id, ordinal] of Object.entries(
            position.operationRetirementPositions ?? {},
          )
        ) {
          retired.set(id, ordinal);
        }
        const cursorIds = new Set([
          ...Object.keys(position.operationSelectionPositions ?? {}),
          ...Object.keys(position.operationEventPositions ?? {}),
          ...Object.keys(position.operationStreamPositions ?? {}),
        ]);
        const authorizedIds = new Set([...cursorIds, ...retired.keys()]);
        ids = selection.threadId
          ? [...cursorIds]
          : [...selection.operationIds ?? []];
        if (
          (!selection.threadId && !ids.length) || ids.length > 32 ||
          new Set(ids).size !== ids.length || ids.some((id) =>
            typeof id !== "string" || !id
          )
        ) {
          throw failure(
            "invalid_operation_selection",
            400,
            "Select 1 to 32 distinct operations.",
          );
        }
        if (selection.threadId) {
          const members = authorizedIds.size
            ? await listThreadOperations(runtime.operations, {
              namespace,
              threadId: selection.threadId,
              operationIds: [...authorizedIds],
              limit: 64,
            })
            : [];
          const found = new Map(
            members.map((item) => [item.operationId, item]),
          );
          for (const id of authorizedIds) {
            const operation = found.get(id);
            if (
              !operation ||
              !authorizedOperationMetadata(operation.metadata.operationMetadata)
            ) {
              throw failure(
                "invalid_replay_cursor",
                403,
                "Checkpoint is outside the authorized selection.",
              );
            }
          }
          // The history boundary covers terminal work. Operations still running
          // at that boundary must be followed even if they began earlier.
          const active = await listThreadOperations(runtime.operations, {
            namespace,
            threadId: selection.threadId,
            states: ["accepted", "running"],
            limit: 33,
          });
          for (const operation of active) {
            if (
              !authorizedOperationMetadata(operation.metadata.operationMetadata)
            ) {
              throw failure(
                "operation_not_found",
                404,
                "Operation was not found.",
              );
            }
            if (!ids.includes(operation.operationId)) {
              ids.push(operation.operationId);
            }
          }
          if (ids.length > 32) {
            throw failure(
              "operation_replay_capacity_exceeded",
              409,
              "Observation exceeds 32 concurrent operations.",
            );
          }
        } else {
          for (const id of authorizedIds) {
            if (!ids.includes(id)) {
              throw failure(
                "invalid_replay_cursor",
                403,
                "Checkpoint is outside the authorized selection.",
              );
            }
          }
          for (const id of ids) await get(id);
        }
        bootstrap = selection.threadId ? [] : undefined;
        if (bootstrap) {
          const tracker = createOperationReplayCursorTracker(position);
          for (const operationId of ids) {
            let afterStreamOrdinal: string | undefined;
            while (true) {
              const page = await runtime.operations.listStreams({
                namespace,
                operationId,
                afterStreamOrdinal,
                limit: 1000,
              });
              for (const stream of page) {
                if (
                  !tracker.streamPosition({
                    operationId,
                    streamOrdinal: stream.streamOrdinal,
                  }).consumed
                ) {
                  bootstrap.push({
                    streamId: stream.streamId,
                    offset: stream.committedOffset,
                    terminal: stream.state === "terminal",
                  });
                }
              }
              if (page.length < 1000) break;
              afterStreamOrdinal = page.at(-1)!.streamOrdinal;
            }
          }
        }
        if (abort.signal.aborted) throw abort.signal.reason;
      } catch (error) {
        await detach(error);
        throw error;
      }
      const selectionFrame = async (operationIds: readonly string[]) => {
        if (!selection.threadId) return;
        await writer.write(
          {
            type: "observation.selection",
            selectionPosition,
            operationIds: [...operationIds],
          } as unknown as ApplicationOutput,
        );
      };
      const attach = async (id: string) => {
        if (abort.signal.aborted || attachments.has(id) || attaching.has(id)) {
          return;
        }
        attaching.add(id);
        try {
          const attachment = await application.attach({
            operationId: id,
            namespace,
            databaseSchema,
            cursor: checkpoint,
          });
          if (abort.signal.aborted) {
            await attachment.detach();
            return;
          }
          attachments.set(id, attachment);
          draining.add(attachment);
          void attachment.drained.then(() => draining.delete(attachment));
          const pump = (async () => {
            for await (const output of attachment.outputs) {
              if (abort.signal.aborted) break;
              const attributed = {
                ...output,
                operationId: id,
                ...(selection.threadId ? { threadId: selection.threadId } : {}),
              };
              if (
                selection.threadId &&
                [
                  "operation.completed",
                  "operation.failed",
                  "operation.cancelled",
                ].includes(output.type)
              ) {
                terminal.set(id, attributed);
                notify();
              } else await writer.write(attributed);
            }
            await attachment.done;
            if (!selection.threadId) attachments.delete(id);
          })();
          pumps.add(pump);
          void pump.then(
            () => {
              pumps.delete(pump);
              notify();
            },
            (error) =>
              detach(
                error,
                (error as { code?: unknown } | null)?.code ===
                  "observation_renewal_required",
              ),
          );
        } finally {
          attaching.delete(id);
        }
      };
      const done = (async () => {
        try {
          await selectionFrame(ids);
          for (const id of ids) await attach(id);
          while (selection.threadId && !abort.signal.aborted) {
            if (!changed) {
              await new Promise<void>((resolve) => {
                wake = resolve;
              });
              wake = undefined;
            }
            changed = false;
            if (abort.signal.aborted) break;
            // Terminal replay can be forgotten only once selection discovery
            // covers its last committed event. Refresh before draining changes.
            if (terminal.size) await feed!.refresh();
            let backlog = false;
            while (!abort.signal.aborted) {
              const page = await feed!.read(selectionPosition);
              if (!page.length) break;
              const newcomers: string[] = [];
              const registered: string[] = [];
              let consumed = 0;
              for (const operation of page) {
                if (
                  !authorizedOperationMetadata(
                    operation.metadata.operationMetadata,
                  )
                ) {
                  throw failure(
                    "operation_not_found",
                    404,
                    "Operation was not found.",
                  );
                }
                const retirement = retired.get(operation.operationId);
                if (
                  retirement &&
                  BigInt(operation.changeOrdinal) <= BigInt(retirement)
                ) {
                  selectionPosition = operation.changeOrdinal;
                  consumed++;
                  continue;
                }
                if (!attachments.has(operation.operationId)) {
                  if (attachments.size + newcomers.length >= 32) {
                    backlog = true;
                    break;
                  }
                  newcomers.push(operation.operationId);
                }
                registered.push(operation.operationId);
                selectionPosition = operation.changeOrdinal;
                consumed++;
              }
              if (consumed) {
                await selectionFrame(
                  registered,
                );
                for (const [id, ordinal] of retired) {
                  if (BigInt(ordinal) <= BigInt(selectionPosition)) {
                    retired.delete(id);
                  }
                }
                for (const id of newcomers) await attach(id);
              }
              if (backlog || page.length < 32) break;
            }
            if (terminal.size) {
              // Indexed membership probes are small and shared live scans stay
              // independent of historical event payload size.
              const latest = await listThreadOperations(runtime.operations, {
                namespace,
                threadId: selection.threadId,
                operationIds: [...terminal.keys()],
                limit: 32,
              });
              for (const operation of latest) {
                const output = terminal.get(operation.operationId);
                if (!output) continue;
                await writer.write(
                  {
                    ...output,
                    finalSelectionPosition: operation.changeOrdinal,
                  } as unknown as ApplicationOutput,
                );
                if (
                  BigInt(operation.changeOrdinal) > BigInt(selectionPosition)
                ) retired.set(operation.operationId, operation.changeOrdinal);
                terminal.delete(operation.operationId);
                // Terminal output production can precede payload consumption.
                // Keep its readers alive until drained; cancellation owns both sets.
                attachments.delete(operation.operationId);
                if (backlog) notify();
              }
              if (backlog && attachments.size >= 32) {
                throw failure(
                  "operation_replay_capacity_exceeded",
                  409,
                  "Observation exceeds 32 concurrent operations. Refresh history to continue.",
                );
              }
            }
          }
          await Promise.all(pumps);
          if (renewalFailure !== undefined) throw renewalFailure;
          if (!abort.signal.aborted) await writer.close();
        } catch (error) {
          if (abort.signal.aborted) {
            if (renewalFailure !== undefined) throw renewalFailure;
            return;
          }
          await detach(
            error,
            (error as { code?: unknown } | null)?.code ===
              "observation_renewal_required",
          );
          throw error;
        } finally {
          stopAccess?.();
          feed?.close();
          selection.signal?.removeEventListener("abort", cancelled);
        }
      })();
      void done.catch(() => undefined);
      return {
        type: HTTP_OBSERVATION,
        ...(bootstrap ? { bootstrap } : {}),
        outputs: transport.readable,
        done,
        replayCursor: checkpoint,
        compositeCursor: true,
        threadId: selection.threadId,
        cancel: (reason) => detach(reason),
      };
    },
  } as const);
}
