import type { CollectionRecord } from "../collections/index.ts";
import type { Agent } from "../resources/index.ts";
import { assetIdFromRef } from "../content/index.ts";
import type { ContentStreamWriter, PreparedContent } from "../content/index.ts";
import type {
  CopilotzEvent,
  EventRouting,
  EventVisibility,
} from "../events/index.ts";
import {
  loadParticipantRecord,
  loadThreadRecord,
} from "../engine/collection-graph.ts";
import { validateToolCall } from "./validation.ts";
import { isWorkflowTool } from "./types.ts";
import { extractToolResultAssets } from "./result-assets.ts";
import type {
  DeferredWorkflowToolResult,
  DeferWorkflowToolOptions,
  ToolActionInput,
  WorkflowTool,
  WorkflowToolExecutionContext,
  WorkflowToolHostContext,
  WorkflowToolResult,
} from "./types.ts";

const DEFERRED_WORKFLOW_TOOL_KIND = "copilotz.workflow-tool.deferred.v1";
const MAX_AUTOMATIC_LIVE_OUTPUT_BYTES = 512 * 1024;
const outputEncoder = new TextEncoder();

/** Marks a tool call as accepted while a later event owns its settlement. */
export function deferWorkflowTool(
  options: DeferWorkflowToolOptions = {},
): DeferredWorkflowToolResult {
  return Object.freeze({
    kind: DEFERRED_WORKFLOW_TOOL_KIND,
    metadata: Object.freeze(structuredClone(options.metadata ?? {})),
  });
}

export function isDeferredWorkflowToolResult(
  value: unknown,
): value is DeferredWorkflowToolResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<DeferredWorkflowToolResult>;
  return candidate.kind === DEFERRED_WORKFLOW_TOOL_KIND &&
    Boolean(candidate.metadata) && typeof candidate.metadata === "object" &&
    !Array.isArray(candidate.metadata);
}

export function isWorkflowToolResult(
  value: unknown,
): value is WorkflowToolResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<WorkflowToolResult>;
  return candidate.kind === "copilotz.workflow-tool.result.v1" &&
    Object.prototype.hasOwnProperty.call(candidate, "output");
}

export type WorkflowToolOutcome =
  | Readonly<{
    status: "completed";
    output: unknown;
    attachments?: WorkflowToolResult["attachments"];
    extractedAttachments?: PreparedContent;
    durationMs: number;
  }>
  | Readonly<{
    status: "failed";
    code: "tool_not_found" | "validation_error" | "tool_error";
    message: string;
    error?: unknown;
    durationMs: number;
  }>
  | Readonly<{
    status: "cancelled";
    code: "timeout" | "cancelled";
    reason: string;
    durationMs: number;
  }>
  | Readonly<{
    status: "deferred";
    metadata: Readonly<Record<string, unknown>>;
    durationMs: number;
  }>;

export type WorkflowToolExecutor = (
  input: Readonly<{
    execution: ToolActionInput;
    tool?: WorkflowTool;
    availableTools?: readonly WorkflowTool[];
    arguments: unknown;
    context: WorkflowToolHostContext;
    sourceEvent?: CopilotzEvent;
    idempotencyKey?: string;
  }>,
) => Promise<WorkflowToolOutcome>;

export type OpenWorkflowToolOutputStreamInput = Readonly<{
  threadId: string;
  lane: string;
  mediaType: string;
  participantId?: string;
  metadata?: Record<string, unknown>;
  id?: string;
  routing?: EventRouting;
  visibility?: EventVisibility;
}>;

export type OpenWorkflowToolOutputStream = (
  input: OpenWorkflowToolOutputStreamInput,
) => Promise<ContentStreamWriter>;

