/**
 * Spaces in a terminal: `/spaces` lists those you reach, `/space <name>`
 * makes one and works there, `/work <n|id>` works in another, and
 * `/invite <email> [role]` invites someone where you work (an agent joins
 * at once: `/invite agent:north editor`), `/remove agent:north` takes one
 * out. `/invitations` lists those to you, to `/accept <n>` or `/decline <n>`.
 * Agents (with the chat plugin): `/agents` lists who works here, `/agent
 * Maya: what it does` makes one here, `/default maya` has it answer new chats.
 */
import { command, type Commands, dim } from "../../../../hosts/terminal/mod.ts";
import type { Invitation } from "../collections/invitation.ts";
import type { Request } from "../collections/request.ts";

type Space = { _id: string; name: string; kind: string };
type Here = {
  here: string[];
  default: string[];
  agents: Record<string, { name?: string; description?: string }>;
};

export const commands: Commands = {
  "/spaces": command({
    description: "The spaces you reach (● where you work)",
    async run(_, term) {
      const spaces = await term.runtime.query<Space[]>("space.reached", {});
      await term.set({ listed: spaces.map((s) => s._id) });
      if (!spaces.length) return await term.print(dim("No spaces yet; /space <name> makes one."));
      const { space } = await term.state();
      await term.show("spaces", { spaces, ...(space ? { here: space } : {}) });
      await term.print(dim("/work <n> works in one; new conversations go there."));
    },
  }),
  "/space": command({
    description: "Make a space and work in it",
    usage: "<name>",
    async run(name, term) {
      if (!name) return await term.print(dim("Name it: /space <name>"));
      const { space } = await term.runtime.call<{ space: string }>("space.create", { name });
      await term.set({ space, open: null });
      await term.print(dim(`You work in ${name} now; /invite <email> [role] asks others in.`));
    },
  }),
  "/work": command({
    description: "Work in a space you reach, by number or id",
    usage: "<n|id>",
    async run(rest, term) {
      const listed = (await term.state()).listed ?? [];
      const spaces = await term.runtime.query<Space[]>("space.reached", {});
      const id = listed[Number(rest) - 1] ?? spaces.find((s) => s._id === rest)?._id;
      const space = spaces.find((s) => s._id === id);
      if (!space) return await term.print(dim("No such space; /spaces lists them."));
      await term.set({ space: space._id, open: null });
      await term.print(dim(`You work in ${space.name} now.`));
    },
  }),
  "/requests": command({
    description: "Requests to join the spaces you manage",
    async run(_, term) {
      const open = await term.runtime.query<Request[]>("request.open", {});
      await term.set({ listed: open.map((r) => r._id) });
      if (!open.length) return await term.print(dim("No requests."));
      await term.print(
        open.map((r, i) =>
          `${dim(`[${i + 1}]`)} ${r.member.split(":")[1]} → ${r.space} ${
            dim(`(${r.by ?? "themselves"}: ${r.reason ?? "no reason given"})`)
          }`
        ).join("\n") + `\n${dim("/grant <n> [role] lets them in; /deny <n> doesn't.")}`,
      );
    },
  }),
  "/grant": command({
    description: "Let in whoever a request is for",
    usage: "<n> [role]",
    async run(rest, term) {
      const [n, role] = rest.split(" ").filter(Boolean);
      const id = (await term.state()).listed?.[Number(n) - 1];
      if (!id) return await term.print(dim("No such request; /requests lists them."));
      const { granted } = await term.runtime.call<{ granted: string }>("request.grant", {
        id,
        ...(role ? { role } : {}),
      });
      await term.print(dim(`${granted.split(":")[1]} is in.`));
    },
  }),
  "/deny": command({
    description: "Turn a request down",
    usage: "<n>",
    async run(rest, term) {
      const id = (await term.state()).listed?.[Number(rest) - 1];
      if (!id) return await term.print(dim("No such request; /requests lists them."));
      await term.runtime.call("request.deny", { id });
      await term.print(dim("Turned down."));
    },
  }),
  "/invite": command({
    description: "Invite someone where you work, by email (viewer, editor, manager)",
    usage: "<email|agent:name> [role]",
    async run(rest, term) {
      const [who, role = "editor"] = rest.split(" ").filter(Boolean);
      const { space } = await term.state();
      if (!who || !space) {
        return await term.print(dim("Usage: /invite <email> [role], in a space."));
      }
      if (who.startsWith("agent:")) {
        const id = who.slice("agent:".length);
        await term.runtime.call("member.set", { space, member: { kind: "agent", id }, role });
        return await term.print(
          dim(`${id} is ${role === "editor" ? "an" : "a"} ${role} here now.`),
        );
      }
      await term.runtime.call("invitation.send", { space, email: who, role });
      await term.print(dim(`Invited ${who}; they join once they accept.`));
    },
  }),
  "/remove": command({
    description: "Take someone out of where you work (an agent: agent:maya)",
    usage: "<agent:name|name>",
    async run(rest, term) {
      const { space } = await term.state();
      const who = rest.trim();
      if (!who || !space) return await term.print(dim("Usage: /remove agent:<name>, in a space."));
      const [kind, id] = who.includes(":") ? who.split(":", 2) : ["person", who];
      await term.runtime.call("member.remove", { space, member: { kind, id } });
      await term.print(dim(`${id} is out of this space.`));
    },
  }),
  "/agents": command({
    description: "The agents working where you work (● answers new chats)",
    async run(_, term) {
      const { space } = await term.state();
      const team = await term.runtime.query<Here>("thread.agents", space ? { in: space } : {});
      if (!team.here.length) {
        return await term.print(
          dim("No agent works here; /agent <Name>: <what it does> makes one."),
        );
      }
      await term.print(
        team.here.map((name) => {
          const a = team.agents[name];
          return `${team.default.includes(name) ? "●" : " "} @${name}${a.name ? ` ${a.name}` : ""}${
            a.description ? dim(` — ${a.description}`) : ""
          }`;
        }).join("\n") +
          `\n${dim("/agent <Name>: <what it does> makes one; /default <name> answers new chats.")}`,
      );
    },
  }),
  "/agent": command({
    description: "Make an agent where you work, and have it work here",
    usage: "<Name>: <what it does>",
    async run(rest, term) {
      const { space } = await term.state();
      const at = rest.indexOf(":");
      const name = (at < 0 ? rest : rest.slice(0, at)).trim();
      const description = at < 0 ? "" : rest.slice(at + 1).trim();
      if (!name || !space) {
        return await term.print(dim("Usage: /agent <Name>: <what it does>, in a space."));
      }
      const { agent } = await term.runtime.call<{ agent: string }>("agent.create", {
        in: space,
        name,
        ...(description ? { description } : {}),
      });
      await term.runtime.call("member.set", {
        space,
        member: { kind: "agent", id: agent },
        role: "editor",
      });
      await term.print(dim(`${name} works here now: @${agent}.`));
    },
  }),
  "/default": command({
    description: "Have an agent working here answer new chats",
    usage: "<name>",
    async run(rest, term) {
      const { space } = await term.state();
      const agent = rest.trim().replace(/^@/, "");
      if (!agent || !space) return await term.print(dim("Usage: /default <name>, in a space."));
      await term.runtime.call("space.agent", { space, agent });
      await term.print(dim(`@${agent} answers new chats here.`));
    },
  }),
  "/invitations": command({
    description: "Invitations to spaces, sent to your email",
    async run(_, term) {
      const mine = await term.runtime.query<Invitation[]>("invitation.mine", {});
      await term.set({ listed: mine.map((i) => i._id) });
      if (!mine.length) return await term.print(dim("No invitations."));
      await term.print(
        mine.map((i, n) =>
          `${dim(`[${n + 1}]`)} ${i.name} ${dim(`(${i.role}, from ${i.by.split(":")[1]})`)}`
        ).join("\n") + `\n${dim("/accept <n> joins; /decline <n> doesn't.")}`,
      );
    },
  }),
  "/accept": command({
    description: "Join the space an invitation is for",
    usage: "<n>",
    async run(rest, term) {
      const invitation = (await term.state()).listed?.[Number(rest) - 1];
      if (!invitation) return await term.print(dim("No such invitation; /invitations lists them."));
      const { space } = await term.runtime.call<{ space: string }>("invitation.accept", {
        invitation,
      });
      await term.set({ space, open: null });
      await term.print(dim("You're in, and work there now."));
    },
  }),
  "/decline": command({
    description: "Turn an invitation down",
    usage: "<n>",
    async run(rest, term) {
      const invitation = (await term.state()).listed?.[Number(rest) - 1];
      if (!invitation) return await term.print(dim("No such invitation; /invitations lists them."));
      await term.runtime.call("invitation.decline", { invitation });
      await term.print(dim("Turned down."));
    },
  }),
};
