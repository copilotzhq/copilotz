/**
 * What agents wait on you for in other chats, at the top of the sidebar
 * (kind `chat.waiting`): quietly, each a link to its chat, the oldest ask
 * first, whatever its kind (a command, a share, an answer handed back);
 * nothing at all when nothing waits. Live: an agent asking, or an answer,
 * redraws it. The chat open (`hints.path`) asks in place, so it isn't listed
 * here. Agents show as they're named (`agentsShown`). On the rail, the
 * sidebar folded (kind `chat.waiting.rail`): one mark, counting the chats
 * waiting, that goes to the oldest.
 */
import type { ReactNode } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import { Badge, Icon, NavItem, RailItem, Time } from "../../../../../hosts/web/mod.ts";
import type { Approval } from "../../collections/approval.ts";
import { agentsShown } from "../../shared/agents.ts";
import { asking, sentence } from "../asked.ts";
import { STYLE } from "./style.ts";
import { say } from "./words.ts";

/** At most this many chats waiting are listed; the rest are counted. */
const LISTED = 3;

const inSpace = (space?: string) => space ? `?in=${encodeURIComponent(space)}` : "";

/** Each chat waiting on you, but the one open, with its asks, the oldest first. */
const waitingOn = (ctx: ViewContext<ReactNode>): Approval[][] => {
  const pending = ctx.db.collection("approval").query<Approval[]>("pending", {}).value ?? [];
  const path = typeof ctx.hints.path === "string" ? ctx.hints.path : "";
  const open = path.startsWith("/thread/") ? decodeURIComponent(path.slice(8)) : undefined;
  const threads = new Map<string, Approval[]>();
  for (const a of pending) {
    if (a.thread === open) continue;
    threads.set(a.thread, [...threads.get(a.thread) ?? [], a]);
  }
  return [...threads.values()];
};

const hrefOf = (ask: Approval) => `/thread/${encodeURIComponent(ask.thread)}${inSpace(ask.in)}`;

export const waitingView = (_: unknown, ctx: ViewContext<ReactNode>): ReactNode => {
  const waiting = waitingOn(ctx);
  if (!waiting.length) return null;
  const agents = agentsShown(ctx, waiting.map(([first]) => first.agent));
  const named = (agent: string) => agents?.[agent]?.name || agent;
  const more = waiting.length - LISTED;
  return (
    <>
      <style href="chat-web" precedence="copilotz">{STYLE}</style>
      <ul className="asks-waiting" aria-label={say("waitingOnYou")}>
        {waiting.slice(0, LISTED).map((asks) => {
          const [first] = asks;
          return (
            <li key={first.thread}>
              <NavItem
                href={hrefOf(first)}
                leading={
                  <span className="asks-waiting-mark">
                    <Icon name="alert" size={13} />
                  </span>
                }
                description={asking(first)}
                end={asks.length > 1
                  ? (
                    <Badge tone="warning" aria-label={say("asksCount", { count: asks.length })}>
                      {asks.length}
                    </Badge>
                  )
                  : <Time at={first.at} />}
                title={sentence(first, named(first.agent))}
              >
                {say("needsYourOk", { agent: named(first.agent) })}
              </NavItem>
            </li>
          );
        })}
        {more > 0
          ? <li className="asks-waiting-more">{say("moreWaiting", { count: more })}</li>
          : null}
      </ul>
    </>
  );
};

/** On the rail: one mark, counting the chats waiting on you, that goes to the oldest. */
export const waitingRailView = (_: unknown, ctx: ViewContext<ReactNode>): ReactNode => {
  const waiting = waitingOn(ctx);
  if (!waiting.length) return null;
  const [first] = waiting[0];
  const agent = agentsShown(ctx, [first.agent])?.[first.agent]?.name || first.agent;
  return (
    <RailItem
      href={hrefOf(first)}
      icon="alert"
      tone="warning"
      badge={waiting.length}
      label={waiting.length === 1
        ? say("needsYourOk", { agent })
        : say("chatsWaiting", { count: waiting.length })}
    />
  );
};
