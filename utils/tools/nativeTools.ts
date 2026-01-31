import { nativeTools } from "@/event-processors/tool_call/native-tools-registry/index.ts";
import type { NewTool } from "@/interfaces/index.ts";

export function getNativeTools(): Record<string, NewTool> {
    return nativeTools;
}