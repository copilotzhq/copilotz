/**
 * What an agent is writing right now, in place: the tools it's calling (each
 * done or running; as its tool's View shows it, when it has one), then its
 * answer so far, growing, with a caret; nothing yet, it's thinking. It
 * becomes the message once written (the same commit). The agent shows as
 * it's named, with its emoji (`hints.who`, by id). When the model's call
 * broke and is tried again (`retry`), it says so, counting down, and what
 * the broken attempt wrote stays, dimmed, until the new one writes.
 */
import type { ReactNode } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import { Avatar, Badge, Icon, Markdown, Spinner } from "../../../../../hosts/web/mod.ts";
import type { Live } from "../../collections/live.ts";
import { agentPath, type Shown } from "./agents.ts";
import { Retrying } from "./retrying.tsx";
import { did } from "./steps.tsx";
import { toolView } from "./tool-view.ts";

export const liveView = (l: Live, ctx: ViewContext<ReactNode>): ReactNode => {
  const aside = typeof ctx.hints.thread === "string" && l.thread !== ctx.hints.thread;
  const shown = l.calls.map((c) => toolView(ctx, c, l.thread));
  const listed = l.calls.filter((_, i) => shown[i] === undefined);
  const who = (ctx.hints.who ?? {}) as Record<string, Shown>;
  const named = (id: string) => who[id]?.name ?? id;
  const name = named(l.agent);
  // What a broken attempt wrote, until the next one writes: dimmed.
  const stale = l.retry ? " live-stale" : "";
  return (
    <article
      className={`msg msg-agent msg-live${aside ? " msg-aside" : ""}`}
      aria-busy="true"
      aria-label={`${name}, writing`}
    >
      <div className="msg-gutter">
        <Avatar name={name} kind="agent" icon={who[l.agent]?.icon} size={30} />
      </div>
      <div className="msg-main">
        <header className="msg-head">
          <a className="msg-name" href={agentPath(l.agent)}>{name}</a>
          {aside ? <Badge>side thread</Badge> : null}
          <span className="msg-writing">
            {l.retry
              ? "reconnecting"
              : l.text
              ? "writing"
              : l.calls.length
              ? "working"
              : "thinking"}
          </span>
        </header>
        {shown.some((view) => view !== undefined)
          ? (
            <div className={`step-shown${stale}`}>
              {l.calls.map((c, i) =>
                shown[i] === undefined ? null : <div key={c.id}>{shown[i]}</div>
              )}
            </div>
          )
          : null}
        {listed.length
          ? (
            <ul className={`live-calls${stale}`}>
              {listed.map((c) => (
                <li key={c.id} data-done={c.output !== undefined || undefined}>
                  {c.output === undefined
                    ? <Spinner size={13} className="live-spinner" />
                    : <Icon name="check" size={14} />}
                  <span>{did([c], c.output === undefined, ctx.viewer?.name, named)}</span>
                </li>
              ))}
            </ul>
          )
          : null}
        {l.text
          ? (
            <div className={`msg-body${stale}`}>
              <Markdown text={l.text} streaming={!l.retry} />
            </div>
          )
          : l.calls.length || l.retry
          ? null
          : <Spinner variant="dots" label="Thinking" className="chat-thinking" />}
        {l.retry ? <Retrying retry={l.retry} /> : null}
      </div>
    </article>
  );
};
