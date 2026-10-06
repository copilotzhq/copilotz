import {
  type CompositionContribution,
  contribution,
  type CopilotzPlugin,
  definePlugin,
} from "@copilotz/copilotz/plugins";
/**
 * Discovers MCP Tools and authors their generated Actions and Resources.
 *
 * @module
 */

import {
  type ActionContext,
  type ActionDefinition,
  type ActionSchema,
  defineAction,
} from "@copilotz/copilotz/actions";
import {
  base64ToBytes,
  type ContentInput,
  type ContentRef,
} from "@copilotz/copilotz/content";

import {
  defineTool,
  type ToolDefinition,
  type ToolResource,
} from "../../../core/authoring/define-tool/index.ts";
import {
  assertGeneratedEntryUnique,
  generatedActionAlias,
  generatedActionIdSegment,
} from "@copilotz/copilotz/core";
import { assertLosslessJson, cloneLosslessJson } from "@copilotz/copilotz/core";
import type { MCPServer } from "../contracts/index.ts";

import type {
  ConnectMcpRuntime,
  McpRuntimeConnection,
  McpToolDescriptor,
} from "../../shared/contracts.ts";

export type {
  ConnectMcpRuntime,
  McpRuntimeConnection,
  McpToolDescriptor,
} from "../../shared/contracts.ts";

type GeneratedMcpTool = Readonly<{
  alias: string;
  action: ActionDefinition<unknown, unknown, ActionContext>;
  tool: ToolResource;
}>;

