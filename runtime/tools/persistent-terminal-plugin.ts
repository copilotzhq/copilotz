import { type CopilotzPlugin, definePlugin } from "../plugins/index.ts";
import { assetIdFromRef, formatAssetRef } from "../content/index.ts";
import type { WorkflowTool, WorkflowToolExecutionContext } from "./types.ts";

export type PersistentTerminalScope = "agent" | "project" | "tenant";

export type PersistentTerminalAction =
  | "run"
  | "info"
  | "restart"
  | "close"
  | "list"
  | "upload_asset"
  | "export_file";

export type PersistentTerminalInput = Readonly<{
  action: PersistentTerminalAction;
  command?: string;
  cwd?: string;
  timeout?: number;
  scope?: PersistentTerminalScope;
  project?: string;
  path?: string;
  assetRef?: string;
  ref?: string;
  mimeType?: string;
  overwrite?: boolean;
}>;

export type PersistentTerminalAsset = Readonly<{
  assetRef: string;
  mediaType: string;
  bytes: Uint8Array;
}>;

export type PersistentTerminalPublishedAsset = Readonly<{
  assetId: string;
  assetRef: string;
  mediaType: string;
  byteLength: number;
}>;

export type PersistentTerminalServiceContext = Readonly<{
  namespace: string;
  project: string;
  agentId: string;
  threadId?: string;
  signal: AbortSignal;
  readAsset(ref: string): Promise<PersistentTerminalAsset>;
  publishAsset(
    input: Readonly<{
      bytes: Uint8Array;
      mediaType: string;
      name?: string;
      operationKey: string;
    }>,
  ): Promise<PersistentTerminalPublishedAsset>;
}>;

/** Externally owned stateful capability used by the portable tool resource. */
export type PersistentTerminalService = Readonly<{
  execute(
    input: PersistentTerminalInput,
    context: PersistentTerminalServiceContext,
  ): Promise<unknown>;
  shutdown(reason?: string): Promise<void>;
}>;

export type CreatePersistentTerminalToolsPluginOptions = Readonly<{
  terminal: PersistentTerminalService;
  id?: string;
  version?: string;
  toolId?: string;
}>;

function executionContext(
  value: WorkflowToolExecutionContext | undefined,
): WorkflowToolExecutionContext {
  if (!value?.processor) {
    throw new Error(
      "persistent_terminal requires an event-native Copilotz context.",
    );
  }
  return value;
}

function assetKind(mediaType: string): "image" | "audio" | "video" | "file" {
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType.startsWith("audio/")) return "audio";
  if (mediaType.startsWith("video/")) return "video";
  return "file";
}

function projectFrom(context: WorkflowToolExecutionContext): string {
  const project = context.threadMetadata?.project;
  if (typeof project === "string" && project.trim()) return project.trim();
  return context.threadId?.trim() || context.namespace;
}

function operationSegment(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9._-]/g, "-").slice(0, 120) || "asset";
}

function createPersistentTerminalTool(
  options: CreatePersistentTerminalToolsPluginOptions,
): WorkflowTool {
  const key = options.toolId?.trim() || "persistent_terminal";
  return Object.freeze({
    id: key,
    key,
    name: "Persistent Terminal",
    description:
      "Scoped persistent terminal. Shell state survives calls within the same worker-local session; agent, project, and tenant scopes control sharing.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "run",
            "info",
            "restart",
            "close",
            "list",
            "upload_asset",
            "export_file",
          ],
        },
        command: { type: "string" },
        cwd: { type: "string" },
        timeout: {
          type: "number",
          minimum: 1,
          maximum: 300,
          default: 30,
        },
        scope: {
          type: "string",
          enum: ["agent", "project", "tenant"],
          default: "agent",
        },
        project: { type: "string" },
        path: { type: "string" },
        assetRef: { type: "string" },
        ref: { type: "string" },
        mimeType: { type: "string" },
        overwrite: { type: "boolean", default: false },
      },
      required: ["action"],
    },
    async execute(raw: PersistentTerminalInput, value?: unknown) {
      const context = executionContext(
        value as WorkflowToolExecutionContext | undefined,
      );
      const namespace = context.namespace;
      const processor = context.processor;
      return await options.terminal.execute(raw, {
        namespace,
        project: projectFrom(context),
        agentId: context.execution.agentId ?? context.senderId ?? "anonymous",
        threadId: context.threadId,
        signal: processor.signal,
        async readAsset(ref) {
          const id = assetIdFromRef(namespace, ref);
          const asset = await processor.content.get(id);
          if (!asset) throw new Error(`Asset '${id}' was not found.`);
          const resolved = await processor.content.resolve({
            assetId: id,
            kind: assetKind(asset.mediaType),
            role: "attachment",
            mediaType: asset.mediaType,
          });
          return Object.freeze({
            assetRef: formatAssetRef(namespace, id),
            mediaType: asset.mediaType,
            bytes: resolved.bytes,
          });
        },
        async publishAsset(input) {
          const asset = await processor.content.publish({
            body: input.bytes,
            mediaType: input.mediaType,
            ...(input.name ? { metadata: { name: input.name } } : {}),
          }, {
            operationKey: `persistent-terminal:${
              operationSegment(input.operationKey)
            }`,
          });
          return Object.freeze({
            assetId: asset.id,
            assetRef: formatAssetRef(namespace, asset.id),
            mediaType: asset.mediaType,
            byteLength: asset.byteLength,
          });
        },
      });
    },
  }) as WorkflowTool;
}

/** Packages persistent terminal access without taking ownership of its service. */
export function createPersistentTerminalToolsPlugin(
  options: CreatePersistentTerminalToolsPluginOptions,
): CopilotzPlugin {
  if (!options?.terminal || typeof options.terminal.execute !== "function") {
    throw new TypeError("A persistent terminal service is required.");
  }
  const tool = createPersistentTerminalTool(options);
  return definePlugin({
    id: options.id ?? "@copilotz/persistent-terminal-tools",
    version: options.version ?? "3.0.0",
    resources: { tools: { [tool.key]: tool } },
  });
}
