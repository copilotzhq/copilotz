import type { CollectionDefinition } from "@/database/collections/types.ts";
import type { Processor } from "@/processors/types.ts";
import type {
  Agent,
  API,
  ChannelResource,
  MCPServer,
  MemoryResource,
  ProviderResource,
  SkillResource,
  Tool,
} from "@/types/resources.ts";

export type ResourceType =
  | "agents"
  | "tools"
  | "processors"
  | "collections"
  | "providers"
  | "channels"
  | "skills"
  | "memory"
  | "apis"
  | "mcpServers";

export interface PluginResources {
  agents?: readonly Agent[];
  tools?: readonly Tool[];
  processors?: readonly Processor[];
  collections?: readonly CollectionDefinition[];
  providers?: readonly ProviderResource[];
  channels?: readonly ChannelResource[];
  skills?: readonly SkillResource[];
  memory?: readonly MemoryResource[];
  apis?: readonly API[];
  mcpServers?: readonly MCPServer[];
}

export interface PluginManifest {
  readonly id: string;
  readonly version: string;
  readonly provides: Partial<Record<ResourceType, readonly string[]>>;
  readonly presets?: Readonly<Record<string, readonly string[]>>;
}

export interface CopilotzPlugin {
  readonly manifest: PluginManifest;
  readonly resources: PluginResources;
}

export type PluginSource =
  | string
  | {
    readonly source: string;
    readonly imports?: readonly string[];
    readonly presets?: readonly string[];
  }
  | CopilotzPlugin;

export interface PluginResolver {
  resolve(source: string): Promise<unknown>;
}

export function definePlugin(plugin: CopilotzPlugin): CopilotzPlugin {
  if (!plugin.manifest.id.trim()) throw new TypeError("Plugin id is required.");
  if (!plugin.manifest.version.trim()) {
    throw new TypeError(`Plugin '${plugin.manifest.id}' requires a version.`);
  }
  return Object.freeze({
    manifest: Object.freeze({ ...plugin.manifest }),
    resources: Object.freeze({ ...plugin.resources }),
  });
}
