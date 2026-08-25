/** Owns the durable Server-to-Action invocation bridge. @module */

import {
  actionCallerDefinitionId,
  type ActionContext,
  defineAction,
  resolveActionSourceData,
  type RuntimeActionCallers,
  type RuntimeContextNamespaces,
} from "@copilotz/copilotz/actions";
import {
  parseServerActionRequest,
  SERVER_ACTION_METADATA_SCHEMA,
  type ServerInvokeRequest,
} from "../../internal/contracts.ts";

export const SERVER_INVOKE_ACTION_ID = "copilotz.server.internal.invoke";

export type ServerInvokeActionOutput =
  | Readonly<{ status: "completed"; targetActionRunId: string }>
  | Readonly<{
    status: "failed";
    error: Readonly<{ name: string; message: string }>;
  }>;

function safeError(
  error: unknown,
): Readonly<{ name: string; message: string }> {
  return Object.freeze({
    name: error instanceof Error && error.name.trim() ? error.name : "Error",
    message: "Action execution failed.",
  });
}

type ServerInvokeActionContext = ActionContext<
  RuntimeContextNamespaces,
  RuntimeContextNamespaces,
  RuntimeActionCallers
>;

export const serverInvokeAction = defineAction({
  id: SERVER_INVOKE_ACTION_ID,
  inputSchema: {
    type: "object",
    properties: {
      requestId: { type: "string", minLength: 1 },
      actionAlias: { type: "string", minLength: 1 },
    },
    required: ["requestId", "actionAlias"],
    additionalProperties: false,
  } as const,
  outputSchema: {
    type: "object",
    oneOf: [
      {
        properties: {
          status: { const: "completed" },
          targetActionRunId: { type: "string", minLength: 1 },
        },
        required: ["status", "targetActionRunId"],
        additionalProperties: false,
      },
      {
        properties: {
          status: { const: "failed" },
          error: {
            type: "object",
            properties: {
              name: { type: "string" },
              message: { type: "string" },
            },
            required: ["name", "message"],
            additionalProperties: false,
          },
        },
        required: ["status", "error"],
        additionalProperties: false,
      },
    ],
  } as const,
  async execute(
    input: ServerInvokeRequest,
    context: ServerInvokeActionContext,
  ): Promise<ServerInvokeActionOutput> {
    const request = parseServerActionRequest(
      await resolveActionSourceData(context),
    );
    if (
      request.requestId !== input.requestId ||
      request.actionAlias !== input.actionAlias
    ) throw new TypeError("Server Action request authority is inconsistent.");
    const target = context.actions[input.actionAlias];
    if (typeof target !== "function" || input.actionAlias === "serverInvoke") {
      return Object.freeze({
        status: "failed" as const,
        error: Object.freeze({
          name: "ActionUnavailableError",
          message: `Action alias '${input.actionAlias}' is unavailable.`,
        }),
      });
    }
    const targetActionId = actionCallerDefinitionId(target);
    if (!targetActionId) {
      throw new Error("Server target Action definition is unavailable.");
    }
    const targetActionRunId =
      `${context.action.runId}/action:${targetActionId}:target`;
    try {
      await target(request.input, {
        operationKey: "target",
        identity: context.identity,
        signal: context.signal,
        metadata: Object.freeze({
          ...structuredClone(request.actionMetadata),
          copilotzServer: Object.freeze({
            schema: SERVER_ACTION_METADATA_SCHEMA,
            requestId: input.requestId,
            actionAlias: input.actionAlias,
          }),
        }),
      });
      return Object.freeze({
        status: "completed" as const,
        targetActionRunId,
      });
    } catch (error) {
      if (context.signal.aborted) throw error;
      return Object.freeze({
        status: "failed" as const,
        error: safeError(error),
      });
    }
  },
});
