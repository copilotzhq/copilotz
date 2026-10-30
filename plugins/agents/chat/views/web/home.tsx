/**
 * Home (kind `home`): a new conversation, where the person works
 * (`hints.in`). A greeting, where you type, and a few ways to start (the
 * `suggestions` resource: strings an app adds to, or `null`s out). What you
 * send starts the conversation there, and opens it. Over the greeting, what
 * other front ends put there (the `home` resource: a View each, with hints
 * `{ in }`, such as invitations to join a space), nothing when they've
 * nothing to say. A space the person doesn't reach (a link someone else
 * shared) says so instead. `@` lists the agents answering there
 * (`thread.agents`); a message refused for a reason another front end
 * helps with shows its View (the `refusals` resource); `?to=maya` (an
 * agent's page's "Ask") starts with `@maya ` typed.
 */
import type { ReactNode } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import { EmptyState, go, Icon, Logo, Title } from "../../../../../hosts/web/mod.ts";
import type { Team } from "../../shared/agents.ts";
import type { HomeView, RefusalView } from "../../shared/types.ts";
import { mentionable } from "./agents.ts";
import { Composer } from "./composer.tsx";
import { STYLE } from "./style.ts";
import { greeted } from "./who.ts";

type Space = { _id: string; name: string; kind: string };

const greeting = (hour: number) =>
  hour < 5
    ? "Good evening"
    : hour < 12
    ? "Good morning"
    : hour < 18
    ? "Good afternoon"
    : "Good evening";

export const homeView = (_: unknown, ctx: ViewContext<ReactNode>): ReactNode => {
  const here = typeof ctx.hints.in === "string" ? ctx.hints.in : undefined;
  const space = here ? ctx.db.collection<Space>("space").findOne({ _id: here }).value : undefined;
  // Who answers there, for `@`.
  const team = ctx.db.collection("thread").query<Team>("agents", here ? { in: here } : {}).value;
  const to = String((ctx.hints.query as Record<string, unknown> | undefined)?.to ?? "");
  const suggestions = Object.values((ctx.resources.suggestions ?? {}) as Record<string, unknown>)
    .filter((s): s is string => typeof s === "string");
  const name = greeted(ctx.viewer?.label ?? ctx.viewer?.name ?? "");
  const shared = space && space.kind !== "personal";
  // What other front ends show over the greeting.
  const tops = Object.values((ctx.resources.home ?? {}) as Record<string, HomeView | null>)
    .filter((entry): entry is HomeView => !!entry?.view)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((entry) => ctx.show(entry.view, {}, here ? { in: here } : {}));
  if (here && space === null) {
    return (
      <section className="chat chat-missing" aria-labelledby="chat-home-title">
        <style href="chat-web" precedence="copilotz">{STYLE}</style>
        <Title text="Not your space" />
        <EmptyState icon="lock" heading="h1" id="chat-home-title" title="You're not in this space">
          Chats here are for its members. Pick one of your spaces to start one, or ask someone here
          to invite you.
        </EmptyState>
      </section>
    );
  }
  return (
    <section className="chat chat-home" aria-labelledby="chat-home-title">
      <style href="chat-web" precedence="copilotz">{STYLE}</style>
      <Title text={shared ? space.name : "New chat"} />
      <div className="chat-home-body">
        {tops.length ? <div className="chat-home-top">{tops}</div> : null}
        <div className="chat-home-hero">
          <Logo size={56} />
          <h1 id="chat-home-title">
            {greeting(new Date().getHours())}
            {name ? `, ${name}` : ""}
          </h1>
          <p>
            {shared
              ? (
                <>
                  What are we working on in <b>{space.name}</b>?
                </>
              )
              : "What can I help with?"}
          </p>
        </div>
        <Composer
          key={to}
          initial={to && team?.here.includes(to) ? `@${to} ` : undefined}
          agents={team ? mentionable(team) : undefined}
          where={space ? space.kind === "personal" ? "Personal" : space.name : undefined}
          refusals={ctx.resources.refusals as Record<string, RefusalView | null> | undefined}
          place={here ? { in: here } : {}}
          send={async (text, files, options) => {
            const sent = await ctx.call<{ thread: string }>("chat.send", {
              ...(text ? { text } : {}),
              ...(here ? { in: here } : {}),
              ...(files.length ? { files } : {}),
              ...options,
            });
            go(
              `/thread/${encodeURIComponent(sent.thread)}${
                here ? `?in=${encodeURIComponent(here)}` : ""
              }`,
            );
          }}
          placeholder="Ask anything; @name asks a particular agent"
          suggestions={suggestions}
          note={space
            ? (
              <span className="chat-home-where">
                <Icon name={shared ? "lock" : "person"} size={13} />
                {shared
                  ? `Starts in ${space.name}, for its members`
                  : "Starts in Personal, just for you"}
              </span>
            )
            : null}
        />
      </div>
    </section>
  );
};
