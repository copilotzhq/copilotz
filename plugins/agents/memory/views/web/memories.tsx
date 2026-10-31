/**
 * What agents remember (kind `memories`), newest first, as the person may
 * read them (`memory.list`): grouped by whom each is about, core ones
 * starred, each with who wrote it, when and the chat it came from.
 * Searchable; core ones alone, on a tap. Agents show as they're named, with
 * their emoji (chat's `agentsShown`). Given a space (item `{ _id }`: a
 * space's Memories tab, `hints.mode: "page"`, or beside a chat, `"panel"`),
 * what was learned there, under the space's own header; at `/memories`,
 * everything, as a page of its own, each saying where it was learned.
 */
import type { ReactNode } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import { Page, Skeleton, Title } from "../../../../../hosts/web/mod.ts";
import { agentsShown } from "../../../chat/contract.ts";
import type { Memory } from "../../collections/memory.ts";
import { peopleOf } from "../../shared/scope.ts";
import { MemoryList, type Named } from "./list.tsx";
import { STYLE } from "./style.ts";
import { namesIn } from "../../../../access/spaces/contract.ts";

type Space = { _id: string; name: string; kind: string };

export const memoriesView = (item: { _id?: string }, ctx: ViewContext<ReactNode>): ReactNode => {
  const space = item._id;
  const memories = ctx.db.collection("memory").query<Memory[]>("list", {
    limit: 200,
    ...(space ? { in: space } : {}),
  }).value;
  // The spaces the person reaches, read directly (the rules keep it to those).
  const spaces = space ? [] : ctx.db.collection<Space>("space").find({}).value ?? [];
  const named = Object.fromEntries(
    spaces.map((p) => [p._id, p.kind === "personal" ? "Personal" : p.name]),
  );
  // The agents they're about or by, as each is named.
  const ids = (memories ?? []).flatMap((m) => [
    ...(m.about.startsWith("agent:") ? [m.about.slice(6)] : []),
    ...(m.by !== "memory" ? [m.by] : []),
  ]);
  const met = memories ? agentsShown(ctx, ids) : {};
  // People by name: whom they're about, who wrote them, and whom older ones name by id.
  const names = namesIn(
    ctx,
    (memories ?? []).flatMap(peopleOf),
  );
  const agents: Record<string, Named> = Object.fromEntries(
    Object.entries(met ?? {}).map(([id, a]) => [id, { name: a.name || id, icon: a.icon }]),
  );
  const mode = ctx.hints.mode;
  const list = memories === undefined || met === undefined
    ? (
      <ul className="mem-list" aria-busy="true">
        {[0, 1, 2].map((i) => <Skeleton key={i} as="li" height={66} radius="xl" />)}
      </ul>
    )
    : (
      <MemoryList
        memories={memories}
        spaces={named}
        agents={agents}
        names={names}
        me={ctx.viewer?.name}
        fresh={space ? `/?in=${encodeURIComponent(space)}` : "/"}
        compact={mode === "panel"}
        call={ctx.call}
      />
    );
  const style = <style href="memory-web" precedence="copilotz">{STYLE}</style>;
  // A space's tab: its page is the frame.
  if (space && (mode === "page" || mode === "panel")) {
    return (
      <div className={`mem-tab${mode === "panel" ? " mem-tab-compact" : ""}`}>
        {style}
        {mode === "page" && memories?.length
          ? (
            <p className="mem-intro">
              What agents learned in this space. <span className="mem-star">★</span>{" "}
              Core memories are always in mind; the rest come up when they're relevant.
            </p>
          )
          : null}
        {list}
      </div>
    );
  }
  return (
    <Page
      title="Memories"
      density={mode === "panel" ? "panel" : "full"}
      description={
        <>
          What agents remember across chats. <span className="mem-star">★</span>{" "}
          Core memories are always in mind; the rest come up when they're relevant.
        </>
      }
    >
      {style}
      <Title text="Memories" />
      {list}
    </Page>
  );
};
