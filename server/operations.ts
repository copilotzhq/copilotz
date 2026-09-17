import {
  listThreadOperations,
  operationBelongsToThread,
  threadEventWatermark,
} from "@copilotz/copilotz/core/server";
/** One bounded observation coordinator for operation selections and conversations. */
import { createStreamOriginResolver } from "./stream-origin.ts";
import type { StreamOutput } from "../runtime/streams/types.ts";
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
          const operationId of await discover(threadId, position.eventPosition)
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
      return encodeOperationReplayCursor({ eventPosition: position });
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
      const pendingOperationIds = new Set<string>();
      let fullResyncRequested = false;
      let removeChangeListener: (() => void) | undefined;
      const cancelBeforeSetup = () => {
        abort.abort(selection.signal?.reason);
      };
      selection.signal?.addEventListener("abort", cancelBeforeSetup, {
        once: true,
      });
      if (selection.signal?.aborted) {
        abort.abort(selection.signal.reason);
      }
      try {
        if (selection.threadId) {
          const remove = await runtime.operations.onChange(
            (operationId) => {
              if (abort.signal.aborted || attachments.has(operationId)) return;
              if (fullResyncRequested) return;
              if (pendingOperationIds.has(operationId)) return;
              if (pendingOperationIds.size >= 32) {
                pendingOperationIds.clear();
                fullResyncRequested = true;
                return;
              }
              pendingOperationIds.add(operationId);
            },
          );
          removeChangeListener = remove;
          if (abort.signal.aborted) {
            removeChangeListener();
            removeChangeListener = undefined;
          }
        }
      } catch (error) {
        selection.signal?.removeEventListener("abort", cancelBeforeSetup);
        throw error;
      }
      // A direct live observation also needs a durable boundary before discovery.
      // Otherwise an operation can start and settle between two polling reads.
      let checkpoint: string | undefined;
      let position: ReturnType<typeof decodeOperationReplayCursor>;
      let ids: string[];
      let bootstrap: {
        streamId: string;
        offset: number;
        terminal: boolean;
      }[] | undefined;
      try {
        checkpoint = selection.checkpoint ??
          (selection.threadId
            ? encodeOperationReplayCursor({
              eventPosition: await threadEventWatermark(
                runtime.operations,
                namespace,
                selection.threadId,
              ) ?? "0",
            })
            : undefined);
        position = decodeOperationReplayCursor(checkpoint);
        const cursorIds = new Set([
          ...Object.keys(position.operationEventPositions ?? {}),
          ...Object.keys(position.operationStreamPositions ?? {}),
        ]);
        ids = selection.threadId
          ? await discover(selection.threadId, position.eventPosition)
          : [...selection.operationIds ?? []];
        if (
          (!selection.threadId && !ids.length) || ids.length > 32 ||
          new Set(ids).size !== ids.length ||
          ids.some((id) => typeof id !== "string" || !id)
        ) {
          throw failure(
            "invalid_operation_selection",
            400,
            "Select 1 to 32 distinct operations.",
          );
        }
        for (const id of cursorIds) {
          await get(id);
          if (
            selection.threadId
              ? !await operationBelongsToThread(
                runtime.operations,
                namespace,
                id,
                selection.threadId,
              )
              : !ids.includes(id)
          ) {
            throw failure(
              "invalid_replay_cursor",
              403,
              "Checkpoint is outside the authorized selection.",
            );
          }
          if (!ids.includes(id)) ids.push(id);
        }
        if (ids.length > 32) {
          throw failure(
            "operation_replay_capacity_exceeded",
            409,
            "Observation exceeds 32 operations.",
          );
        }
        if (!selection.threadId) {
          for (const id of ids) await get(id);
        }
        bootstrap = selection.threadId
          ? [] as {
            streamId: string;
            offset: number;
            terminal: boolean;
          }[]
          : undefined;
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
      } catch (error) {
        removeChangeListener?.();
        removeChangeListener = undefined;
        selection.signal?.removeEventListener("abort", cancelBeforeSetup);
        throw error;
      }
      let lastFullDiscoveryAt = Date.now();
      const transport = new TransformStream<
        ApplicationOutput,
        ApplicationOutput
      >(undefined, { highWaterMark: 1 }, { highWaterMark: 1 });
      const writer = transport.writable.getWriter();
      const pumps = new Set<Promise<void>>();
      const streamOrigin = createStreamOriginResolver(
        runtime,
        namespace,
        abort.signal,
      );
      let detached = false;
      const detach = async (reason = "observation_detached") => {
        if (detached) return;
        detached = true;
        abort.abort(reason);
        removeChangeListener?.();
        removeChangeListener = undefined;
        await Promise.allSettled(
          [...attachments.values()].map((attachment) =>
            attachment.detach(reason)
          ),
        );
        await writer.abort(reason).catch(() => undefined);
      };
      const cancelled = () => {
        void detach();
      };
      selection.signal?.addEventListener("abort", cancelled, { once: true });
      selection.signal?.removeEventListener("abort", cancelBeforeSetup);
      void writer.closed.catch(() => detach());
      const attach = async (id: string) => {
        if (abort.signal.aborted) return;
        if (attachments.has(id)) return;
        if (attachments.size >= 32) {
          throw failure(
            "operation_replay_capacity_exceeded",
            409,
            "Observation exceeds 32 operations.",
          );
        }
        const attachment = await application.attach({
          operationId: id,
          namespace,
          databaseSchema,
          cursor: checkpoint,
        });
        if (abort.signal.aborted) {
          await attachment.detach("observation_detached");
          return;
        }
        attachments.set(id, attachment);
        const pump = (async () => {
          for await (const output of attachment.outputs) {
            if (abort.signal.aborted) break;
            const attributed = {
              ...(output.type === "stream.output"
                ? await streamOrigin(id, output as StreamOutput)
                : output),
              operationId: id,
              ...(selection.threadId ? { threadId: selection.threadId } : {}),
            };
            await writer.write(attributed);
          }
          await attachment.done;
        })();
        pumps.add(pump);
        void pump.then(
          () => pumps.delete(pump),
          () => detach("observation_failed"),
        );
      };
      const done = (async () => {
        try {
          if (selection.signal?.aborted) await detach();
          for (const id of ids) {
            if (abort.signal.aborted) return;
            await attach(id);
            pendingOperationIds.delete(id);
          }
          while (selection.threadId && !abort.signal.aborted) {
            await new Promise<void>((resolve) => {
              const finish = () => {
                clearTimeout(timer);
                abort.signal.removeEventListener("abort", finish);
                resolve();
              };
              const timer = setTimeout(finish, 250);
              abort.signal.addEventListener("abort", finish, { once: true });
            });
            if (abort.signal.aborted) break;
            const now = Date.now();
            const safetyResync = now - lastFullDiscoveryAt >= 5_000;
            const operationIds = fullResyncRequested || safetyResync
              ? undefined
              : [...pendingOperationIds].filter((id) => !attachments.has(id));
            pendingOperationIds.clear();
            if (fullResyncRequested || safetyResync) {
              fullResyncRequested = false;
              lastFullDiscoveryAt = now;
            }
            if (operationIds === undefined || operationIds.length > 0) {
              if (operationIds === undefined) {
                for (
                  const id of await discover(
                    selection.threadId,
                    position.eventPosition,
                  )
                ) await attach(id);
              } else {
                // Keep each hint as a single-ID lookup. Batching IDs can make
                // the database choose a history-wide association plan.
                for (const operationId of operationIds) {
                  for (
                    const id of await discover(
                      selection.threadId,
                      position.eventPosition,
                      [operationId],
                    )
                  ) await attach(id);
                }
              }
            } else {
              await thread(selection.threadId);
            }
          }
          await Promise.all(pumps);
          if (!abort.signal.aborted) await writer.close();
        } catch (error) {
          await writer.abort(error).catch(() => undefined);
          await detach("observation_failed");
          throw error;
        } finally {
          selection.signal?.removeEventListener("abort", cancelled);
        }
      })();
      void done.catch(() => undefined);
      return ({
        type: HTTP_OBSERVATION,
        ...(bootstrap ? { bootstrap } : {}),
        outputs: transport.readable,
        done,
        replayCursor: checkpoint,
        compositeCursor: true,
        threadId: selection.threadId,
        cancel: detach,
      } as const);
    },
  } as const);
}