export type CreateWorkflowToolExecutorOptions = Readonly<{
  defaultTimeoutMs?: number;
  timeoutsMs?: Readonly<Record<string, number | undefined>>;
  openStream?: OpenWorkflowToolOutputStream;
}>;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createCancellation(signal: AbortSignal): Readonly<{
  onCancel(callback: () => void): () => void;
  cancelled(): boolean;
  reason(): string | undefined;
  cancel(reason: string): void;
  dispose(): void;
}> {
  let cancelled = signal.aborted;
  let reason = signal.aborted
    ? errorText(signal.reason ?? "aborted")
    : undefined;
  const callbacks = new Set<() => void>();
  const notify = (nextReason: string) => {
    if (cancelled) return;
    cancelled = true;
    reason = nextReason;
    for (const callback of callbacks) {
      try {
        callback();
      } catch {
        // Cancellation observers cannot change workflow settlement.
      }
    }
    callbacks.clear();
  };
  const abort = () => notify(errorText(signal.reason ?? "aborted"));
  if (!signal.aborted) signal.addEventListener("abort", abort, { once: true });
  return Object.freeze({
    onCancel(callback) {
      if (cancelled) {
        callback();
        return () => {};
      }
      callbacks.add(callback);
      return () => callbacks.delete(callback);
    },
    cancelled: () => cancelled,
    reason: () => reason,
    cancel: notify,
    dispose: () => signal.removeEventListener("abort", abort),
  });
}

function timeoutFor(
  options: CreateWorkflowToolExecutorOptions,
  toolId: string,
): number | undefined {
  if (
    options.timeoutsMs &&
    Object.prototype.hasOwnProperty.call(options.timeoutsMs, toolId)
  ) return options.timeoutsMs[toolId];
  return options.defaultTimeoutMs;
}

function elapsed(started: number): number {
  return Math.max(0, Date.now() - started);
}

function outputText(value: string | undefined, fallback: string): string {
  const normalized = value?.trim();
  return normalized || fallback;
}

function automaticLiveOutputFits(value: unknown): boolean {
  try {
    const encoded = JSON.stringify(value);
    return encoded !== undefined &&
      outputEncoder.encode(encoded).byteLength <=
        MAX_AUTOMATIC_LIVE_OUTPUT_BYTES;
  } catch {
    return false;
  }
}

/** Creates the runtime-neutral executor used by durable tool deliveries. */
export function createWorkflowToolExecutor(
  options: CreateWorkflowToolExecutorOptions = {},
): WorkflowToolExecutor {
  return (input) => executeTool(input, options);
}

/** Executes one durable tool call. Prefer this over the factory wrapper. */
export async function executeTool(
  input: Readonly<{
    execution: ToolActionInput | CollectionRecord;
    tool?: WorkflowTool;
    availableTools?: readonly WorkflowTool[];
    arguments: unknown;
    context: WorkflowToolHostContext;
    sourceEvent?: CopilotzEvent;
    idempotencyKey?: string;
  }>,
  options: CreateWorkflowToolExecutorOptions = {},
): Promise<WorkflowToolOutcome> {
  return await createExecutor(options)({
    ...input,
    execution: input.execution as ToolActionInput,
  });
}

