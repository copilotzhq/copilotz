import {
  listThreadOperations,
  operationBelongsToThread,
  threadEventWatermark,
} from "@copilotz/copilotz/core";
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
  const get = async (operationId: string) => {
    const status = await application.operationStatus({
      operationId,
      namespace,
      databaseSchema,
    });
    if (
      !status ||
      Object.entries(constraints.operations?.metadata ?? {}).some((
        [key, value],
      ) => JSON.stringify(status.metadata[key]) !== JSON.stringify(value))
    ) {
      throw failure("operation_not_found", 404, "Operation was not found.");
    }
    return status;
  };
  const thread = async (id: string) => {
    if (!await read.get("thread", id)) {
      throw failure("thread_not_found", 404, "Thread was not found.");
    }
  };
  const discover = async (threadId: string, afterPosition?: string) => {
    await thread(threadId);
    const operations = await listThreadOperations(runtime.operations, {
      namespace,
      threadId,
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
    for (const operation of operations) await get(operation.operationId);
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
      // A direct live observation also needs a durable boundary before discovery.
      // Otherwise an operation can start and settle between two polling reads.
      const checkpoint = selection.checkpoint ??
        (selection.threadId
          ? encodeOperationReplayCursor({
            eventPosition: await threadEventWatermark(
              runtime.operations,
              namespace,
              selection.threadId,
            ) ?? "0",
          })
          : undefined);
      const position = decodeOperationReplayCursor(checkpoint);
      const cursorIds = new Set([
        ...Object.keys(position.operationEventPositions ?? {}),
        ...Object.keys(position.operationStreamPositions ?? {}),
      ]);
      const ids = selection.threadId
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
      for (const id of ids) await get(id);
      const bootstrap = selection.threadId
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
      const transport = new TransformStream<
        ApplicationOutput,
        ApplicationOutput
      >(undefined, { highWaterMark: 1 }, { highWaterMark: 1 });
      const writer = transport.writable.getWriter();
      const attachments = new Map<string, ApplicationOperationAttachment>();
      const pumps = new Set<Promise<void>>();
      const abort = new AbortController();
      const streamOrigin = createStreamOriginResolver(
        runtime,
        namespace,
        abort.signal,
      );
      const detach = async (reason = "observation_detached") => {
        if (abort.signal.aborted) return;
        abort.abort(reason);
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
      void writer.closed.catch(() => detach());
      const attach = async (id: string) => {
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
            for (
              const id of await discover(
                selection.threadId,
                position.eventPosition,
              )
            ) await attach(id);
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
