import { createEphemeralEvent } from "../runtime/events/index.ts";
import { watchSelection } from "./selection-watch.ts";

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
} from "../plugins/server/shared/contracts.ts";
import { HTTP_OBSERVATION, type HttpObservation } from "./http-types.ts";

function failure(code: string, status: number, message: string) {
  return Object.assign(new Error(message), { code, status });
}

export async function createHttpOperations(
  application: InternalCopilotzApplication,
  scope: ServerAuthorizedScope,
  read: HttpReadServices,
  adapters = Object.values(
    application.plugins?.adapters.http ?? {},
  ) as import("../plugins/server/authoring/http-adapter/index.ts").HttpAdapter[],
  receiptAuthority?:
    import("../runtime/authorization/authority.ts").AuthenticatedAuthority,
) {
  const namespace = scope.namespace ?? application.config.namespace!;
  const databaseSchema = scope.databaseSchema ??
    application.config.databaseSchema;
  const runtime = databaseSchema === application.config.databaseSchema
    ? application
    : await application.databaseScope(databaseSchema);
  const get = async (operationId: string) => {
    if (!scope.authority) {
      throw failure("forbidden", 403, "Retained authority is required.");
    }
    const recovered = receiptAuthority &&
      await runtime.authorization.logoutReceipt(receiptAuthority, operationId);
    const record = await runtime.authorization.operation(
      recovered?.state === "completed" ? receiptAuthority! : scope.authority,
      operationId,
    );
    return {
      operationId: record.operationId,
      namespace: record.namespace,
      correlationId: record.correlationId,
      state: ["accepted", "running"].includes(record.state)
        ? record.state
        : "settled",
      ...(["accepted", "running"].includes(record.state)
        ? {}
        : { outcome: record.state }),
      metadata: record.metadata.operationMetadata as Record<string, unknown> ??
        {},
      acceptedAt: record.acceptedAt,
      updatedAt: record.updatedAt,
      ...(record.completedAt ? { settledAt: record.completedAt } : {}),
    };
  };
  type RecordSelection = Readonly<{ collection: string; id: string }>;
  const descriptor = (record: RecordSelection) => {
    const matches = adapters.flatMap((adapter) =>
      adapter.observations?.[record.collection]
        ? [adapter.observations[record.collection]]
        : []
    );
    if (matches.length !== 1) {
      throw failure(
        "invalid_operation_selection",
        400,
        "Collection observation is not configured.",
      );
    }
    return matches[0];
  };
  const authorizeRecord = async (record: RecordSelection) => {
    descriptor(record);
    if (!await read.get(record.collection, record.id)) {
      throw failure("record_not_found", 404, "Record was not found.");
    }
  };
  const list = (record: RecordSelection, input: {
    operationIds?: readonly string[];
    states?: readonly import("../runtime/streams/catalog.ts").OperationState[];
    afterPosition?: string;
    limit: number;
  }) =>
    runtime.operations.listSelectionChanges({
      namespace,
      selectionKey: descriptor(record).key(record.id),
      operationIds: input.operationIds,
      states: input.states,
      afterChangeOrdinal: input.afterPosition,
      limit: input.limit,
    });
  const watermark = async (record: RecordSelection) => {
    const key = descriptor(record).key(record.id);
    return (await runtime.operations.getSelectionHeads({
      namespace,
      selectionKeys: [key],
    }))
      .find((head) => head.selectionKey === key)?.changeOrdinal;
  };
  const discover = async (
    record: RecordSelection,
    afterPosition?: string,
    operationIds?: readonly string[],
  ) => {
    await authorizeRecord(record);
    const operations = await list(record, {
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
      await get(operation.operationId);
    }
    return operations.map((operation) => operation.operationId);
  };
  type OperationSelection = {
    operationIds?: readonly string[];
    record?: RecordSelection;
    checkpoint?: string;
    signal?: AbortSignal;
  };
  const logoutObservation = async (
    selection: OperationSelection,
  ): Promise<HttpObservation | undefined> => {
    // A revoked credential can recover only its own completed receipt. Do not
    // attach history, streams, record selections, or cursor-selected operations.
    if (
      scope.authority && !selection.record &&
      selection.operationIds?.length === 1
    ) {
      let receipt = await runtime.authorization.logoutReceipt(
        receiptAuthority ?? scope.authority,
        selection.operationIds[0],
      );
      if (receipt) {
        const operationId = receipt.operationId;
        if (receipt.state === "accepted" || receipt.state === "running") {
          const changes = await runtime.operations.watch(operationId, {
            namespace,
            kind: "operation",
          });
          const deadline = Date.now() + 10_000;
          try {
            for (;;) {
              selection.signal?.throwIfAborted();
              // Subscribe before rereading so completion cannot fall in a gap.
              receipt = await runtime.authorization.logoutReceipt(
                receiptAuthority ?? scope.authority,
                operationId,
              );
              if (!receipt) {
                throw failure("forbidden", 403, "Receipt is unavailable.");
              }
              if (
                receipt.state !== "accepted" && receipt.state !== "running"
              ) break;
              const remaining = deadline - Date.now();
              if (
                remaining <= 0 ||
                !await changes.wait({
                  timeoutMs: remaining,
                  signal: selection.signal,
                })
              ) {
                throw failure(
                  "operation_result_pending",
                  409,
                  "Logout completion is still pending; retry observation.",
                );
              }
            }
          } finally {
            changes.close();
          }
        }
        if (receipt.state !== "completed") {
          throw failure(
            "forbidden",
            403,
            "Completed receipt is unavailable.",
          );
        }
        selection.signal?.throwIfAborted();
        const position = decodeOperationReplayCursor(selection.checkpoint);
        const cursorIds = [
          ...Object.keys(position.operationEventPositions ?? {}),
          ...Object.keys(position.operationStreamPositions ?? {}),
          ...Object.keys(position.operationSelectionPositions ?? {}),
          ...Object.keys(position.operationRetirementPositions ?? {}),
        ];
        if (cursorIds.some((id) => id !== operationId)) {
          throw failure(
            "invalid_replay_cursor",
            403,
            "Checkpoint is outside the authorized selection.",
          );
        }
        const output = {
          ...createEphemeralEvent({
            type: "operation.settled",
            namespace,
            correlationId: receipt.correlationId,
            payload: { outcome: "completed" },
          }),
          operationId: receipt.operationId,
          state: "settled",
          outcome: "completed",
          data: { outcome: "completed" },
          seq: await runtime.operations.resultSequence(namespace, operationId),
        } as ApplicationOutput;
        return {
          type: HTTP_OBSERVATION,
          operationId: receipt.operationId,
          async authorizePublication(publish) {
            const current = await runtime.authorization.logoutReceipt(
              receiptAuthority ?? scope.authority!,
              operationId,
            );
            if (current?.state !== "completed") {
              throw failure("forbidden", 403, "Receipt is unavailable.");
            }
            await publish();
          },
          outputs: new ReadableStream<ApplicationOutput>({
            start(controller) {
              controller.enqueue(output);
              controller.close();
            },
          }),
          done: Promise.resolve(),
          async cancel() {},
        };
      }
    }
  };
  return ({
    get,
    async checkpoint(
      record: RecordSelection,
      coverage?: { checkpoint: string; actionRunIds: readonly string[] },
    ) {
      await authorizeRecord(record);
      if (coverage) {
        const position = decodeOperationReplayCursor(coverage.checkpoint);
        let tracker = createOperationReplayCursorTracker(position);
        const covered = new Set(coverage.actionRunIds);
        for (
          const operationId of await discover(
            record,
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
              // Coverage follows the logical terminal offset even after bytes
              // become purged; cleanup progress never changes this boundary.
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
      const position = await watermark(record) ??
        "0";
      return encodeOperationReplayCursor({ selectionPosition: position });
    },
    async observe(
      selection: OperationSelection,
    ): Promise<HttpObservation> {
      const recovered = await logoutObservation(selection);
      if (recovered) return recovered;
      const abort = new AbortController();
      const attachments = new Map<string, ApplicationOperationAttachment>();
      const draining = new Set<ApplicationOperationAttachment>();
      const attaching = new Set<string>();
      const terminal = new Map<string, ApplicationOutput>();
      const pumps = new Set<Promise<void>>();
      let stopAccess: (() => void) | undefined;
      let authorityChannel:
        | Awaited<ReturnType<typeof runtime.authorization.observe>>
        | undefined;
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
        if (!drain) stopAccess?.();
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
        if (!drain) stopAccess?.();
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
        if (!scope.authority) {
          throw failure("forbidden", 403, "Retained authority is required.");
        }
        authorityChannel = await runtime.authorization.observe(
          scope.authority,
          {
            ...(selection.record ? { record: selection.record } : {}),
            ...(selection.operationIds
              ? { operationIds: selection.operationIds }
              : {}),
          },
          (error) => {
            void detach(error);
          },
        );
        stopAccess = () => authorityChannel?.close();
        if (selection.record) {
          await authorizeRecord(selection.record);
          feed = await watchSelection(
            runtime.operations,
            namespace,
            descriptor(selection.record).key(selection.record.id),
            notify,
          );
        }
        checkpoint = selection.checkpoint ??
          (selection.record
            ? encodeOperationReplayCursor({
              selectionPosition: await watermark(selection.record) ?? "0",
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
        ids = selection.record
          ? [...cursorIds]
          : [...selection.operationIds ?? []];
        if (
          (!selection.record && !ids.length) || ids.length > 32 ||
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
        if (selection.record) {
          const members = authorizedIds.size
            ? await list(selection.record, {
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
              !operation
            ) {
              throw failure(
                "invalid_replay_cursor",
                403,
                "Checkpoint is outside the authorized selection.",
              );
            }
            await get(id);
          }
          // The history boundary covers terminal work. Operations still running
          // at that boundary must be followed even if they began earlier.
          const active = await list(selection.record, {
            states: ["accepted", "running"],
            limit: 33,
          });
          for (const operation of active) {
            await get(operation.operationId);
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
        bootstrap = selection.record ? [] : undefined;
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
        const code = (error as { code?: string }).code;
        if (
          !selection.signal?.aborted &&
          ["forbidden", "revoked"].includes(code ?? "")
        ) {
          // The self-revocation effect may have committed after initial lookup.
          const recovered = await logoutObservation(selection);
          if (recovered) return recovered;
        }
        throw error;
      }
      const selectionFrame = async (operationIds: readonly string[]) => {
        if (!selection.record) return;
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
                ...(selection.record
                  ? descriptor(selection.record).outputMetadata?.(
                    selection.record.id,
                  ) ?? {}
                  : {}),
              };
              if (
                selection.record &&
                output.type === "operation.settled"
              ) {
                terminal.set(id, attributed);
                notify();
              } else await writer.write(attributed);
            }
            await attachment.done;
            if (!selection.record) attachments.delete(id);
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
          while (selection.record && !abort.signal.aborted) {
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
                await get(operation.operationId);
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
              const latest = await list(selection.record, {
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
          feed?.close();
          selection.signal?.removeEventListener("abort", cancelled);
        }
      })();
      void done.catch(() => undefined);
      return {
        type: HTTP_OBSERVATION,
        authorizePublication: (publish) => authorityChannel!.publish(publish),
        heartbeat: (streamIds) =>
          runtime.operations.pushState({
            namespace,
            operationIds: [...new Set([...ids, ...attachments.keys()])],
            streamIds,
          }),
        ...(bootstrap ? { bootstrap } : {}),
        outputs: transport.readable,
        done,
        replayCursor: checkpoint,
        compositeCursor: true,
        selectionMetadata: selection.record
          ? descriptor(selection.record).outputMetadata?.(selection.record.id)
          : undefined,
        cancel: (reason) => detach(reason),
      };
    },
  } as const);
}
