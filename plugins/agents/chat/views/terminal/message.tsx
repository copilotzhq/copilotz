/**
 * A message as a line: who wrote it (the `author` View) and what; its number
 * when listed (`hints.n`). An agent's step shows the tools it called. A
 * question you're asked that an agent waits on says your next message
 * answers it, until it does: that wait is this part's own read. One
 * standing where a reply went elsewhere (`held`) says where, dimmed.
 */
import { Box, Text } from "ink";
import type { ReactNode } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import { short } from "../../../../../hosts/terminal/mod.ts";
import type { Message } from "../../collections/message.ts";
import { nameOf, namesIn } from "../../../../access/spaces/contract.ts";
import { heldSaid } from "../held.ts";

const size = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1048576
    ? `${(bytes / 1024).toFixed(1)} KB`
    : `${(bytes / 1048576).toFixed(1)} MB`;
import type { Step } from "../../shared/types.ts";

export const messageLine = (m: Message, ctx: ViewContext<ReactNode>) => {
  if (m.toolCalls) {
    const calls = (m.toolCalls as Step[]).map((c) => `${c.name} → ${short(c.output, 40)}`);
    return <Text dimColor>{`  ⚙ ${m.from}: ${calls.join("; ")}`}</Text>;
  }
  const n = typeof ctx.hints.n === "number" ? `${`[${ctx.hints.n}]`.padStart(4)} ` : "";
  const asked = m.to.includes(ctx.viewer?.name ?? "") && !m.replyTo && m.expectReply !== false
    ? ctx.db.collection("wait").findOne({ waitingFor: m._id })
    : undefined;
  // A reply that went elsewhere: where, its person by name.
  const held = m.held
    ? heldSaid(m, m.held.for ? nameOf(m.held.for, namesIn(ctx, [m.held.for])) : undefined)
    : undefined;
  return (
    <Box flexDirection="column">
      <Text>
        <Text dimColor>{n}</Text>
        {ctx.show("author", m, ctx.hints)}
        {held ? <Text dimColor>{held}</Text> : m.text ?? ""}
        {m.subthread ? <Text dimColor>{` [subthread ${m.subthread.slice(0, 8)}]`}</Text> : null}
      </Text>
      {(m.files ?? []).map((f) => (
        <Box key={f.id} paddingLeft={2}>
          <Text dimColor>📎 {f.name} ({size(f.size)})</Text>
        </Box>
      ))}
      {asked?.value
        ? (
          <Box paddingLeft={2}>
            <Text dimColor>(your next message answers this)</Text>
          </Box>
        )
        : null}
    </Box>
  );
};
