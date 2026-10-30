/** Who wrote a message and to whom, heading its line: `[thread] ana → lead › `. */
import { Text } from "ink";
import type { ReactNode } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";

export const authorView = (
  m: { from: string; to: string[]; thread: string },
  ctx: ViewContext<ReactNode>,
) => {
  const others = m.to.filter((name) => name !== ctx.viewer?.name);
  return (
    <Text>
      {m.thread === ctx.hints.thread ? "" : <Text dimColor>{`[${m.thread.slice(0, 8)}] `}</Text>}
      <Text color="cyan">{`${m.from}${others.length ? ` → ${others.join(", ")}` : ""} › `}</Text>
    </Text>
  );
};
