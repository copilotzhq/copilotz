/**
 * Computers in a terminal, in the space you're in: `/computers` lists its
 * computers (the one its agents use first) and yours that aren't in it;
 * `/computer connect` gives a code to connect one to it (and the command to
 * run on it); `/computer share <n>`, `unshare <n>` and `default <n>` put one
 * of yours in it, take one out, and pick the one agents use; `rename` and
 * `forget` your own. `/approvals` lists what agents wait on you for (it
 * shows above where you type too), and `/approve [n] [once|thread|always|no]`
 * answers (n: which, when several).
 */
import { command, type Commands, dim, type Terminal } from "../../../../hosts/terminal/mod.ts";
import type { Approval } from "../collections/approval.ts";
import type { Computer } from "../collections/computer.ts";
import type { Desk } from "../collections/desk.ts";
import { installCommand } from "../program/release.ts";
import { asker, asks } from "../shared/asks.ts";
import { nameOf } from "../../../access/spaces/contract.ts";

const ANSWERS: Record<string, string> = {
  once: "once",
  thread: "thread",
  conversation: "thread",
  always: "always",
  no: "deny",
  deny: "deny",
};

/** One line of `/computers`: a computer in this space (a desk), or one of yours that isn't. */
type Listed = {
  desk?: Desk;
  computer: Pick<Computer, "_id" | "name" | "online" | "info" | "owner">;
};

/** This space's computers (its default first), then yours that aren't in it: what numbers pick. */
async function listed(
  term: Terminal,
): Promise<{ space?: string; all: Listed[]; names: Record<string, string> }> {
  const space = (await term.state()).space;
  const here = space ? await term.runtime.query<Desk[]>("desk.here", { in: space }) : [];
  const mine = await term.runtime.query<Computer[]>("computer.mine", {});
  return {
    ...(space ? { space } : {}),
    names: await namesOf(term, here.map((d) => d.owner)),
    all: [
      ...here.map((desk) => ({
        desk,
        computer: {
          _id: desk.computer,
          name: desk.name,
          online: desk.online,
          info: desk.info,
          owner: desk.owner,
        },
      })),
      ...mine.filter((c) => !here.some((d) => d.computer === c._id)).map((computer) => ({
        computer,
      })),
    ],
  };
}

/** People by name, as their spaces' profiles say. */
const namesOf = (term: Terminal, ids: string[]) =>
  ids.length
    ? term.runtime.query<Record<string, string>>("profile.names", { ids: [...new Set(ids)] })
    : Promise.resolve({});

