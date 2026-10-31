/**
 * What an agent with computer tools knows each turn (the `computer`
 * context): that it works on this space's computers (whose they are), not a
 * machine of its own; where there are several, each (whose, a cloud computer
 * or someone's own machine, how it is now, its system, what it asks first)
 * and which is the default, as its tools take `computer` to use another;
 * where its folder is; what waits for a yes, from whom, and where they
 * answer.
 */
import type { ViewContext } from "../../../../runtime/mod.ts";
import { agentsShown, type Thread } from "../../../agents/chat/contract.ts";
import type { Desk } from "../collections/desk.ts";
import { OS_NAMES } from "../program/release.ts";
import { tools } from "../resources/tools.ts";
import { personOf } from "../shared/person.ts";
import { settingsOf } from "../shared/settings.ts";
import { nameOf, stateOf } from "../shared/where.ts";

const ASKED = { terminal: "run commands", jobs: "start jobs", writes: "write or edit files" };

/** A shell, by its path: bash, PowerShell 7 (`pwsh`) or Windows PowerShell. */
const shellOf = (path: string) =>
  /pwsh(\.exe)?$/i.test(path)
    ? "PowerShell 7 (pwsh): write PowerShell"
    : /powershell(\.exe)?$/i.test(path)
    ? "Windows PowerShell 5.1: write PowerShell"
    : "bash";

type Info = { os?: string; root?: string; windows?: string; shell?: string };

/** One of several computers, in a line: what it is, how it is, what it asks first. */
function lineOf(desk: Desk, person: string, asked: string[]): string {
  const info = desk.info as Info | undefined;
  const whose = desk.owner === person ? `${nameOf(person)}'s own` : `${nameOf(desk.owner)}'s`;
  const kind = desk.status?.kind === "cloud" ? "a cloud computer" : "a machine";
  const system = info?.os
    ? `, ${OS_NAMES[info.os] ?? info.os}${info.shell ? ` (${shellOf(info.shell)})` : ""}`
    : "";
  const state = stateOf(desk);
  const how = state === "online"
    ? "online"
    : state === "asleep"
    ? "asleep: using it wakes it, in a few seconds"
    : state === "waking"
    ? "waking"
    : `offline until ${nameOf(desk.owner)} starts it again`;
  const answerer = desk.answers === "owner" ? desk.owner : person;
  const asks = asked.length
    ? `${nameOf(answerer)} says yes before you ${asked.join(", ")}`
    : "nothing needs a yes";
  return `- ${desk.name ?? desk.computer}${desk.default ? " (the default)" : ""}: ${kind}, ` +
    `${whose}${system}; ${how}; ${asks}.`;
}

export const contextViews = {
  "context:computer": {
    llm: (thread: Thread, ctx: ViewContext): string | undefined => {
      const name = ctx.viewer?.name ?? "";
      const agent = agentsShown(ctx, [name])?.[name];
      if (!agent?.tools?.some((name) => name in tools)) return undefined;
      const person = personOf(ctx.actor);
      if (!person || !thread.in) return undefined;
      const desks = ctx.db.collection<Desk>("desk").find({ in: thread.in }, {
        sort: { seen: -1 },
      });
      if (desks.status !== "ready") return undefined;
      const here = [...desks.value].sort((a, b) => Number(!!b.default) - Number(!!a.default));
      const askedOn = (d: Desk) => (d.approve ?? settingsOf(ctx).approve).map((w) => ASKED[w]);
      if (here.length > 1) {
        const asking = here.some((d) => askedOn(d).length);
        return [
          `This space has ${here.length} computers, not machines of yours. Your computer tools ` +
          "use the default unless you name another: each takes `computer` (its name). Choose " +
          "by what the work needs, or as your person asks:",
          ...here.map((d) => lineOf(d, person, askedOn(d))),
          "On each, your terminal, jobs and files are in its folder for this space, and your " +
          "browser and web searches run there too (the browser hidden, unless you show its " +
          "window on its owner's screen for them to watch or step in). A job runs on the " +
          "computer that started it: give that one to its logs, to stop it, or to preview it.",
          ...(asking
            ? [
              "Where a yes is needed, the tool asks, and you wait. They see your request where " +
              "they talk with you and answer there (on the web, a card in the conversation; in " +
              "the terminal, a line above where they type, answered with /approve). Reading " +
              "files, listing and searching need no yes.",
            ]
            : []),
        ].join("\n");
      }
      const desk = here.find((d) => d.online);
      if (!desk) {
        // Where something wakes computers (cloud computers), using one that's asleep wakes it.
        if (here.length && (ctx.resources.computerWake as { wake?: string } | undefined)?.wake) {
          return `This space's computer, ${here[0].name ?? "theirs"}, is offline or asleep. ` +
            "If the app hosts it (a cloud computer), your computer tools wake it: the first " +
            `call waits a few seconds. If not, they won't work until ${
              nameOf(here[0].owner)
            } starts it again.`;
        }
        return here.length
          ? `This space's computer, ${here[0].name ?? "theirs"}, is offline, so your computer ` +
            `tools won't work until ${
              nameOf(here[0].owner)
            } starts it again (on it: deno task computer).`
          : "This space has no computer, so your computer tools won't work until someone " +
            "connects one, or adds one of theirs (in the terminal: /computer connect or " +
            "/computer share; on the web: the space's Computer tab).";
      }
      const owned = desk.owner === person ? `${nameOf(person)}'s own` : `${nameOf(desk.owner)}'s`;
      const info = desk.info as Info | undefined;
      const sep = info?.os === "win32" ? "\\" : "/";
      const asked = askedOn(desk);
      const answerer = nameOf(desk.answers === "owner" ? desk.owner : person);
      return [
        `You work on this space's computer, ${desk.name ?? "theirs"} (${owned}${
          info?.os ? `, ${OS_NAMES[info.os] ?? info.os}` : ""
        }), not on a machine of yours: your terminal, jobs and files are in its folder for ` +
        `this space (${info?.root ? `${info.root}${sep}${desk.folder}` : desk.folder}${
          info?.shell ? `; its shell is ${shellOf(info.shell)}` : ""
        }), and your ` +
        `browser and web searches run there too (${
          info?.windows === "never"
            ? "the browser hidden: its owner doesn't let it show windows"
            : "the browser hidden, unless you show its window on their screen for them to " +
              "watch or step in: to sign in, say"
        }).`,
        ...(asked.length
          ? [
            `Before you ${asked.join(", ")}, ${answerer} says yes: the tool asks them, and you ` +
            `wait. They see your request where they talk with you and answer there (on the ` +
            `web, a card in the conversation; in the terminal, a line above where they type, ` +
            `answered with /approve). Reading files, listing and searching need no yes.`,
          ]
          : []),
      ].join("\n");
    },
  },
};
