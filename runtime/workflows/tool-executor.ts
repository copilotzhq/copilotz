import type { Agent } from "../resources/index.ts";
import { assetIdFromRef } from "../content/index.ts";
import type { ToolExecution } from "../domain/index.ts";
import type { CopilotzProcessorContext } from "../engine/index.ts";
import { validateToolCall } from "../tools/validation.ts";
import { isWorkflowTool } from "./resources.ts";
import type {
  DeferredWorkflowToolResult,
  DeferWorkflowToolOptions,
  WorkflowTool,
  WorkflowToolExecutionContext,
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
    execution: ToolExecution;
    tool?: WorkflowTool;
    availableTools?: readonly WorkflowTool[];
    arguments: unknown;
    context: CopilotzProcessorContext;
  }>,
) => Promise<WorkflowToolOutcome>;

export type CreateWorkflowToolExecutorOptions = Readonly<{
  defaultTimeoutMs?: number;
  timeoutsMs?: Readonly<Record<string, number | undefined>>;
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
  return async ({
    execution,
    tool,
    arguments: args,
    context,
    availableTools = context.resources.list<WorkflowTool>("tools").filter(
      isWorkflowTool,
    ),
  }) => {
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

    const cancellation = createCancellation(context.signal);
    const timeoutMs = timeoutFor(options, tool.key);
    const participant = execution.participantId
      ? await context.conversation.getParticipant(execution.participantId)
      : null;
    const thread = await context.conversation.getThread(execution.threadId);
    const human = thread?.participants.find((candidate) =>
      candidate.participantType === "human"
    );
    const agent = execution.agentId
      ? context.resources.get<Agent>("agents", execution.agentId)
      : undefined;
    let rejectCancellation: ((reason: Error) => void) | undefined;
    let outputSequence = 0;
    let emittedResult = false;
    let outputEmissionError: unknown;
    let outputEmission = Promise.resolve();
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
          await context.events.emit({
            type: "tool_output.delta",
            threadId: execution.threadId,
            payload: {
              toolExecutionId: execution.id,
              toolCallId: execution.toolCallId,
              toolId,
              ...(typeof execution.tool.name === "string" &&
                  execution.tool.name.trim()
                ? { toolName: execution.tool.name.trim() }
                : {}),
              channel,
              mode,
              ...(mediaType ? { mediaType } : {}),
              delta,
            },
            routing: execution.participantId
              ? { senderId: execution.participantId }
              : {},
            visibility: context.event.visibility,
            metadata: {
              toolExecutionId: execution.id,
              toolCallId: execution.toolCallId,
            },
            streamId: execution.id,
            sequence,
          });
        } catch (error) {
          outputEmissionError = error;
          throw error;
        }
      });
      outputEmission = emission.catch(() => undefined);
      return emission;
    };
    const cancellationPromise = new Promise<never>((_, reject) => {
      rejectCancellation = reject;
    });
    const toolContext: WorkflowToolExecutionContext = {
      namespace: context.namespace,
      correlationId: context.event.correlationId,
      idempotencyKey: context.idempotencyKey,
      execution,
      processor: context,
      threadId: execution.threadId,
      toolExecutionId: execution.id,
      toolCallId: execution.toolCallId,
      senderId: execution.agentId ?? participant?.externalId ?? participant?.id,
      senderType: "agent",
      userExternalId: human?.externalId,
      agent: agent ?? null,
      agents: [...context.resources.list<Agent>("agents")],
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
        return Object.freeze({
          status: "deferred" as const,
          metadata: output.metadata,
          durationMs: elapsed(started),
        });
      }
      const result = isWorkflowToolResult(output) ? output : undefined;
      const projectedOutput = result ? result.output : output;
      await outputEmission;
      if (outputEmissionError !== undefined) throw outputEmissionError;
      if (
        !emittedResult && projectedOutput !== undefined &&
        automaticLiveOutputFits(projectedOutput)
      ) {
        await emitOutput(projectedOutput, {
          channel: "result",
          mode: "replace",
        });
      }
      return Object.freeze({
        status: "completed" as const,
        output: projectedOutput,
        ...(result?.attachments ? { attachments: result.attachments } : {}),
        durationMs: elapsed(started),
      });
    } catch (caught) {
      await outputEmission;
      const error = outputEmissionError ?? caught;
      if (cancellation.cancelled()) {
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