function createExecutor(
  options: CreateWorkflowToolExecutorOptions,
): WorkflowToolExecutor {
  return async ({
    execution,
    tool,
    arguments: args,
    context,
    sourceEvent: suppliedSourceEvent,
    idempotencyKey: suppliedIdempotencyKey,
    availableTools = Object.values(context.tools).filter(isWorkflowTool),
  }) => {
    const legacy = context as
      & WorkflowToolHostContext
      & Readonly<{
        event?: CopilotzEvent;
        idempotencyKey?: string;
      }>;
    const sourceEvent = suppliedSourceEvent ?? legacy.event;
    if (!sourceEvent) {
      throw new TypeError("Tool execution requires a source Event.");
    }
    const idempotencyKey = suppliedIdempotencyKey ?? legacy.idempotencyKey ??
      `tool:${execution.id}`;
    const started = Date.now();
    const toolId = typeof execution.tool.id === "string"
      ? execution.tool.id
      : "unknown";
    if (!tool) {
      const available = availableTools.map((candidate) => candidate.key)
        .sort();
      return Object.freeze({
        status: "failed" as const,
        code: "tool_not_found" as const,
        message:
          `TOOL NOT FOUND: '${toolId}' is not available. Available tools: [${
            available.join(", ")
          }].`,
        durationMs: elapsed(started),
      });
    }

    const validation = validateToolCall(
      { name: tool.key, arguments: args },
      tool,
    );
    if (!validation.valid) {
      return Object.freeze({
        status: "failed" as const,
        code: "validation_error" as const,
        message: `VALIDATION ERROR: ${
          validation.error ?? "Invalid tool arguments."
        } Please check the tool's required parameters and try again.`,
        durationMs: elapsed(started),
      });
    }

    const cancellation = createCancellation(
      context.signal ?? new AbortController().signal,
    );
    const timeoutMs = timeoutFor(options, tool.key);
    const participant = execution.participantId
      ? await loadParticipantRecord(context, execution.participantId)
      : null;
    const thread = await loadThreadRecord(context, execution.threadId);
    const human = thread?.participants.find((candidate) =>
      candidate.participantType === "human"
    );
    const agent = execution.agentId
      ? context.agents[execution.agentId]
      : undefined;
    let rejectCancellation: ((reason: Error) => void) | undefined;
    let outputSequence = 0;
    let emittedResult = false;
    let outputEmissionError: unknown;
    let outputEmission = Promise.resolve();
    const writers = new Map<string, Promise<ContentStreamWriter>>();
    let sealMode: "closed" | "failed" | "abandoned" = "closed";
    const writerFor = () => {
      const key = "tool_output:application/x-ndjson";
      const existing = writers.get(key);
      if (existing) return existing;
      if (!options.openStream) {
        throw new Error("Workflow tool live output stream is not configured.");
      }
      const created = options.openStream({
        threadId: execution.threadId,
        lane: "tool_output",
        mediaType: "application/x-ndjson",
        ...(execution.participantId
          ? { participantId: execution.participantId }
          : {}),
        metadata: {
          toolExecutionId: execution.id,
          toolCallId: execution.toolCallId,
          toolId,
          ...(typeof execution.tool.name === "string" &&
              execution.tool.name.trim()
            ? { toolName: execution.tool.name.trim() }
            : {}),
        },
        routing: execution.participantId
          ? { senderId: execution.participantId }
          : {},
        visibility: sourceEvent.visibility,
      });
      writers.set(key, created);
      return created;
    };
    const emitOutput: WorkflowToolExecutionContext["emitOutput"] = (
      delta,
      outputOptions = {},
    ) => {
      const channel = outputText(outputOptions.channel, "result");
      const mode = outputOptions.mode ??
        (channel === "result" ? "replace" : "append");
      const mediaType = outputOptions.mediaType?.trim();
      const sequence = outputSequence++;
      if (channel === "result") emittedResult = true;
      const emission = outputEmission.then(async () => {
        if (outputEmissionError !== undefined) throw outputEmissionError;
        try {
          const writer = await writerFor();
          await writer.append({
            bytes: outputEncoder.encode(
              `${
                JSON.stringify({
                  channel,
                  mode,
                  ...(mediaType ? { mediaType } : {}),
                  sequence,
                  delta,
                })
              }\n`,
            ),
            appendId: `tool-output:${sequence}`,
          });
        } catch (error) {
          outputEmissionError = error;
          throw error;
        }
      });
      outputEmission = emission.catch(() => undefined);
      return emission;
    };
    const sealWriters = async (): Promise<void> => {
      await outputEmission;
      const pending = [...writers.values()];
      writers.clear();
      await Promise.all(pending.map(async (opened) => {
        const writer = await opened.catch(() => undefined);
        if (!writer) return;
        if (sealMode === "closed") {
          await writer.close({ assetId: `stream:${writer.id}` }).catch(() =>
            undefined
          );
          return;
        }
        if (sealMode === "failed") {
          await writer.abort({
            reason: errorText(outputEmissionError ?? "Stream failed"),
          }).catch(() => undefined);
          return;
        }
        await writer.abort({ reason: "Tool output abandoned." }).catch(() =>
          undefined
        );
      }));
    };
    const cancellationPromise = new Promise<never>((_, reject) => {
      rejectCancellation = reject;
    });
    const toolContext: WorkflowToolExecutionContext = {
      namespace: context.namespace,
      correlationId: sourceEvent.correlationId,
      idempotencyKey,
      execution,
      processor: context,
      threadId: execution.threadId,
      toolExecutionId: execution.id,
      toolCallId: execution.toolCallId,
      senderId: execution.agentId ?? participant?.externalId ?? participant?.id,
      senderType: "agent",
      userExternalId: human?.externalId,
      agent: agent ?? null,
      agents: Object.values(context.agents).filter((value): value is Agent =>
        !!value
      ),
      tools: [...availableTools],
      collections: context.collections,
      userMetadata: human?.metadata,
      threadMetadata: thread?.metadata,
      resolveAsset: async (refOrId) => {
        const assetId = assetIdFromRef(context.namespace, refOrId);
        const asset = await context.content.get(assetId);
        if (!asset) throw new Error(`Asset '${refOrId}' was not found.`);
        const resolved = await context.content.resolve({
          assetId,
          kind: "file",
          role: "attachment",
          mediaType: asset.mediaType,
        });
        return { bytes: resolved.bytes, mime: asset.mediaType };
      },
      emitOutput,
      onCancel: cancellation.onCancel,
      cancelled: cancellation.cancelled(),
      cancelReason: cancellation.reason(),
    };
    const unsubscribe = cancellation.onCancel(() => {
      toolContext.cancelled = true;
      toolContext.cancelReason = cancellation.reason();
      rejectCancellation?.(
        new Error(
          `Tool execution cancelled (${cancellation.reason() ?? "abort"})`,
        ),
      );
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    if (
      typeof timeoutMs === "number" && Number.isFinite(timeoutMs) &&
      timeoutMs > 0
    ) {
      timeout = setTimeout(
        () => cancellation.cancel(`timeout:${timeoutMs}ms`),
        timeoutMs,
      );
    }

    try {
      const output = await Promise.race([
        Promise.resolve().then(() => tool.execute(args, toolContext)),
        cancellationPromise,
      ]);
      if (isDeferredWorkflowToolResult(output)) {
        await outputEmission;
        if (outputEmissionError !== undefined) throw outputEmissionError;
        await sealWriters();
        return Object.freeze({
          status: "deferred" as const,
          metadata: output.metadata,
          durationMs: elapsed(started),
        });
      }
      const result = isWorkflowToolResult(output) ? output : undefined;
      const projectedOutput = result ? result.output : output;
      const extracted = await extractToolResultAssets(projectedOutput, {
        namespace: context.namespace,
        threadId: execution.threadId,
        toolExecutionId: execution.id,
        prepare: context.content.prepare,
      });
      await outputEmission;
      if (outputEmissionError !== undefined) throw outputEmissionError;
      if (
        !emittedResult && extracted.output !== undefined &&
        automaticLiveOutputFits(extracted.output)
      ) {
        await emitOutput(extracted.output, {
          channel: "result",
          mode: "replace",
        });
      }
      await sealWriters();
      return Object.freeze({
        status: "completed" as const,
        output: extracted.output,
        ...(result?.attachments ? { attachments: result.attachments } : {}),
        ...(extracted.attachments
          ? { extractedAttachments: extracted.attachments }
          : {}),
        durationMs: elapsed(started),
      });
    } catch (caught) {
      await outputEmission;
      const error = outputEmissionError ?? caught;
      if (cancellation.cancelled()) {
        sealMode = "abandoned";
        await sealWriters();
        const reason = cancellation.reason() ?? errorText(error);
        const timedOut = reason.startsWith("timeout:");
        return Object.freeze({
          status: "cancelled" as const,
          code: timedOut ? "timeout" as const : "cancelled" as const,
          reason: timedOut && typeof timeoutMs === "number"
            ? `Tool execution timed out after ${timeoutMs}ms.`
            : reason,
          durationMs: elapsed(started),
        });
      }
      sealMode = "failed";
      await sealWriters();
      return Object.freeze({
        status: "failed" as const,
        code: "tool_error" as const,
        message: errorText(error),
        error,
        durationMs: elapsed(started),
      });
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      unsubscribe();
      cancellation.dispose();
    }
  };
}
