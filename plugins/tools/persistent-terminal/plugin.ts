import { type CopilotzPlugin, definePlugin } from "@copilotz/copilotz/plugins";
import {
  assetIdFromRef,
  formatAssetRef,
  type PreparedContent,
} from "@copilotz/copilotz/content";
import { type ActionContext, defineAction } from "@copilotz/copilotz/actions";
import { defineTool } from "../contracts.ts";
import { cloneLosslessJson } from "../lifecycle-json.ts";

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

function assetKind(mediaType: string): "image" | "audio" | "video" | "file" {
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType.startsWith("audio/")) return "audio";
  if (mediaType.startsWith("video/")) return "video";
  return "file";
}

function metadataText(
  metadata: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = metadata[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function projectFrom(context: ActionContext): string {
  const project = metadataText(context.action.metadata, "project");
  if (typeof project === "string" && project.trim()) return project.trim();
  return metadataText(context.action.metadata, "threadId") ?? context.namespace;
}

function operationSegment(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9._-]/g, "-").slice(0, 120) || "asset";
}

function createPersistentTerminalAction(
  options: CreatePersistentTerminalToolsPluginOptions,
  alias: string,
) {
  return defineAction({
    id: `copilotz.tools.persistent-terminal.${alias}`,
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
    async execute(raw: PersistentTerminalInput, context: ActionContext) {
      const namespace = context.namespace;
      const staged: Array<
        Readonly<{
          candidateAssetId: string;
          candidateAssetRef: string;
          prepared: PreparedContent;
        }>
      > = [];
      const result = await options.terminal.execute(raw, {
        namespace,
        project: projectFrom(context),
        agentId: metadataText(context.action.metadata, "agentId") ??
          "anonymous",
        threadId: metadataText(context.action.metadata, "threadId"),
        signal: context.signal,
        async readAsset(ref) {
          const id = assetIdFromRef(namespace, ref);
          const asset = await context.content.get(id);
          if (!asset) throw new Error(`Asset '${id}' was not found.`);
          const resolved = await context.content.resolve({
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
          const prepared = await context.content.prepare({
            type: assetKind(input.mediaType),
            bytes: input.bytes,
            mediaType: input.mediaType,
            role: "tool.output",
            disposition: "attachment",
            ...(input.name ? { name: input.name } : {}),
          }, {
            operationKey: `persistent-terminal:${
              operationSegment(input.operationKey)
            }`,
          });
          if (prepared.content.length !== 1) {
            throw new TypeError(
              "Persistent terminal publish must prepare exactly one ContentRef.",
            );
          }
          const candidate = prepared.content[0];
          const candidateAssetRef = formatAssetRef(
            namespace,
            candidate.assetId,
          );
          staged.push({
            candidateAssetId: candidate.assetId,
            candidateAssetRef,
            prepared,
          });
          return Object.freeze({
            assetId: candidate.assetId,
            assetRef: candidateAssetRef,
            mediaType: candidate.mediaType,
            byteLength: input.bytes.byteLength,
          });
        },
      });
      const validated = cloneLosslessJson(
        result,
        "Persistent terminal result",
      );
      if (staged.length === 0) return validated;
      const combined: PreparedContent = Object.freeze({
        content: Object.freeze(
          staged.flatMap(({ prepared }) => prepared.content),
        ),
        assets: Object.freeze(
          staged.flatMap(({ prepared }) => prepared.assets),
        ),
      });
      const materialized = await context.content.materialize(combined);
      if (materialized.length !== staged.length) {
        throw new TypeError(
          "Persistent terminal content materialization must return one ContentRef per publish.",
        );
      }
      const replacements = new Map<string, string>();
      staged.forEach((candidate, index) => {
        const ref = materialized[index];
        if (ref.mediaType !== candidate.prepared.content[0].mediaType) {
          throw new TypeError(
            "Persistent terminal content materialization changed media type.",
          );
        }
        replacements.set(candidate.candidateAssetId, ref.assetId);
        replacements.set(
          candidate.candidateAssetRef,
          formatAssetRef(namespace, ref.assetId),
        );
      });
      const substitute = (value: unknown): unknown => {
        if (typeof value === "string") return replacements.get(value) ?? value;
        if (Array.isArray(value)) {
          return Object.freeze(value.map(substitute));
        }
        if (value && typeof value === "object") {
          return Object.freeze(Object.fromEntries(
            Object.entries(value).map(([key, child]) => [
              key,
              substitute(child),
            ]),
          ));
        }
        return value;
      };
      return substitute(validated);
    },
  });
}

/** Packages persistent terminal access without taking ownership of its service. */
export function createPersistentTerminalToolsPlugin(
  options: CreatePersistentTerminalToolsPluginOptions,
): CopilotzPlugin {
  if (!options?.terminal || typeof options.terminal.execute !== "function") {
    throw new TypeError("A persistent terminal service is required.");
  }
  const alias = options.toolId?.trim() || "persistent_terminal";
  const action = createPersistentTerminalAction(options, alias);
  const tool = defineTool(alias, action, {
    name: "Persistent Terminal",
    description:
      "Scoped persistent terminal. Shell state survives calls within the same worker-local session; agent, project, and tenant scopes control sharing.",
  });
  return definePlugin({
    id: options.id ?? "@copilotz/persistent-terminal-tools",
    version: options.version ?? "3.0.0",
    actions: { [alias]: action },
    resources: { tools: { [alias]: tool } },
  });
}
