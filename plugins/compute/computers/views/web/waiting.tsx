/**
 * What agents wait on you for in other chats, at the top of the sidebar
 * (kind `computer.waiting`): quietly, each a link to its chat, the oldest
 * ask first; nothing at all when nothing waits. Live: an agent asking, or an
 * answer, redraws it. The chat open (`hints.path`) asks in place, so it
 * isn't listed here. Agents show as they're named (chat's `agentsShown`). A space's computers are on its page (its Computer tab).
 */
import type { ReactNode } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import { Badge, Icon, NavItem, Time } from "../../../../../hosts/web/mod.ts";
import { agentsShown } from "../../../../agents/chat/contract.ts";
import type { Approval } from "../../collections/approval.ts";
import { asked } from "./asked.ts";
import { STYLE } from "./style.ts";

/** At most this many chats waiting are listed; the rest are counted. */
const LISTED = 3;

const inSpace = (space?: string) => space ? `?in=${encodeURIComponent(space)}` : "";

export const waitingView = (_: unknown, ctx: ViewContext<ReactNode>): ReactNode => {
  const pending = ctx.db.collection("approval").query<Approval[]>("pending", {}).value ?? [];
  const path = typeof ctx.hints.path === "string" ? ctx.hints.path : "";
  const open = path.startsWith("/thread/") ? decodeURIComponent(path.slice(8)) : undefined;
  // Each chat waiting on you, elsewhere, oldest ask first.
  const threads = new Map<string, Approval[]>();
  for (const a of pending) {
    if (a.thread === open) continue;
    threads.set(a.thread, [...threads.get(a.thread) ?? [], a]);
  }
  const waiting = [...threads.values()];
  if (!waiting.length) return null;
  const agents = agentsShown(ctx, waiting.map(([first]) => first.agent));
  const named = (agent: string) => agents?.[agent]?.name || agent;
  return (
    <>
      <style href="computers-web" precedence="copilotz">{STYLE}</style>
      <ul className="computers" aria-label="Waiting on you">
        {waiting.slice(0, LISTED).map((asks) => {
          const [first] = asks;
          const { wants, what } = asked(first);
          return (
            <li key={first.thread}>
              <NavItem
                href={`/thread/${encodeURIComponent(first.thread)}${inSpace(first.in)}`}
                leading={
                  <span className="computers-waiting">
                    <Icon name="alert" size={13} />
                  </span>
                }
                description={`${wants.replace(/^wants /, "")} ${what}`}
                end={asks.length > 1
                  ? <Badge tone="warning" aria-label={`${asks.length} asks`}>{asks.length}</Badge>
                  : <Time at={first.at} />}
                title={`${named(first.agent)} ${wants} ${what}`}
              >
                {named(first.agent)} needs your OK
              </NavItem>
            </li>
          );
        })}
        {waiting.length > LISTED
          ? (
            <li className="computers-more">
              and {waiting.length - LISTED} more chat{waiting.length - LISTED === 1 ? "" : "s"}{" "}
              waiting on you
            </li>
          )
          : null}
      </ul>
    </>
  );
};
