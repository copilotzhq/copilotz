/**
 * A model's call that broke, in the terminal while it's tried again (`live.retry`):
 * "connection lost, retrying in 4 s", counting down, then "retrying…"; which retry,
 * past the first; and why, shortened. Dim: it usually comes back.
 */
import { Text } from "ink";
import { type ReactNode, useEffect, useState } from "react";
import { short } from "../../../../../hosts/terminal/mod.ts";
import type { Live } from "../../collections/live.ts";

export function Retrying(
  { agent, retry, prefix = "" }: {
    agent: string;
    retry: NonNullable<Live["retry"]>;
    prefix?: string;
  },
): ReactNode {
  const due = Date.parse(retry.at);
  const [now, setNow] = useState(() => Date.now());
  const waiting = now < due;
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [due, waiting]);
  const left = Math.max(1, Math.ceil((due - now) / 1000));
  return (
    <Text dimColor>
      {`${prefix}  ↻ ${agent}: connection lost, ${waiting ? `retrying in ${left} s` : "retrying…"}`}
      {retry.attempt > 1 ? ` (retry ${retry.attempt})` : ""}
      {` · ${short(retry.reason, 60)}`}
    </Text>
  );
}
