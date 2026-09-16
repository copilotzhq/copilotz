/**
 * Discovers MCP Tools and authors their generated Actions and Resources.
 *
 * @module
 */

import {
  type ActionContext,
  type ActionSchema,
  type AnyActionDefinition,
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
  PrepareMcpToolsOptions,
} from "../../shared/contracts.ts";

export type {
  ConnectMcpRuntime,
  McpRuntimeConnection,
  McpToolDescriptor,
  PrepareMcpToolsOptions,
} from "../../shared/contracts.ts";

type GeneratedMcpTool = Readonly<{
  alias: string;
  action: AnyActionDefinition;
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

function allowedToolNames(server: MCPServer): ReadonlySet<string> | undefined {
  const configured = server.capabilities?.tools;
  if (!Array.isArray(configured)) return undefined;
  return new Set(
    configured.filter((value): value is string =>
      typeof value === "string" && Boolean(value.trim())
    ).map((value) => value.trim()),
  );
}

async function withConnection<T>(
  connect: PrepareMcpToolsOptions["connect"],
  server: MCPServer,
  signal: AbortSignal | undefined,
  operation: (connection: McpRuntimeConnection) => Promise<T>,
): Promise<T> {
  const connection = await connect(server, signal);
  let result: T;
  try {
    result = await operation(connection);
  } catch (error) {
    await Promise.resolve(connection.close()).catch(() => undefined);
    throw error;
  }
  await connection.close();
  return result;
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
      const capability = context.adapters.mcp?.[serverId] as {
        connect: ConnectMcpRuntime;
        server?: MCPServer;
      } | undefined;
      if (!capability?.connect) {
        throw new TypeError(
          `MCP connector is required in adapters.mcp.${serverId}.`,
        );
      }
      const result = await withConnection(
        capability.connect,
        capability.server ?? { id: serverId, name: serverName },
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

async function entriesForServer(
  server: MCPServer,
  options: PrepareMcpToolsOptions,
): Promise<readonly GeneratedMcpTool[]> {
  const descriptors = await withConnection(
    options.connect,
    server,
    options.signal,
    (connection) => connection.listTools(options.signal),
  );
  const allowed = allowedToolNames(server);
  return (descriptors
    .filter((descriptor) => !allowed || allowed.has(descriptor.name))
    .map((descriptor) => entryFrom(server, descriptor)));
}

/** Discovers all MCP Tools before registry composition. */
export async function prepareMcpTools(
  options: PrepareMcpToolsOptions,
): Promise<Readonly<Record<string, ToolDefinition>>> {
  if (typeof options?.connect !== "function") {
    throw new TypeError("An MCP runtime connector is required.");
  }
  if (!Array.isArray(options.servers)) {
    throw new TypeError("MCP Tool plugin requires a servers array.");
  }
  const entries: GeneratedMcpTool[] = [];
  const aliases = new Set<string>();
  const actionIds = new Set<string>();
  for (const server of options.servers) {
    for (const entry of await entriesForServer(server, options)) {
      assertGeneratedEntryUnique(
        aliases,
        actionIds,
        entry.alias,
        entry.action.id,
        `MCP server '${server.id}'`,
      );
      entries.push(entry);
    }
  }
  return Object.fromEntries(
    entries.map(
      (entry) => [
        entry.alias,
        defineTool({
          ...entry.action,
          name: entry.tool.name,
          description: entry.tool.description,
          history: entry.tool.history,
          metadata: entry.tool.metadata,
        }),
      ],
    ),
  );
}
