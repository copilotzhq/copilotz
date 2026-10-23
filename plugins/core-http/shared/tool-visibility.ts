/** Core output policy at every Server transport boundary. @module */
import {
  canReadToolOutput,
  coreToolActionMetadata,
  projectToolOutput,
  toolOutputReadFilter,
} from "@copilotz/copilotz/core";
import type {
  HttpAdapter,
  HttpReadServices,
} from "../../server/authoring/http-adapter/index.ts";
import type {
  CollectionContentOptions,
  CollectionRecord,
  ScopedCollectionReadOptions,
} from "@copilotz/copilotz/collections";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
const viewers = (scope: Parameters<NonNullable<HttpAdapter["reads"]>>[1]) =>
  scope.actor?.id ? [scope.actor.id] : [];

export const coreVisibilityReads: NonNullable<HttpAdapter["reads"]> = (
  read,
  scope,
  resolve,
) => {
  const ids = viewers(scope);
  const privateCollections = new Set([
    "toolPlan",
    "toolPlanBranch",
    "toolPlanStageResult",
  ]);
  const denyPrivate = (name: string) => {
    if (privateCollections.has(name)) {
      throw Object.assign(new Error("Collection was not found."), {
        status: 404,
        code: "collection_not_found",
      });
    }
  };
  // Only narrow rows the owner already authorized. Redact before resolving so
  // unreadable bodies/reasoning never reach the resolver or consume its budget.
  const project = (
    rows: readonly CollectionRecord[],
    options?: ScopedCollectionReadOptions,
  ): Promise<readonly CollectionRecord[]> =>
    resolve(
      "message",
      rows.flatMap((row) => {
        const visibility = record(row.visibility);
        if (
          typeof row.threadId !== "string" ||
          typeof row.historyScopeId === "string" &&
            !!row.historyScopeId.trim() ||
          visibility.kind === "internal" ||
          visibility.kind === "participants" &&
            !(Array.isArray(visibility.participantIds) &&
              visibility.participantIds.some((id) => ids.includes(id)))
        ) return [];
        return [projectToolOutput(row, ids)];
      }),
      options,
    );
  const result: HttpReadServices = {
    ...read,
    aggregate(name, query, options) {
      denyPrivate(name);
      return read.aggregate(
        name,
        name === "message"
          ? {
            ...query,
            filter: {
              and: [
                ...(query.filter ? [query.filter] : []),
                toolOutputReadFilter(ids),
              ],
            },
          }
          : query,
        options,
      );
    },
    async get(name, id, options) {
      denyPrivate(name);
      if (name !== "message") return read.get(name, id, options);
      const row = await read.get(name, id, { ...options, content: false });
      return row ? (await project([row], options))[0] ?? null : null;
    },
    async list(name, query, options) {
      denyPrivate(name);
      if (name !== "message") return read.list(name, query, options);
      return project(
        await read.list(name, query, { ...options, content: false }),
        options,
      );
    },
    async query(name, queryName, input) {
      denyPrivate(name);
      if (name !== "message") return read.query(name, queryName, input);
      // The requested query still needs owner authorization. Projection never
      // invokes a second named query or accepts caller-supplied viewer authority.
      const rows = await read.query(name, queryName, {
        ...input,
        viewerParticipantIds: ids,
        content: false,
      });
      return project(rows as readonly CollectionRecord[], {
        content: input.content as CollectionContentOptions | undefined,
      });
    },
    async observe(name, query, options) {
      denyPrivate(name);
      if (name !== "message") return read.observe(name, query, options);
      const subscription = await read.observe(name, query, {
        ...options,
        content: false,
      });
      return {
        ...subscription,
        frames: {
          async *[Symbol.asyncIterator]() {
            for await (const frame of subscription.frames) {
              const selection = options?.content;
              const content = selection === true
                ? { overflow: "defer" as const }
                : selection
                ? { overflow: "defer" as const, ...selection }
                : selection;
              if (frame.t === "snapshot") {
                yield {
                  ...frame,
                  rows: await project(frame.rows, { ...options, content }),
                };
              } else if (frame.t === "batch") {
                const rows = await project(
                  frame.changes.flatMap((change) =>
                    change.record ? [change.record] : []
                  ),
                  { ...options, content },
                );
                const byId = new Map(rows.map((row) => [row.id, row]));
                yield {
                  ...frame,
                  changes: frame.changes.map((change) => ({
                    ...change,
                    record: change.record
                      ? byId.get(change.record.id) ?? null
                      : null,
                  })),
                };
              } else yield frame;
            }
          },
        },
      };
    },
  };
  return result;
};

