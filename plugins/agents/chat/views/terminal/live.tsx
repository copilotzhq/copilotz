/**
 * What an agent is writing right now: its tool calls as they run, then its
 * answer so far. When the model's call broke and is tried again (`retry`),
 * what the broken attempt wrote stays, dim, under when it tries next.
 */
import { Box, Text } from "ink";
import type { ReactNode } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import { short } from "../../../../../hosts/terminal/mod.ts";
import type { Live } from "../../collections/live.ts";
import { Retrying } from "./retrying.tsx";

export const liveView = (l: Live, ctx: ViewContext<ReactNode>) => {
  const elsewhere = l.thread === ctx.hints.thread ? "" : `[${l.thread.slice(0, 8)}] `;
  return (
    <Box flexDirection="column">
      {l.calls.map((c) => (
        <Text key={c.id} dimColor>
          {`${elsewhere}  ⚙ ${l.agent}: ${c.name}(${short(JSON.stringify(c.input ?? {}), 60)})`}
          {c.output === undefined ? "" : ` → ${short(c.output)}`}
        </Text>
      ))}
      {l.text
        ? (
          <Text>
            <Text dimColor>{elsewhere}</Text>
            <Text color="cyan">{`${l.agent} › `}</Text>
            <Text dimColor={!!l.retry}>{l.text}</Text>
          </Text>
        )
        : null}
      {l.retry ? <Retrying agent={l.agent} retry={l.retry} prefix={elsewhere} /> : null}
    </Box>
  );
};
