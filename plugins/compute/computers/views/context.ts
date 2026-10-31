/**
 * What an agent with computer tools knows each turn (the `computer`
 * context): that it works on this space's computer (whose it is), not a
 * machine of its own; whether that's online, and where its folder here is;
 * what waits for a yes, from whom, and where they answer; and the space's
 * environment its shell and jobs have, by name.
 */
import type { ViewContext } from "../../../../runtime/mod.ts";
import { agentsShown, type Thread } from "../../../agents/chat/contract.ts";
import type { Desk } from "../collections/desk.ts";
import type { EnvVar } from "../collections/env-var.ts";
import { OS_NAMES } from "../program/release.ts";
import { tools } from "../resources/tools.ts";
import { personOf } from "../shared/person.ts";
import { settingsOf } from "../shared/settings.ts";

const ASKED = { terminal: "run commands", jobs: "start jobs", writes: "write or edit files" };

/** A shell, by its path: bash, PowerShell 7 (`pwsh`) or Windows PowerShell. */
const shellOf = (path: string) =>
  /pwsh(\.exe)?$/i.test(path)
    ? "PowerShell 7 (pwsh): write PowerShell"
    : /powershell(\.exe)?$/i.test(path)
    ? "Windows PowerShell 5.1: write PowerShell"
    : "bash";

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
      const desk = here.find((d) => d.online);
      if (!desk) {
        // Where something wakes computers (cloud computers), using one that's asleep wakes it.
        if (here.length && (ctx.resources.computerWake as { wake?: string } | undefined)?.wake) {
          return `This space's computer, ${here[0].name ?? "theirs"}, is offline or asleep. ` +
            "If the app hosts it (a cloud computer), your computer tools wake it: the first " +
            `call waits a few seconds. If not, they won't work until ${here[0].owner} starts ` +
            "it again.";
        }
        return here.length
          ? `This space's computer, ${here[0].name ?? "theirs"}, is offline, so your computer ` +
            `tools won't work until ${here[0].owner} starts it again (on it: deno task computer).`
          : "This space has no computer, so your computer tools won't work until someone " +
            "connects one, or adds one of theirs (in the terminal: /computer connect or " +
            "/computer share; on the web: the space's Computer tab).";
      }
      const owned = desk.owner === person ? `${person}'s own` : `${desk.owner}'s`;
      const info = desk.info as
        | { os?: string; root?: string; windows?: string; shell?: string }
        | undefined;
      const sep = info?.os === "win32" ? "\\" : "/";
      const asked = (desk.approve ?? settingsOf(ctx).approve).map((work) => ASKED[work]);
      const answerer = desk.answers === "owner" ? desk.owner : person;
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
        ...environment(ctx, thread.in),
      ].join("\n");
    },
  },
};

/**
 * The space's environment its computers get, by name (never a value): what
 * the agent's shell and jobs already have.
 */
function environment(ctx: ViewContext, space: string): string[] {
  const vars = ctx.db.collection<EnvVar>("envVar").find({ space, app: { $exists: false } }, {
    sort: { name: 1 },
  });
  if (vars.status !== "ready") return [];
  const names = vars.value.filter((v) => v.computers).map((v) =>
    v.secret ? `${v.name} (a secret)` : v.name
  );
  return names.length
    ? [
      `Your shell and jobs here have this space's environment: ${names.join(", ")}. Use them ` +
      "by name ($NAME); never print or repeat a secret's value.",
    ]
    : [];
}
