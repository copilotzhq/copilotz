/**
 * A message refused because it named agents that don't answer in its space
 * (kind `space.not-here`, chat's `refusals` resource for `not_here`): shown
 * over where you type, nothing sent, what was typed still there. Hints:
 * `{ in, names, text, message, resend, dismiss }`. Of the names, the agents
 * the person meets that don't answer there (chat's `thread.agents`): who,
 * and where. Those who manage the space add them as editors (`member.set`;
 * one there as a viewer becomes an editor) and the message goes as it was
 * typed (`resend`); anyone else is told to ask someone who manages it. Names
 * that aren't such agents leave the refusal's own words.
 */
import { type ReactNode, useState } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import { Avatar, Button, message, Notice } from "../../../../../hosts/web/mod.ts";
import type { Member, Reached } from "../../contract.ts";
import type { Roster } from "./agents.tsx";
import { STYLE } from "./style.ts";
import { listed, spaceName } from "./who.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

/** An agent named, as it shows, and whether it's there already, only reading. */
type Named = { id: string; name: string; icon?: string; reads: boolean };

export const notHereView = (_: unknown, ctx: ViewContext<ReactNode>): ReactNode => {
  const id = typeof ctx.hints.in === "string" ? ctx.hints.in : "";
  const names = Array.isArray(ctx.hints.names) ? ctx.hints.names as string[] : [];
  const said = typeof ctx.hints.message === "string" ? ctx.hints.message : "";
  const resend = ctx.hints.resend as (() => Promise<void>) | undefined;
  const dismiss = ctx.hints.dismiss as (() => void) | undefined;
  const spaces = ctx.db.collection("space").query<Reached[]>("reached", {}).value;
  // What the names are: those the person meets that are agents, and who answers there.
  const team = id && names.length
    ? ctx.db.collection("thread").query<Roster>("agents", { in: id, names }).value
    : undefined;
  const members = id ? ctx.db.collection<Member>("member").find({ space: id }).value : [];
  if (!spaces || (id && names.length && !team) || !members) return null;
  const space = spaces.find((s) => s._id === id);
  const away = names.flatMap((name): Named[] => {
    const agent = team?.agents[name];
    if (!agent || team?.here.includes(name)) return [];
    const reads = members.some((m) => m.member === `agent:${name}`);
    return [{
      id: name,
      name: agent.name || name,
      ...(agent.icon ? { icon: agent.icon } : {}),
      reads,
    }];
  });
  return (
    <>
      <style href="spaces-web" precedence="copilotz">{STYLE}</style>
      {away.length && space
        ? (
          <NotHere
            away={away}
            space={space}
            call={ctx.call}
            resend={resend}
            dismiss={dismiss}
          />
        )
        : (
          <Notice
            tone="warning"
            role="alert"
            className="space-not-here"
            action={dismiss
              ? <Button size="sm" variant="ghost" onClick={dismiss}>OK</Button>
              : null}
          >
            {said || "Nothing was sent: it named someone who doesn't answer here."}
          </Notice>
        )}
    </>
  );
};

function NotHere(
  { away, space, call, resend, dismiss }: {
    away: Named[];
    space: Reached;
    call: Call;
    resend?(): Promise<void>;
    dismiss?(): void;
  },
): ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const one = away.length === 1;
  const who = listed(away.map((a) => a.name));
  const where = spaceName(space);
  const manage = space.can.includes("manage") && !space.archived;
  // Already there, only reading: it answers once it's an editor.
  const reads = away.every((a) => a.reads);
  const add = async () => {
    setBusy(true);
    setError(undefined);
    try {
      for (const a of away) {
        await call("member.set", {
          space: space._id,
          member: { kind: "agent", id: a.id },
          role: "editor",
        });
      }
      await resend?.();
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  };
  return (
    <Notice
      tone="info"
      icon={false}
      role="status"
      className="space-not-here"
      title={
        <span className="space-not-here-title">
          <span className="space-not-here-faces" aria-hidden="true">
            {away.slice(0, 3).map((a) => (
              <Avatar key={a.id} name={a.name} kind="agent" icon={a.icon} size={22} />
            ))}
          </span>
          {reads
            ? `${who} only ${one ? "reads" : "read"} ${where}`
            : `${who} ${one ? "doesn't" : "don't"} work in ${where}`}
        </span>
      }
      action={manage
        ? (
          <>
            {dismiss
              ? (
                <Button size="sm" variant="ghost" onClick={dismiss} disabled={busy}>
                  Not now
                </Button>
              )
              : null}
            <Button
              size="sm"
              variant="primary"
              icon="plus"
              loading={busy}
              onClick={() => void add()}
            >
              {reads
                ? `Make ${one ? who : "them"} ${one ? "an editor" : "editors"} and send`
                : `Add ${one ? who : "them"} and send`}
            </Button>
          </>
        )
        : dismiss
        ? <Button size="sm" variant="ghost" onClick={dismiss}>OK</Button>
        : null}
    >
      {error ??
        (manage
          ? reads
            ? `Your message is waiting: as ${one ? "an editor" : "editors"}, ${
              one ? "it answers" : "they answer"
            } here too, and it goes as it is.`
            : `Your message is waiting: add ${one ? "it" : "them"} to ${where}, as ${
              one ? "an editor" : "editors"
            }, and it goes as it is.`
          : `Your message wasn't sent. Ask someone who manages ${where} to ${
            reads ? `make ${one ? "it an editor" : "them editors"}` : `add ${one ? "it" : "them"}`
          }, or send it without the @.`)}
    </Notice>
  );
}
