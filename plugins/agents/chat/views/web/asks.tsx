/**
 * What agents wait on you for in this conversation and its side threads
 * (kind `chat.asks`, over where you type: the `conversation` resource, with
 * hints `{ thread, side, busy }`): a card each, with only the answers that
 * ask takes, in its order (`chat.approve`: the answer goes into the
 * conversation, and the agent carries on). What a card says is its kind's: a
 * front end's View for it (the `askViews` resource, by `work`: a computer's
 * command, with its icon), else chat's own: a share ("Post this to Launch?",
 * who'd see it, what it would say), an answer handed back ("Post Scout's
 * answer here?"), or the ask in words. An agent's cards wait for its turn
 * to be over (it's not among the `busy`), so they come once it has said why,
 * however long other agents work on; one asked in a side thread says so.
 * Answered, one goes: `approval.pending` is live. Agents show as they're
 * named (`agentsShown`).
 *
 * With the keyboard, nothing is taken from where you type: once a card has
 * focus (Tab), the arrows move between its answers, and 1, 2, 3… answer, as
 * each button's small number says.
 */
import { type KeyboardEvent, type ReactNode, useRef, useState } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import {
  Button,
  Card,
  Icon,
  type IconName,
  LongText,
  message,
  Time,
  Tooltip,
} from "../../../../../hosts/web/mod.ts";
import type { Answer, Approval } from "../../collections/approval.ts";
import { agentsShown } from "../../shared/agents.ts";
import { BACK } from "../../shared/delivery.ts";
import { seenBy, SHARE } from "../../shared/share.ts";
import type { AskView } from "../../shared/types.ts";
import { asking, choices, sentence } from "../asked.ts";
import { STYLE } from "./style.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

export const asksView = (_: unknown, ctx: ViewContext<ReactNode>): ReactNode => {
  const thread = typeof ctx.hints.thread === "string" ? ctx.hints.thread : undefined;
  const pending = ctx.db.collection("approval").query<Approval[]>("pending", {}).value ?? [];
  // While an agent is still writing, its explanation comes first; another's work doesn't hold it.
  const busy = Array.isArray(ctx.hints.busy) ? ctx.hints.busy as string[] : [];
  // Asked here, or in one of its side threads: answered here all the same.
  const side = Array.isArray(ctx.hints.side) ? ctx.hints.side as string[] : [];
  const here = pending.filter((a) =>
    (a.thread === thread || side.includes(a.thread)) && !busy.includes(a.agent)
  );
  if (!thread || !here.length) return null;
  const agents = agentsShown(ctx, here.map((a) => a.agent));
  if (!agents) return null;
  const views = (ctx.resources.askViews ?? {}) as Record<string, AskView | null>;
  return (
    <div className="asks" role="region" aria-label="Waiting on you">
      <style href="chat-web" precedence="copilotz">{STYLE}</style>
      {here.map((a) => {
        const agent = agents[a.agent]?.name || a.agent;
        const aside = a.thread !== thread;
        // A kind a front end shows itself (a computer's command); else chat's own words for it.
        const kind = Object.hasOwn(views, a.work) ? views[a.work] : undefined;
        return (
          <AskCard
            key={a._id}
            approval={a}
            agent={agent}
            icon={kind?.icon ?? iconOf(a)}
            call={ctx.call}
          >
            {kind?.view
              ? ctx.show(kind.view, a, { agent, aside })
              : <AskWords approval={a} agent={agent} aside={aside} />}
          </AskCard>
        );
      })}
    </div>
  );
};

/** Whether what's asked goes to people outside the org: a conversation shared with contacts. */
const toContacts = (a: Pick<Approval, "on">) => a.on.startsWith("thread:");

/** Chat's own kinds' icons: a share (sent to contacts, or posted), an answer handed back. */
const iconOf = (a: Approval): IconName =>
  a.work === SHARE ? toContacts(a) ? "send" : "share" : a.work === BACK ? "chat" : "alert";

/** What a yes lets, for whoever's deciding: this once, in this conversation, for a routine, always. */
function tipOf(answer: Answer, a: Approval, agent: string): string {
  const lets = a.covers || asking(a);
  switch (answer) {
    case "once":
      return `${agent} may ${asking(a)}, this once.`;
    case "thread":
      return `${agent} may ${lets} without asking again, in this conversation.`;
    case "origin":
      return `${agent} may ${lets} without asking again, whenever “${a.origin?.name}” runs, ` +
        "until it's changed. It won't cover anything you ask it yourself.";
    case "always":
      return `${agent} may ${lets} without asking again, in any conversation.`;
    case "deny":
      return `${agent} is told no, and goes on without it.`;
    case "here":
      return "It goes in this conversation, for everyone in it.";
    case "me":
      return "It goes to your Personal space, where only you see it.";
  }
}

/** The answers that sit apart, at the end: saying no, or keeping it to yourself. */
const apart = (answer: Answer) => answer === "deny" || answer === "me";

/**
 * One ask: its kind's words (`children`), then the answers it takes, the
 * first one primary. While one is sent, the others wait; one refused (a
 * moment too soon, `busy`) says why under them.
 */
