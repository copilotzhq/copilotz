/** Who wrote a message and to whom, heading its line: `[thread] ana → lead › `. */
import { Text } from "ink";
import type { ReactNode } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import { nameOf, namesIn } from "../../../../access/spaces/contract.ts";

export const authorView = (
  m: { from: string; to: string[]; thread: string },
  ctx: ViewContext<ReactNode>,
) => {
  const others = m.to.filter((name) => name !== ctx.viewer?.name);
  // People by name.
  const names = namesIn(ctx, [m.from, ...others]);
  const shown = (who: string) => nameOf(who, names);
  return (
    <Text>
      {m.thread === ctx.hints.thread ? "" : <Text dimColor>{`[${m.thread.slice(0, 8)}] `}</Text>}
      <Text color="cyan">
        {`${shown(m.from)}${others.length ? ` → ${others.map(shown).join(", ")}` : ""} › `}
      </Text>
    </Text>
  );
};
