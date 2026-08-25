/** Composes the optional set of runtime-neutral built-in Tool primitives.
 *
 * @module
 */

import { type CopilotzPlugin, definePlugin } from "@copilotz/copilotz/plugins";
import {
  createCreateThreadAction,
  createEndThreadAction,
  createFetchAssetAction,
  createGetCurrentTimeAction,
  createSaveAssetAction,
  createUpdateMyMemoryAction,
  createUpdateUserMemoryAction,
  createWaitAction,
} from "./actions/index.ts";
import {
  createCreateThreadToolResource,
  createEndThreadToolResource,
  createFetchAssetToolResource,
  createGetCurrentTimeToolResource,
  createSaveAssetToolResource,
  createUpdateMyMemoryToolResource,
  createUpdateUserMemoryToolResource,
  createWaitToolResource,
} from "./resources/index.ts";

export const BUILT_IN_CORE_TOOL_IDS = [
  "get_current_time",
  "wait",
  "save_asset",
  "fetch_asset",
  "update_my_memory",
  "update_user_memory",
  "create_thread",
  "end_thread",
] as const;

export type BuiltInCoreToolId = typeof BUILT_IN_CORE_TOOL_IDS[number];

export type CreateBuiltInToolsPluginOptions = Readonly<{
  id?: string;
  version?: string;
  include?: readonly BuiltInCoreToolId[];
  now?: () => Date;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}>;

function defaultSleep(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error("Wait cancelled."));
      return;
    }
    const abort = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      reject(signal.reason ?? new Error("Wait cancelled."));
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** Packages runtime-neutral built-ins; host-specific tools require adapters. */
export function createBuiltInToolsPlugin(
  options: CreateBuiltInToolsPluginOptions = {},
): CopilotzPlugin {
  const ids = options.include ?? BUILT_IN_CORE_TOOL_IDS;
  if (new Set(ids).size !== ids.length) {
    throw new TypeError("Built-in tool selection contains duplicate IDs.");
  }
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? defaultSleep;
  const currentTime = createGetCurrentTimeAction(now);
  const wait = createWaitAction(sleep);
  const saveAsset = createSaveAssetAction();
  const fetchAsset = createFetchAssetAction();
  const updateMyMemory = createUpdateMyMemoryAction();
  const updateUserMemory = createUpdateUserMemoryAction(now);
  const createThread = createCreateThreadAction();
  const endThread = createEndThreadAction();
  const definitions = {
    get_current_time: {
      action: currentTime,
      tool: createGetCurrentTimeToolResource(currentTime),
    },
    wait: { action: wait, tool: createWaitToolResource(wait) },
    save_asset: {
      action: saveAsset,
      tool: createSaveAssetToolResource(saveAsset),
    },
    fetch_asset: {
      action: fetchAsset,
      tool: createFetchAssetToolResource(fetchAsset),
    },
    update_my_memory: {
      action: updateMyMemory,
      tool: createUpdateMyMemoryToolResource(updateMyMemory),
    },
    update_user_memory: {
      action: updateUserMemory,
      tool: createUpdateUserMemoryToolResource(updateUserMemory),
    },
    create_thread: {
      action: createThread,
      tool: createCreateThreadToolResource(createThread),
    },
    end_thread: {
      action: endThread,
      tool: createEndThreadToolResource(endThread),
    },
  } as const;
  const selected = ids.map((id) => {
    const definition = definitions[id];
    if (!definition) {
      throw new TypeError(
        `Built-in tool '${id}' requires a host capability adapter.`,
      );
    }
    return { id, definition };
  });
  return definePlugin({
    id: options.id ?? "@copilotz/built-in-tools",
    version: options.version ?? "3.0.0",
    actions: Object.fromEntries(
      selected.map(({ id, definition }) => [id, definition.action]),
    ),
    resources: {
      tools: Object.fromEntries(
        selected.map(({ id, definition }) => [id, definition.tool]),
      ),
    },
  });
}
