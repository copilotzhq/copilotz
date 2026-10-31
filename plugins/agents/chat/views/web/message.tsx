/**
 * A message on the web. Yours sit on the right (to whom, when it isn't the
 * conversation's agents, `hints.usual`); others' on the left, under who
 * wrote it and to whom; an agent's reads as a document (markdown), a
 * person's as a bubble. A message after another from the same author goes
 * under the same name (`hints.follows`). An agent's step shows the tools it
 * called (each as its tool's View, when it has one: `toolViews`); files
 * show as previews, players or chips (each a `file` part; a
 * voice message alone has no bubble); one an agent waits on you to answer
 * says so (`hints.asked`); one from a side thread (not `hints.thread`) sits
 * indented. One of yours that waits for agents at work on an earlier one
 * says so, with a way to send it now (`hints.queued`: their ids; see
 * queued.tsx). One that drew on spaces not everyone here sees says so
 * (`hints.sources`: their names), and someone who sees them can share it.
 * One sent for someone by what they set up (`via`: a routine) says so.
 * Agents show as they're named, with their emoji (`hints.who`, by id), and
 * an agent's name links to its page; people, by their names.
 */
import type { ReactNode } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import {
  Avatar,
  Badge,
  Button,
  Chip,
  CopyButton,
  Icon,
  Markdown,
  Notice,
  Time,
} from "../../../../../hosts/web/mod.ts";
import type { Message } from "../../collections/message.ts";
import type { Step } from "../../shared/types.ts";
import { agentPath, type Shown } from "./agents.ts";
import { Queued } from "./queued.tsx";
import { Steps } from "./steps.tsx";
import { toolView } from "./tool-view.ts";
import { byAgent } from "./who.ts";
import { nameOf, namesIn } from "../../../../access/spaces/contract.ts";

export const messageView = (m: Message, ctx: ViewContext<ReactNode>): ReactNode => {
  const me = ctx.viewer?.name;
  const mine = m.from === me;
  const agent = !mine && byAgent(m);
  const aside = typeof ctx.hints.thread === "string" && m.thread !== ctx.hints.thread;
  const follows = ctx.hints.follows === true;
  // Agents as they're named (by id), with their emoji; people by their names.
  const who = (ctx.hints.who ?? {}) as Record<string, Shown>;
  const names = namesIn(ctx, [m.from, ...m.to].filter((id) => !who[id]));
  const named = (id: string) => who[id]?.name ?? nameOf(id, names);
  const author = named(m.from);
  const queued = Array.isArray(ctx.hints.queued) ? ctx.hints.queued as string[] : [];
  const to = m.to.filter((name) => name !== m.from).map((name) =>
    name === me ? "you" : named(name)
  );
  const usual = Array.isArray(ctx.hints.usual) ? ctx.hints.usual as string[] : [];
  const addressed = mine ? m.to.some((name) => !usual.includes(name)) : to.length > 0;
  // The spaces it drew on, by name (`hints.sources`, read once for the conversation).
  const sources = Array.isArray(ctx.hints.sources) ? ctx.hints.sources as string[] : m.sources;
  const kind = mine ? "mine" : agent ? "agent" : "person";

  const addressees = addressed
    ? (
      <span className="msg-to">
        <span aria-hidden="true">→</span>
        <span className="copilotz-sr">to</span> {to.join(", ")}
      </span>
    )
    : null;
  const head = mine
    ? (addressees ? <header className="msg-head">{addressees}</header> : null)
    : (
      <header className="msg-head">
        {agent
          ? <a className="msg-name" href={agentPath(m.from)}>{author}</a>
          : <span className="msg-name">{author}</span>}
        {addressees}
        {aside ? <Badge>side thread</Badge> : null}
        <Time at={m.at} />
      </header>
    );

  return (
    <article
      className={`msg msg-${kind}${follows ? " msg-follows" : ""}${aside ? " msg-aside" : ""}${
        m.failed ? " msg-failed" : ""
      }`}
      aria-label={`${mine ? "You" : author}${to.length ? ` to ${to.join(", ")}` : ""}`}
    >
      {mine ? null : (
        <div className="msg-gutter">
          {follows ? null : (
            <Avatar
              name={author}
              kind={agent ? "agent" : "person"}
              icon={agent ? who[m.from]?.icon : undefined}
              size={30}
            />
          )}
        </div>
      )}
      <div className="msg-main">
        {follows
          ? (!mine && to.some((name) => name !== "you")
            ? (
              <header className="msg-head msg-head-again">
                {addressees}
                {aside ? <Badge>side thread</Badge> : null}
              </header>
            )
            : null)
          : head}
        {m.via
          ? (
            <Chip
              size="sm"
              icon="refresh"
              className="msg-via"
              {...(m.via.path ? { href: m.via.path } : {})}
            >
              {m.via.kind[0].toUpperCase() + m.via.kind.slice(1)}: {m.via.name}
            </Chip>
          )
          : null}
        {m.toolCalls
          ? (
            <Steps
              calls={m.toolCalls as Step[]}
              text={m.text}
              me={me}
              named={named}
              shown={(m.toolCalls as Step[]).map((c) => toolView(ctx, c, m.thread))}
            />
          )
          : agent
          ? (
            <div className="msg-body">
              {m.failed
                ? <Notice tone="destructive">{m.text || "Couldn't answer."}</Notice>
                : <Markdown text={m.text ?? ""} />}
            </div>
          )
          : m.text || !m.files?.length
          ? <div className="msg-body msg-bubble">{m.text ?? ""}</div>
          : null}
        {m.files?.length
          ? (
            <div className="msg-files">
              {m.files.map((f) => ctx.show("file", { ...f, _id: f.id }, mine ? { mine } : {}))}
            </div>
          )
          : null}
        {m.subthread
          ? (
            <p className="msg-note">
              <Icon name="branch" size={14} />
              Asked in a side thread
            </p>
          )
          : null}
        {ctx.hints.asked === true
          ? (
            <Chip size="sm" variant="primary" icon="chat" className="msg-asked">
              Waiting on your answer: your next message replies.
            </Chip>
          )
          : null}
        {sources?.length && !m.toolCalls
          ? (
            <Notice
              tone="warning"
              icon="lock"
              className="msg-sources"
              action={
                <Button
                  size="sm"
                  icon="share"
                  onClick={() => void ctx.call("share", { collection: "message", id: m._id })}
                >
                  Share
                </Button>
              }
            >
              Uses <b>{sources.join(", ")}</b>. Not everyone here can see it.
            </Notice>
          )
          : null}
        {m.stopped ? <p className="msg-note">Stopped</p> : null}
        {agent && !m.toolCalls && m.text && !m.failed
          ? (
            <div className="msg-actions">
              <CopyButton text={m.text} label="Copy reply" />
            </div>
          )
          : null}
        {queued.length
          ? (
            <Queued
              thread={m.thread}
              agents={queued.map((id) => ({ id, name: named(id) }))}
              call={ctx.call}
            />
          )
          : null}
        {mine ? <Time at={m.at} className="msg-mine-time" /> : null}
      </div>
    </article>
  );
};