export const authorizeCoreAsset: NonNullable<HttpAdapter["authorizeAsset"]> =
  async (id, scope, read) => {
    let restricted = false;
    // Assets shared with a readable message remain readable through that message.
    for (
      const field of [
        "content",
        "metadata.llmReasoning",
        "metadata.llmNativeReasoning.blocks",
      ]
    ) {
      const contains = { [field]: [{ assetId: id }] };
      const found = await read.list("message", { contains, limit: 1 });
      if (!found.length) continue;
      const readable = await read.list("message", {
        contains,
        filter: toolOutputReadFilter(viewers(scope)),
        limit: 1,
      });
      if (readable.length) return;
      restricted = true;
    }
    for (const field of ["content", "outputContent"]) {
      let after: string | undefined;
      for (;;) {
        const stages = await read.list("toolPlanStageResult", {
          contains: { [field]: [{ assetId: id }] },
          limit: 100,
          ...(after ? { after } : {}),
        });
        for (const stage of stages) {
          const visibility = record(record(stage.metadata).visibility);
          if (
            visibility.kind !== "tool" ||
            !canReadToolOutput(visibility, viewers(scope))
          ) restricted = true;
        }
        if (stages.length < 100) break;
        after = stages.at(-1)!.id;
      }
    }
    if (restricted) {
      throw Object.assign(new Error("Message content was not found."), {
        status: 404,
        code: "message_content_not_found",
      });
    }
  };

function projectedEvent(
  output: Parameters<NonNullable<HttpAdapter["projectOutput"]>>[0],
  data: Record<string, unknown>,
  metadata: Record<string, unknown>,
) {
  const {
    payload: _payload,
    data: _data,
    delta: _delta,
    dataRef: _dataRef,
    ...envelope
  } = output as unknown as Record<string, unknown>;
  return { ...envelope, data, payload: data, metadata } as typeof output;
}

export const authorizeCoreActionResult: NonNullable<
  HttpAdapter["authorizeActionResult"]
> = (metadata, scope) => {
  const origin = coreToolActionMetadata(metadata);
  if (!origin) return;
  const visibility = origin.outputVisibility ??
    {
      kind: "tool",
      policy: "requester_only",
      requesterId: origin.agentParticipantId,
    };
  if (
    visibility.kind === "internal" ||
    visibility.kind === "participants" &&
      !visibility.participantIds.some((id) => viewers(scope).includes(id)) ||
    visibility.kind === "tool" && !canReadToolOutput(visibility, viewers(scope))
  ) {
    throw Object.assign(new Error("Tool result was not found."), {
      status: 404,
      code: "tool_result_not_found",
    });
  }
};

export const projectCoreOutput: NonNullable<HttpAdapter["projectOutput"]> =
  async (output, scope, read, origins) => {
    const ids = viewers(scope);
    const metadata = record(output.metadata);
    const data = output.type === "stream.output"
      ? record(metadata.sourceAction)
      : record("data" in output ? output.data : undefined);
    const ancestry = typeof data.parentActionRunId === "string"
      ? await origins(data.parentActionRunId)
      : output.type === "stream.output" &&
          typeof metadata.sourceActionRunId === "string"
      ? await origins(metadata.sourceActionRunId)
      : [];
    for (const source of [data, ...ancestry]) {
      try {
        authorizeCoreActionResult(record(source.metadata), scope);
      } catch {
        return null;
      }
    }
    if (
      output.type === "message.created" || output.type === "message.updated" ||
      output.type === "message.deleted"
    ) {
      const row = record(data.record);
      if (typeof row.id !== "string" || typeof row.threadId !== "string") {
        return null;
      }
      const [visible] = await read.list("message", {
        where: { threadId: row.threadId, id: row.id },
        limit: 1,
      });
      if (!visible) return null;
      // Intent, set and assets also carry bodies; emit only the authorized record.
      return projectedEvent(output, {
        operation: data.operation,
        id: row.id,
        record: visible,
        assets: [],
      }, { core: { threadId: row.threadId, visibility: visible.visibility } });
    }
    // LLM requests contain previous Tool results, including requester-only bodies.
    // The feed needs only lifecycle identity/status; text arrives on LLM lanes.
    if (
      /^llm\.call\.(invoked|awaiting|completed|failed|cancelled)$/.test(
        output.type,
      )
    ) {
      return projectedEvent(output, {
        actionRunId: data.actionRunId,
        status: data.status,
      }, {});
    }
    const core = record(metadata.core);
    if (record(core.visibility).kind === "internal") return null;
    const visibility = record(core.visibility);
    if (visibility.kind === "tool" && !canReadToolOutput(visibility, ids)) {
      return null;
    }
    if (
      visibility.kind === "participants" &&
      !(visibility.participantIds as string[]).some((id) => ids.includes(id))
    ) return null;
    // Core Action receipts duplicate raw Message bodies and plan state. The
    // authorized Message event is the sole conversation representation.
    if (
      typeof data.actionId === "string" &&
      data.actionId.startsWith("copilotz.core.")
    ) return null;
    if (
      typeof output.type === "string" &&
      /^(toolPlan|toolPlanBranch|toolPlanStageResult|tool_plan|tool_plan_branch|tool_plan_stage_result)\./
        .test(output.type)
    ) return null;
    return output;
  };