function record(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : ({} as const);
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${name} must be a non-empty string.`);
  }
  return value.trim();
}

function inputSchema(value: unknown): ActionSchema {
  if (value === undefined) {
    return ({ type: "object", additionalProperties: true } as const);
  }
  const cloned = cloneLosslessJson(value, "MCP Tool input schema");
  if (!cloned || typeof cloned !== "object" || Array.isArray(cloned)) {
    throw new TypeError("MCP Tool input schema must be a plain JSON object.");
  }
  return cloned as ActionSchema;
}

function contentKind(
  mediaType: string,
): "image" | "audio" | "video" | "file" {
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType.startsWith("audio/")) return "audio";
  if (mediaType.startsWith("video/")) return "video";
  return "file";
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function lowerMcpResult(
  value: unknown,
  context: ActionContext,
  serverId: string,
  toolName: string,
): Promise<unknown> {
  assertLosslessJson(value, "MCP result");
  const bodies: ContentInput[] = [];
  const slots = new WeakMap<object, number>();
  const slot = (index: number): object => {
    const value = {} as const;
    slots.set(value, index);
    return value;
  };
  const normalize = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) {
      return (candidate.map(normalize));
    }
    if (!candidate || typeof candidate !== "object") return candidate;
    const source = candidate as Record<string, unknown>;
    if (
      (source.type === "image" || source.type === "audio") &&
      typeof source.data === "string"
    ) {
      const mediaType = requiredText(source.mimeType, "MCP media MIME type");
      const name = optionalText(source.name);
      const index = bodies.length;
      bodies.push(
        {
          type: source.type,
          bytes: base64ToBytes(source.data),
          mediaType,
          role: "tool.output",
          disposition: "attachment",
          ...(name ? { name } : {}),
        } as const,
      );
      const entries = Object.entries(source)
        .filter(([key]) => key !== "data")
        .map(([key, child]) => [key, normalize(child)] as const);
      return ({
        ...Object.fromEntries(entries),
        asset: slot(index),
      } as const);
    }
    if (source.type === "resource") {
      const embedded = source.resource;
      if (
        embedded && typeof embedded === "object" &&
        !Array.isArray(embedded) &&
        typeof (embedded as Record<string, unknown>).blob === "string"
      ) {
        const resource = embedded as Record<string, unknown>;
        const mediaType = optionalText(resource.mimeType) ??
          "application/octet-stream";
        const name = optionalText(resource.name);
        const index = bodies.length;
        bodies.push(
          {
            type: contentKind(mediaType),
            bytes: base64ToBytes(resource.blob as string),
            mediaType,
            role: "tool.output",
            disposition: "attachment",
            ...(name ? { name } : {}),
          } as const,
        );
        const resourceEntries = Object.entries(resource)
          .filter(([key]) => key !== "blob")
          .map(([key, child]) => [key, normalize(child)] as const);
        const outerEntries = Object.entries(source)
          .filter(([key]) => key !== "resource")
          .map(([key, child]) => [key, normalize(child)] as const);
        return ({
          ...Object.fromEntries(outerEntries),
          resource: {
            ...Object.fromEntries(resourceEntries),
            asset: slot(index),
          } as const,
        } as const);
      }
    }
    const entries = Object.entries(source).map(([key, child]) =>
      [key, normalize(child)] as const
    );
    return (Object.fromEntries(entries));
  };
  const template = normalize(value);
  if (bodies.length === 0) return template;
  const prepared = await context.content.prepare(bodies, {
    operationKey:
      `mcp:${serverId}:${toolName}:${context.action.runId}:result-content`,
  });
  const refs = await context.content.materialize(prepared);
  if (refs.length !== bodies.length) {
    throw new TypeError(
      "MCP result content materialization must return one ContentRef per body.",
    );
  }
  const substitute = (candidate: unknown): unknown => {
    if (candidate && typeof candidate === "object") {
      const index = slots.get(candidate);
      if (index !== undefined) return refs[index] as ContentRef;
      if (Array.isArray(candidate)) {
        return (candidate.map(substitute));
      }
      return (Object.fromEntries(
        Object.entries(candidate).map(([key, child]) => [
          key,
          substitute(child),
        ]),
      ));
    }
    return candidate;
  };
  return substitute(template);
}

async function abortable<T>(
  task: Promise<T>,
  signal: AbortSignal | undefined,
  onAbort?: () => void,
): Promise<T> {
  if (!signal) return await task;
  let cancel: () => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    cancel = () => {
      onAbort?.();
      reject(signal.reason ?? new DOMException("Cancelled", "AbortError"));
    };
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
  });
  try {
    return await Promise.race([task, cancelled]);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

async function withConnection<T>(
  connect: ConnectMcpRuntime,
  server: MCPServer,
  signal: AbortSignal | undefined,
  operation: (connection: McpRuntimeConnection) => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted();
  const connecting = connect(server, signal);
  let connection: McpRuntimeConnection;
  try {
    connection = await abortable(connecting, signal);
  } catch (error) {
    // A connector ignoring cancellation may finish later. Never leak that session.
    void connecting.then((value) => value.close()).catch(() => undefined);
    throw error;
  }
  let closing: Promise<void> | undefined;
  const close = () =>
    closing ??= Promise.resolve().then(() => connection.close());
  const cancel = () => {
    void close().catch(() => undefined);
  };
  try {
    const result = await abortable(
      Promise.resolve().then(() => operation(connection)),
      signal,
      cancel,
    );
    await abortable(close(), signal);
    return result;
  } catch (error) {
    await abortable(close(), signal).catch(() => undefined);
    throw error;
  }
}

function entryFrom(
  server: MCPServer,
  descriptor: McpToolDescriptor,
): GeneratedMcpTool {
  const serverId = requiredText(server.id, "MCP server id");
  const serverName = requiredText(server.name, "MCP server name");
  const toolName = requiredText(descriptor.name, "MCP tool name");
  const alias = generatedActionAlias(`${serverId}_${toolName}`, "mcp");
  const action = defineAction({
    id: `copilotz.tools.mcp.${generatedActionIdSegment(serverId, "server")}.${
      generatedActionIdSegment(toolName, "tool")
    }`,
    inputSchema: inputSchema(descriptor.inputSchema),
    async execute(args: unknown, context: ActionContext): Promise<unknown> {
      const capability = context.adapters.mcp?.[serverId] as
        | McpConnection
        | undefined;
      if (!capability?.connect) {
        throw new TypeError(
          `MCP connector is required in adapters.mcp.${serverId}.`,
        );
      }
      const result = await withConnection(
        capability.connect,
        { ...server, transport: capability.transport, env: capability.env },
        context.signal,
        (connection) =>
          connection.callTool(toolName, record(args), context.signal),
      );
      return await lowerMcpResult(result, context, serverId, toolName);
    },
  });
  const history = server.toolPolicies?.[alias] ??
    server.toolPolicies?.[toolName] ?? server.historyPolicyDefaults;
  const tool = defineTool(alias, action, {
    name: `${serverName}: ${toolName}`,
    description: descriptor.description?.trim() ||
      `${
        server.description?.trim() ? `${server.description}: ` : ""
      }${toolName}`,
    ...(history ? { history } : {}),
    metadata: { serverId, mcpTool: toolName },
  });
  return ({ alias, action, tool } as const);
}

async function discoverTools(
  server: MCPServer,
  connection: McpConnection,
  selected: readonly string[] | undefined,
  signal: AbortSignal,
): Promise<
  Readonly<
    Record<
      string,
      ToolDefinition<ActionDefinition<unknown, unknown, ActionContext>>
    >
  >
> {
  const descriptors = await withConnection(
    connection.connect,
    server,
    signal,
    (client) => client.listTools(signal),
  );
  const allowed = selected ? new Set(selected) : undefined;
  for (const name of allowed ?? []) {
    if (!descriptors.some((descriptor) => descriptor.name === name)) {
      throw new TypeError(`Unknown MCP tool '${name}'.`);
    }
  }
  const aliases = new Set<string>();
  const actionIds = new Set<string>();
  return Object.fromEntries(
    descriptors
      .filter((descriptor) => !allowed || allowed.has(descriptor.name))
      .map((descriptor) => {
        const entry = entryFrom(server, descriptor);
        assertGeneratedEntryUnique(
          aliases,
          actionIds,
          entry.alias,
          entry.action.id,
          `MCP server '${server.id}'`,
        );
        return [
          entry.alias,
          defineTool({
            ...entry.action,
            name: entry.tool.name,
            description: entry.tool.description,
            history: entry.tool.history,
            metadata: entry.tool.metadata,
          }),
        ];
      }),
  );
}

export type McpConnection = Readonly<{
  connect: ConnectMcpRuntime;
  transport?: MCPServer["transport"];
  env?: MCPServer["env"];
}>;

/** One connection declaration is used for discovery and runtime calls. */
export type DefineMcpInput =
  & Omit<MCPServer, "transport" | "env" | "capabilities">
  & Readonly<{
    connection: McpConnection;
    tools?: readonly string[];
    signal?: AbortSignal;
    timeoutMs?: number;
  }>;
type McpPlugin = CopilotzPlugin<
  string,
  "1",
  readonly [],
  {},
  Readonly<Record<string, ActionDefinition<unknown, unknown, ActionContext>>>,
  {},
  { tools: Readonly<Record<string, ToolResource>> },
  {
    mcp: Readonly<
      Record<string, McpConnection>
    >;
  }
>;
function mcpPlugin(
  server: MCPServer,
  connection: McpConnection,
  tools: Readonly<
    Record<
      string,
      ToolDefinition<ActionDefinition<unknown, unknown, ActionContext>>
    >
  >,
): McpPlugin {
  return definePlugin({
    id: `copilotz.mcp.${server.id}`,
    version: "1",
    resources: { tools },
    adapters: { mcp: { [server.id]: connection } },
  });
}
export type DefinedMcp = CompositionContribution<
  MCPServer,
  {},
  readonly [McpPlugin]
>;

/** Discover once, close the discovery connection, and return a composable resource. */
export async function defineMcp(input: DefineMcpInput): Promise<DefinedMcp> {
  requiredText(input.id, "MCP server id");
  requiredText(input.name, "MCP server name");
  if (typeof input.connection?.connect !== "function") {
    throw new TypeError("MCP connection.connect is required.");
  }
  if (
    input.tools &&
    (!Array.isArray(input.tools) ||
      input.tools.some((name) =>
        typeof name !== "string" || !name.trim() || name !== name.trim()
      ) ||
      new Set(input.tools).size !== input.tools.length)
  ) throw new TypeError("MCP tools must be a distinct list of tool names.");
  const timeoutMs = input.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError("MCP timeoutMs must be a positive safe integer.");
  }
  const {
    connection,
    tools: selected,
    signal: callerSignal,
    timeoutMs: _timeout,
    ...config
  } = input;
  const binding: McpConnection = Object.freeze({
    connect: connection.connect,
    ...(connection.transport
      ? { transport: cloneLosslessJson(connection.transport, "MCP transport") }
      : {}),
    ...(connection.env
      ? { env: cloneLosslessJson(connection.env, "MCP environment") }
      : {}),
  });
  const server = Object.freeze({
    ...cloneLosslessJson(config, "MCP declaration"),
    transport: binding.transport,
    env: binding.env,
  });
  const controller = new AbortController();
  const cancel = () => controller.abort(callerSignal?.reason);
  callerSignal?.addEventListener("abort", cancel, { once: true });
  if (callerSignal?.aborted) cancel();
  const timer = setTimeout(
    () =>
      controller.abort(
        new DOMException("MCP discovery timed out.", "TimeoutError"),
      ),
    timeoutMs,
  );
  try {
    controller.signal.throwIfAborted();
    const tools = await discoverTools(
      server,
      binding,
      selected,
      controller.signal,
    );
    controller.signal.throwIfAborted();
    const plugin = mcpPlugin(server, binding, tools);
    return Object.freeze({
      [contribution]: () => ({ value: server, plugins: [plugin] as const }),
    });
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", cancel);
  }
}
