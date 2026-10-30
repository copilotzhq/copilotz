/**
 * A message as a line: who wrote it (the `author` View) and what; its number
 * when listed (`hints.n`). An agent's step shows the tools it called. A
 * question you're asked that an agent waits on says your next message
 * answers it, until it does: that wait is this part's own read.
 */
import { Box, Text } from "ink";
import type { ReactNode } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import { short } from "../../../../../hosts/terminal/mod.ts";
import type { Message } from "../../collections/message.ts";

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
  // Labelled (with the access plugin): the spaces it drew on, by name.
  const from = m.sources?.length
    ? ctx.db.collection<{ _id: string; name: string }>("space").find({ _id: { $in: m.sources } })
    : undefined;
  const named = m.sources?.map((id) => from?.value?.find((p) => p._id === id)?.name ?? id);
  const asked = m.to.includes(ctx.viewer?.name ?? "") && !m.replyTo && m.expectReply !== false
    ? ctx.db.collection("wait").findOne({ waitingFor: m._id })
    : undefined;
  return (
    <Box flexDirection="column">
      <Text>
        <Text dimColor>{n}</Text>
        {ctx.show("author", m, ctx.hints)}
        {m.text ?? ""}
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
      {m.sources?.length
        ? (
          <Box paddingLeft={2}>
            <Text color="yellow">
              uses {named!.join(", ")}: not everyone here can see it. /share shows them.
            </Text>
          </Box>
        )
        : null}
    </Box>
  );
};