export function AskCard(
  { approval: a, agent, icon, call, children }: {
    approval: Approval;
    /** The agent, as it's named. */
    agent: string;
    icon: IconName;
    call: Call;
    children: ReactNode;
  },
): ReactNode {
  const [busy, setBusy] = useState<Answer>();
  const [error, setError] = useState<string>();
  const row = useRef<HTMLDivElement>(null);
  const options = choices(a);
  const answer = async (said: Answer) => {
    if (busy) return;
    setBusy(said);
    setError(undefined);
    try {
      await call("chat.approve", { approval: a._id, answer: said });
    } catch (e) {
      setError(message(e));
      setBusy(undefined);
    }
  };
  // With focus inside it: 1, 2, 3… answer; the arrows, Home and End move between the answers.
  const keys = (event: KeyboardEvent<HTMLElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const target = event.target as HTMLElement;
    if (target.closest("input, textarea, select, [contenteditable]")) return;
    const nth = /^[1-9]$/.test(event.key) ? Number(event.key) - 1 : -1;
    if (nth >= 0) {
      if (nth < options.length && !busy) {
        event.preventDefault();
        void answer(options[nth].answer);
      }
      return;
    }
    const buttons = [...row.current?.querySelectorAll<HTMLButtonElement>("button") ?? []];
    const at = buttons.indexOf(target as HTMLButtonElement);
    if (at < 0) return;
    const to = {
      ArrowRight: at + 1,
      ArrowDown: at + 1,
      ArrowLeft: at - 1,
      ArrowUp: at - 1,
      Home: 0,
      End: buttons.length - 1,
    }[event.key];
    if (to === undefined) return;
    event.preventDefault();
    buttons[(to + buttons.length) % buttons.length]?.focus();
  };
  return (
    <Card
      as="article"
      padding="none"
      className="ask"
      aria-label={sentence(a, agent)}
      onKeyDown={keys}
    >
      <span className="ask-icon" aria-hidden="true">
        <Icon name={icon} size={16} />
      </span>
      <div className="ask-main">
        {children}
        <div ref={row} className="ask-answers" role="group" aria-label="Answers">
          {options.map(({ answer: said, label }, i) => (
            <Tooltip key={said} text={tipOf(said, a, agent)}>
              <Button
                size="sm"
                variant={i === 0 ? "primary" : apart(said) ? "ghost" : "outline"}
                className={apart(said)
                  ? `ask-apart${said === "deny" ? " ask-deny" : ""}`
                  : undefined}
                loading={busy === said}
                disabled={!!busy}
                aria-keyshortcuts={i < 9 ? String(i + 1) : undefined}
                onClick={() => void answer(said)}
              >
                {label}
                {i < 9 ? <span className="ask-key" aria-hidden="true">{i + 1}</span> : null}
              </Button>
            </Tooltip>
          ))}
        </div>
        {error ? <p role="alert" className="ask-error">{error}</p> : null}
      </div>
    </Card>
  );
}

/** Where it was asked and when, beside its title: in a side thread, how long ago. */
function When({ approval: a, aside }: { approval: Approval; aside: boolean }): ReactNode {
  return (
    <span className="ask-where">
      {aside ? <>in a side thread ·</> : null}
      <Time at={a.at} />
    </span>
  );
}

/** What it would say, as its person reads it before saying yes: a calm quote, a few lines at first. */
function Quote({ text, label }: { text?: string; label: string }): ReactNode {
  if (!text?.trim()) return null;
  return (
    <figure className="ask-quote" aria-label={label}>
      <LongText text={text} lines={4} />
    </figure>
  );
}

/**
 * Chat's own kinds, in words: a share (where it would go, who'd see it, why
 * it asks, and what it would say), an answer handed back (here, or to you
 * alone), or any other ask as a sentence.
 */
function AskWords(
  { approval: a, agent, aside }: { approval: Approval; agent: string; aside: boolean },
): ReactNode {
  const named = a.name || a.detail;
  const contacts = toContacts(a);
  const seen = contacts ? `${named} will see it.` : seenBy({ people: a.people ?? 0 });
  if (a.work === SHARE || a.work === BACK) {
    const back = a.work === BACK;
    return (
      <>
        <div className="ask-top">
          <p className="ask-title">
            {back ? <>Post {agent}'s answer here?</> : (
              <>
                {contacts ? "Send" : "Post"} this to <b>{named}</b>?
              </>
            )}
          </p>
          <When approval={a} aside={aside} />
        </div>
        {seen && (back || !contacts)
          ? (
            <p className="ask-seen">
              <Icon name="users" size={14} />
              <span>{seen}</span>
            </p>
          )
          : null}
        <p className="ask-why">
          {back ? "It" : `${agent}'s work here`} may draw on things{" "}
          {contacts ? `${named} can't see` : `not everyone ${back ? "here" : "there"} can see`}.
        </p>
        <Quote
          text={a.preview}
          label={back
            ? `What ${agent} answered`
            : `What ${agent} would ${contacts ? "send" : "post"}`}
        />
      </>
    );
  }
  return (
    <>
      <p className="ask-head">
        <b>{agent}</b> wants to {asking(a)}
        <When approval={a} aside={aside} />
      </p>
      <Quote text={a.preview} label="What it would do" />
    </>
  );
}
