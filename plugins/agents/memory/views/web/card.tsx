/**
 * One memory: the statement (★ when it's core), who wrote it (an agent as
 * it's named), when (and what it said before an update), the space it was
 * learned in, a link to the chat it came from, and its menu: moving it to
 * another space (the command palette's space picker).
 */
import type { ReactNode } from "react";
import {
  Badge,
  Button,
  Card,
  Menu,
  openPalette,
  Time,
  Tooltip,
} from "../../../../../hosts/web/mod.ts";
import type { Memory } from "../../collections/memory.ts";
import { moveStep } from "./move.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

export function MemoryCard(
  { memory: m, by, space, call }: {
    memory: Memory;
    /** The agent that wrote it, as it's named. */
    by?: string;
    space?: string;
    call: Call;
  },
): ReactNode {
  const from = m.source?.thread ?? (m.about.startsWith("thread:") ? m.about.slice(7) : undefined);
  return (
    <Card as="li" className={`mem-card${m.core ? " mem-core" : ""}`}>
      <span className="mem-menu">
        <Menu
          label="This memory: more"
          align="end"
          size="sm"
          items={[{
            label: "Move to another space…",
            icon: "move",
            onSelect: () => openPalette(moveStep(m, call)),
          }]}
        />
      </span>
      <p className="mem-text">
        {m.core
          ? (
            <span className="mem-star" title="Core: always in mind">
              ★<span className="copilotz-sr">Core:</span>
            </span>
          )
          : null}
        {m.text}
      </p>
      <footer>
        <span>{m.by === "memory" ? "Noted from the chat" : `By ${by ?? m.by}`}</span>
        <span aria-hidden="true">·</span>
        <Time at={m.updated ?? m.at} />
        {m.updated
          ? m.was
            ? (
              <Tooltip text={`Was: ${m.was}`}>
                <Badge tabIndex={0}>updated</Badge>
              </Tooltip>
            )
            : <Badge>updated</Badge>
          : null}
        {space
          ? (
            <>
              <span aria-hidden="true">·</span>
              <span>{space}</span>
            </>
          )
          : null}
        {from
          ? (
            <Button
              variant="link"
              size="sm"
              icon="chat"
              className="mem-source"
              href={`/thread/${encodeURIComponent(from)}${
                m.in ? `?in=${encodeURIComponent(m.in)}` : ""
              }`}
            >
              Chat
            </Button>
          )
          : null}
      </footer>
    </Card>
  );
}