const line = (l: Listed, i: number, me: string, names: Record<string, string>) => {
  const info = l.computer.info as { os?: string } | undefined;
  return `${dim(`[${i + 1}]`)} ${l.computer.name ?? l.computer._id} ${
    l.computer.online ? "● online" : dim("offline")
  }${
    dim(
      [
        info?.os,
        l.computer.owner === me ? "yours" : `${nameOf(l.computer.owner, names)}'s`,
        l.desk?.default ? "used here" : undefined,
        l.desk ? undefined : "not in this space",
      ].filter(Boolean).map((part) => ` · ${part}`).join(""),
    )
  }`;
};

export const commands: Commands = {
  "/computers": command({
    description: "This space's computers, where its agents work, and yours",
    async run(_, term) {
      const { all, names } = await listed(term);
      if (!all.length) {
        return await term.print(
          dim("None yet; /computer connect connects this machine or another to this space."),
        );
      }
      await term.print(
        all.map((l, i) => line(l, i, term.me, names)).join("\n") + "\n" +
          dim("/computer share <n> · unshare <n> · default <n> · rename <n> <name> · forget <n>"),
      );
    },
  }),
  "/computer": command({
    description: "Connect a computer to this space, share or take one out, rename or forget one",
    usage: "connect | share <n> | unshare <n> | default <n> | rename <n> <name> | forget <n>",
    async run(rest, term) {
      const [what, n, ...name] = rest.trim().split(/\s+/);
      const { space, all, names } = await listed(term);
      if (what === "connect") {
        const { code, expires, url, folder, downloads } = await term.runtime.call<
          {
            code: string;
            expires: string;
            url?: string;
            folder?: string;
            downloads?: { base: string };
          }
        >("computer.code", space ? { in: space } : {});
        const minutes = Math.round((Date.parse(expires) - Date.now()) / 60_000);
        const app = url ?? "<app url>";
        // From the app's release when it has one; else from a copy of the app's code.
        const base = downloads && url ? new URL(downloads.base, url).href : undefined;
        return await term.print(
          `On the computer this space's agents should use, run:\n\n` +
            (base
              ? `  ${installCommand("sh", { app, code, base, folder })}\n\n` +
                `On Windows, in PowerShell:\n\n` +
                `  ${installCommand("powershell", { app, code, base, folder })}\n\n` +
                dim(
                  "It installs the computer program, connects it, and keeps it running (from " +
                    "login on). Their folders go under ~/Copilotz there. ",
                )
              : `  deno task computer connect ${app} --code ${code}${
                folder ? ` --folder ${folder}` : ""
              }\n\n` +
                dim("Their folders go under ~/Copilotz there (--root puts them elsewhere). ")) +
            dim(`The code works once, for ${minutes} minutes.`),
        );
      }
      const chosen = all[Number(n) - 1];
      if (!chosen) return await term.print(dim("Which one? /computers lists them."));
      const named = chosen.computer.name ?? chosen.computer._id;
      if (what === "share") {
        if (!space) return await term.print(dim("Open a space first: /space."));
        await term.runtime.call("computer.share", { computer: chosen.computer._id, in: space });
        return await term.print(
          dim(
            `${named} is in this space now: its members and their agents use it, as you, on ` +
              "it. Commands they run ask them first (/approve).",
          ),
        );
      }
      if (what === "unshare" || what === "default") {
        if (!chosen.desk) return await term.print(dim(`${named} isn't in this space.`));
        await term.runtime.call(`computer.${what}`, { desk: chosen.desk._id });
        return await term.print(
          dim(
            what === "unshare"
              ? `${named} is out of this space; its folder stays on it.`
              : `This space's agents use ${named}.`,
          ),
        );
      }
      if (chosen.computer.owner !== term.me) {
        return await term.print(dim(`${named} is ${nameOf(chosen.computer.owner, names)}'s.`));
      }
      if (what === "rename" && name.length) {
        await term.runtime.call("computer.rename", {
          computer: chosen.computer._id,
          name: name.join(" "),
        });
        return await term.print(dim(`Renamed it ${name.join(" ")}.`));
      }
      if (what === "forget") {
        await term.runtime.call("computer.forget", { computer: chosen.computer._id });
        return await term.print(dim(`Forgot ${named}; its files stay on it.`));
      }
      await term.print(
        dim(
          "/computer connect | share <n> | unshare <n> | default <n> | rename <n> <name> | forget <n>",
        ),
      );
    },
  }),
  "/approvals": command({
    description: "What your agents wait on you for, on your computers",
    async run(_, term) {
      const waiting = await term.runtime.query<Approval[]>("approval.pending", {});
      if (!waiting.length) return await term.print(dim("Nothing waits on you."));
      const names = await namesOf(term, waiting.flatMap((a) => a.for ? [a.for] : []));
      await term.print(
        waiting.map((a, i) =>
          `${dim(`[${i + 1}]`)} ${asker(a, term.me, names)} wants to ${asks(a)}${
            a.name ? dim(` on ${a.name}`) : ""
          }`
        ).join("\n") +
          `\n${dim("/approve <n> once|thread|always|no")}`,
      );
    },
  }),
  "/approve": command({
    description: "Answer what an agent waits on you for (once, this conversation, always, or no)",
    usage: "[n] [once|thread|always|no]",
    async run(rest, term) {
      const words = rest.trim().split(/\s+/).filter(Boolean);
      const n = /^\d+$/.test(words[0] ?? "") ? Number(words.shift()) : undefined;
      const answer = ANSWERS[words[0] ?? "once"];
      const waiting = await term.runtime.query<Approval[]>("approval.pending", {});
      if (!waiting.length) return await term.print(dim("Nothing waits on you."));
      const chosen = n ? waiting[n - 1] : waiting.length === 1 ? waiting[0] : undefined;
      if (!chosen || !answer) {
        return await term.print(
          dim(
            chosen
              ? "/approve [n] once|thread|always|no"
              : "Several wait: /approvals lists them; /approve <n> once|thread|always|no",
          ),
        );
      }
      const { answered } = await term.runtime.call<{ answered: boolean }>("computer.approve", {
        approval: chosen._id,
        answer,
      });
      await term.print(
        dim(answered ? "Answered; the agent carries on." : "It was answered already."),
      );
    },
  }),
};
