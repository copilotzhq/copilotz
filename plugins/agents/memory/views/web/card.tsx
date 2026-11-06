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
import { say } from "./words.ts";
import { nameOf, withNames } from "../../../../access/spaces/contract.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

export function MemoryCard(
  { memory: m, by, space, call, names = {} }: {
    memory: Memory;
    /** Who wrote it, as they're named (an agent, a person). */
    by?: string;
    space?: string;
    call: Call;
    /** People by name, for one that names someone by id (written before names were known). */
    names?: Record<string, string>;
  },
): ReactNode {
  const from = m.source?.thread ?? (m.about.startsWith("thread:") ? m.about.slice(7) : undefined);
  return (
    <Card as="li" className={`mem-card${m.core ? " mem-core" : ""}`}>
      <span className="mem-menu">
        <Menu
          label={say("moreMenu")}
          align="end"
          size="sm"
          items={[{
            label: say("moveToSpace"),
            icon: "move",
            onSelect: () => openPalette(moveStep(m, call)),
          }]}
        />
      </span>
      <p className="mem-text">
        {m.core
          ? (
            <span className="mem-star" title={say("coreHint")}>
              ★<span className="copilotz-sr">{say("coreSr")}</span>
            </span>
          )
          : null}
        {withNames(m.text, names)}
      </p>
      <footer>
        <span>
          {m.by === "memory"
            ? say("notedFromChat")
            : say("by", { name: by ?? nameOf(m.by, names) })}
        </span>
        <span aria-hidden="true">·</span>
        <Time at={m.updated ?? m.at} />
        {m.updated
          ? m.was
            ? (
              <Tooltip text={say("was", { text: withNames(m.was, names) })}>
                <Badge tabIndex={0}>{say("updated")}</Badge>
              </Tooltip>
            )
            : <Badge>{say("updated")}</Badge>
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
              {say("chat")}
            </Button>
          )
          : null}
      </footer>
    </Card>
  );
}
