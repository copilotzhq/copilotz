/**
 * A tool call shown by its tool's own View, when a front end gives it one
 * (the `toolViews` resource: by tool, a View kind), as a part of its own;
 * undefined when it has none, and chat shows it as data.
 */
import type { ReactNode } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import type { ShownCall, ToolViews } from "../../shared/types.ts";

type Call = { id: string; name: string; input?: Record<string, unknown>; output?: string };

export function toolView(
  ctx: ViewContext<ReactNode>,
  call: Call,
  thread?: string,
): ReactNode | undefined {
  const view = ((ctx.resources.toolViews ?? {}) as ToolViews)[call.name];
  if (!view) return undefined;
  const shown: ShownCall = {
    _id: call.id,
    name: call.name,
    ...(call.input ? { input: call.input } : {}),
    ...(call.output !== undefined ? { output: call.output } : {}),
  };
  return ctx.show(view, shown, {
    ...(thread ? { thread } : {}),
    ...(call.output === undefined ? { running: true } : {}),
  });
}
