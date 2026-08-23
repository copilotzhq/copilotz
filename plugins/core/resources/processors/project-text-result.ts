import type { CollectionRecord } from "@copilotz/copilotz/collections";
import type { ContentRef } from "@copilotz/copilotz/content";
import {
  agentAskMetadata,
  deriveWorkflowId,
  textWorkflowAttemptEventMetadata,
  withAgentAskMetadata,
  withWorkflowMetadata,
} from "@copilotz/copilotz/events";
import { defineProcessor, type Processor } from "@copilotz/copilotz/plugins";
import { requireAgent } from "@copilotz/copilotz/agents";
import type { ToolInvocation } from "@copilotz/copilotz/llm";
import { createWorkflowPipelineMetadata } from "@copilotz/copilotz/tools";
import {
  type CoreProcessorContext,
  coreWorkflowContext,
} from "../../context.ts";
import {
  asRecord,
  loadParticipant,
  optionalText,
  parseJsonText,
  recordThreadId,
  requiredText,
  resolvedValue,
  stringArray,
  toolCatalogFor,
  valueContent,
} from "./helpers.ts";

async function toolCallsFromAttempt(
  context: CoreProcessorContext,
  output: Record<string, unknown>,
): Promise<readonly ToolInvocation[]> {
  const refs = Array.isArray(output.toolCalls)
    ? output.toolCalls as readonly ContentRef[]
    : [];
  const ref = refs[0];
  if (!ref) return Object.freeze([]);
  const resolved = await context.content.resolve(ref);
  const value = resolvedValue(resolved);
  return Object.freeze(Array.isArray(value) ? value as ToolInvocation[] : []);
}

export const projectTextResultProcessor: Processor<CoreProcessorContext> =
  defineProcessor<CoreProcessorContext>({
    id: "copilotz.core.project-text-result",
    on: [
      { eventType: "copilotz.core.llm.generate.completed" },
      { eventType: "copilotz.core.llm.session.completed" },
    ],
    async handle(event, context) {
      const workflowContext = coreWorkflowContext(context);
      const lifecycle = asRecord(event.data);
      const input = asRecord(lifecycle.input);
      const output = asRecord(lifecycle.output);
      if (output.status === "coalesced") return;
      const attempt = { ...input, ...output } as CollectionRecord;
      if (!textWorkflowAttemptEventMetadata(asRecord(attempt.metadata))) return;
      const participant = optionalText(attempt.participantId)
        ? await loadParticipant(context, optionalText(attempt.participantId)!)
        : null;
      if (!participant || participant.participantType !== "agent") {
        throw new Error(
          `LLM attempt '${attempt.id}' has no agent participant.`,
        );
      }
      const toolCalls = await toolCallsFromAttempt(context, output);
      const activeAsk = agentAskMetadata(attempt.metadata);
      const outputAsk = activeAsk
        ? Object.freeze({
          ...activeAsk,
          phase: toolCalls.length ? "progress" as const : "answer" as const,
          answerAttemptId: attempt.id,
        })
        : null;
      const semanticOutputMetadata = {
        llmToolCalls: toolCalls,
        ...(Array.isArray(output.reasoning)
          ? { llmReasoning: structuredClone(output.reasoning) }
          : {}),
      };
      const messageMetadata = withWorkflowMetadata(
        outputAsk
          ? withAgentAskMetadata(semanticOutputMetadata, outputAsk)
          : semanticOutputMetadata,
        {
          kind: "agent_output",
          llmAttemptId: attempt.id,
          agentParticipantId: participant.id,
        },
      );
      const outputMessage = await context.actions.createThreadMessage({
        id: await deriveWorkflowId("message", attempt.id, "output"),
        threadId: recordThreadId(attempt),
        sender: participant,
        recipientIds: [],
        content: Array.isArray(output.answer) ? output.answer : [],
        visibility: { kind: "public" },
        metadata: messageMetadata,
      }, {
        operationKey: "project:agent-message",
      }) as CollectionRecord;
      const outputMessageId = String(outputMessage.id);
      if (!toolCalls.length) return;

      const agent = requireAgent(
        workflowContext,
        requiredText(optionalText(attempt.agentId), "LLM attempt agent id"),
      );
      const toolCatalog = toolCatalogFor(agent);
      const granted = new Set(stringArray(attempt.availableToolIds));
      const availableTools = (await toolCatalog.forAgent(
        workflowContext,
        agent,
      )).filter((tool) => granted.has(tool.key));
      const toolsByKey = new Map(
        availableTools.map((tool) => [tool.key, tool]),
      );

      const batchId = attempt.id;
      const items = [];
      for (const [index, call] of toolCalls.entries()) {
        const toolId = requiredText(call.tool?.id, "Tool call tool id");
        const tool = toolsByKey.get(toolId);
        const parsedArguments = typeof call.args === "string"
          ? parseJsonText(call.args)
          : call.args;
        const preparedArguments = await context.content.prepare(
          valueContent(parsedArguments, "tool.arguments"),
          { operationKey: `project:tool:${call.id}:arguments` },
        );
        const argumentsContent = await context.content.materialize(
          preparedArguments,
        );
        const executionMetadata = withWorkflowMetadata(
          activeAsk ? withAgentAskMetadata(undefined, activeAsk) : undefined,
          {
            kind: "tool_action",
            llmAttemptId: attempt.id,
            parentLlmAttemptId: attempt.id,
            toolCallId: call.id,
            batchId,
            batchSize: toolCalls.length,
            batchIndex: index,
            ...(outputMessageId ? { sourceMessageId: outputMessageId } : {}),
            agentParticipantId: participant.id,
            ...(call.pipeline
              ? { pipeline: createWorkflowPipelineMetadata(call.pipeline) }
              : {}),
          },
        );
        const toolName = typeof tool?.name === "string"
          ? tool.name
          : call.tool?.name ?? toolId;
        items.push({
          id: await deriveWorkflowId("tool", attempt.id, call.id),
          namespace: context.namespace,
          threadId: recordThreadId(attempt),
          ...(outputMessageId ? { messageId: outputMessageId } : {}),
          participantId: participant.id,
          agentId: optionalText(attempt.agentId),
          toolCallId: call.id,
          invocation: structuredClone(call),
          tool: { id: toolId, name: toolName },
          arguments: argumentsContent,
          availableToolIds: stringArray(attempt.availableToolIds),
          status: "running",
          content: [],
          startedAt: event.createdAt,
          createdAt: event.createdAt,
          updatedAt: event.createdAt,
          historyVisibility: tool?.historyPolicy?.visibility ?? "public_status",
          metadata: executionMetadata,
          sender: {
            externalId: `tool:${toolId}`,
            participantType: "tool" as const,
            name: toolName,
          },
          sourceEvent: event,
        });
      }
      await context.actions.executeToolBatch({
        batchId,
        items,
      }, {
        operationKey: `project:tools:${attempt.id}:call-batch`,
        signal: context.signal,
      });
    },
  });
