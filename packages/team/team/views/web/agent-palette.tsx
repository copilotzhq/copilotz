/**
 * What agents offer in the command palette (kind `agent.palette`, the web
 * shell's `palette` resource), for where the person is and what's typed:
 *
 * - **This agent**, on an agent's page: ask it, have it answer new chats
 *   where the person is, add it to another space they manage, change it
 *   or delete it (those who manage where it belongs).
 * - **This space:** add an agent to it (the invite surface's Agents, in a
 *   dialog), for those who manage it; while searching, have one of its
 *   agents answer its new chats.
 * - **Agents** to go to (their pages): those working where the person is;
 *   while searching, every agent they've met.
 * - **Create:** a new agent, where they are if they manage it, or in a
 *   space they pick.
 */
import type { ReactNode } from "react";
import type { ViewContext } from "copilotz";
import { Avatar, go, type PaletteControl, type PaletteGroup, type PaletteItem } from "copilotz/web";
import type { Agent, Team } from "copilotz/plugins/agents/contract";
import { deleteStep, spaceStep } from "./agent-steps.tsx";
import { agentPath, shownAs } from "./agents.ts";
import { managed, manages, type Place, placeName, placePath } from "./places.ts";
import { say } from "./words.ts";

/** How many agents show with nothing typed, and while searching. */
const SHOWN = { idle: 4, searching: 8 };

/** The agent page open, and where it's a member: what its own items need. */
type Seat = { _id: string; space: string; role: string; on?: string };

export const agentPaletteView = (
  _: unknown,
  ctx: ViewContext<ReactNode>,
): PaletteGroup[] | null => {
  const searching = !!String(ctx.hints.search ?? "").trim();
  const space = typeof ctx.hints.in === "string" ? ctx.hints.in : undefined;
  const page = (ctx.hints.page ?? {}) as { kind?: string; id?: string };
  const open = page.kind === "agent" ? page.id : undefined;
  const places = ctx.db.collection("space").query<Place[]>("reached", {}).value;
  const known = ctx.db.collection("agent").query<Record<string, Agent>>("known", {}).value;
  const roster = space
    ? ctx.db.collection("thread").query<Team>("agents", { in: space }).value
    : { here: [], default: [], agents: {} };
  const seats = open
    ? ctx.db.collection<Seat>("member").find({ member: `agent:${open}` }).value
    : [];
  if (!places || !known || !roster || !seats) return null;
  const call = ctx.call;
  const here = places.find((p) => p._id === space);
  const mine = managed(places);
  const groups: PaletteGroup[] = [];
  const leading = (id: string, agent?: Agent) => {
    const { name, icon } = shownAs(id, agent);
    return <Avatar name={name} kind="agent" icon={icon} size={26} />;
  };
  // A new agent in a space: a dialog with its form.
  const make = (place: Place, palette: PaletteControl, from?: string) =>
    palette.dialog({
      title: say("newAgentIn", { place: placeName(place) }),
      ...(from
        ? { description: say("startingFrom", { name: shownAs(from, known[from]).name }) }
        : {}),
      view: "agent.add",
      item: { _id: place._id },
      hints: { in: place._id, mode: "new", ...(from ? { from } : {}) },
    });

  if (open && known[open]) {
    const agent = known[open];
    const { name } = shownAs(open, agent);
    const home = agent.in ? places.find((p) => p._id === agent.in) : undefined;
    const working = seats.filter((s) => !s.on);
    const seatHere = here && working.find((s) => s.space === here._id);
    const elsewhere = mine.filter((p) => !working.some((s) => s.space === p._id));
    const items: PaletteItem[] = [];
    if (here && seatHere?.role === "editor" && manages(here) && here.agent !== open) {
      items.push({
        key: "agent:answers",
        label: say("makeNamedAnswerIn", { name, place: placeName(here) }),
        icon: "chat",
        keywords: [say("keywordDefault"), say("keywordAnswer"), say("keywordNewChats")],
        run: () => call("space.agent", { space: here._id, agent: open }),
      });
    }
    if (elsewhere.length) {
      items.push({
        key: "agent:add-to",
        label: say("addNamedTo", { name }),
        icon: "plus",
        keywords: [say("keywordMember"), say("keywordJoin"), say("keywordWork")],
        step: spaceStep({
          title: say("addToTitle", { name }),
          note: say("addNamedNote"),
          places: elsewhere,
          pick: (place) =>
            call("member.set", {
              space: place._id,
              member: { kind: "agent", id: open },
              role: "editor",
            }),
        }),
      });
    }
    if (home && manages(home)) {
      items.push({
        key: "agent:edit",
        label: say("editNamed", { name }),
        icon: "pencil",
        keywords: [say("keywordChange"), say("keywordInstructions"), say("keywordRename")],
        href: agentPath(open, true),
      });
      items.push({
        key: "agent:delete",
        label: say("deleteMenu", { name }),
        icon: "trash",
        tone: "destructive",
        step: deleteStep({
          agent: open,
          name,
          call,
          after: () => go(placePath(home._id, "members")),
        }),
      });
    }
    if (!agent.in && mine.length) {
      items.push({
        key: "agent:from",
        label: say("startNewFrom", { name }),
        icon: "sparkles",
        keywords: [say("keywordCopy"), say("keywordLike"), say("keywordCreate")],
        step: spaceStep({
          title: say("newLikeTitle", { name }),
          places: mine,
          pick: (place, palette) => make(place, palette, open),
        }),
      });
    }
    if (items.length) groups.push({ title: say("paletteThisAgent"), order: 10, items });
  }

  if (here && manages(here) && !here.archived && !open) {
    const name = placeName(here);
    const items: PaletteItem[] = [{
      key: "agent:add",
      label: say("addAnAgentTo", { place: name }),
      icon: "bot",
      keywords: [say("keywordMember"), say("keywordInvite"), say("keywordAgent")],
      run: (palette) =>
        palette.dialog({
          title: say("addAnAgentTitle", { place: name }),
          description: say("addAnAgentNote"),
          view: "agent.add",
          item: { _id: here._id },
          hints: { in: here._id },
        }),
    }];
    if (searching) {
      for (const id of roster.here) {
        if (roster.default.includes(id)) continue;
        const { name: agent } = shownAs(id, roster.agents[id]);
        items.push({
          key: `agent:answers:${id}`,
          label: say("makeNamedAnswer", { name: agent }),
          leading: leading(id, roster.agents[id]),
          description: name,
          keywords: [say("keywordDefault"), say("keywordAnswer"), id],
          run: () => call("space.agent", { space: here._id, agent: id }),
        });
      }
    }
    groups.push({ title: say("paletteThisSpace"), order: 10, items });
  }

  // Agents to go to: those here first (who answers new chats first), then, searching, all met.
  const ids = [
    ...roster.here,
    ...(searching ? Object.keys(known).filter((id) => !roster.here.includes(id)) : []),
  ].filter((id) => id !== open);
  groups.push({
    title: say("paletteAgents"),
    order: 25,
    limit: searching ? SHOWN.searching : SHOWN.idle,
    items: ids.map((id) => {
      const agent = roster.agents[id] ?? known[id];
      const { name } = shownAs(id, agent);
      return {
        key: `agent:${id}`,
        label: name,
        leading: leading(id, agent),
        description: roster.default.includes(id)
          ? say("answersNewChatsHere")
          : roster.here.includes(id)
          ? say("worksHere", { id })
          : `@${id}`,
        keywords: [id, agent?.description ?? "", say("keywordAgent")].filter(Boolean),
        href: agentPath(id),
      };
    }),
  });

  if (mine.length) {
    const inHere = here && manages(here) && !here.archived ? here : undefined;
    groups.push({
      title: say("paletteCreate"),
      order: 40,
      items: [
        inHere
          ? {
            key: "agent:new",
            label: say("newAgent"),
            icon: "bot",
            description: say("newAgentInHere", { place: placeName(inHere) }),
            keywords: [say("keywordCreate"), say("keywordMake"), say("keywordAgent")],
            run: (palette) => make(inHere, palette),
          }
          : {
            key: "agent:new",
            label: say("newAgentInStep"),
            icon: "bot",
            keywords: [say("keywordCreate"), say("keywordMake"), say("keywordAgent")],
            step: spaceStep({
              title: say("newAgentInStep"),
              note: say("newAgentInNote"),
              places: mine,
              pick: (place, palette) => make(place, palette),
            }),
          },
      ],
    });
  }
  return groups;
};
