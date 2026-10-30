/**
 * `computer.scope`: where a space's work goes on its computer, for trusted
 * code that sends it work of its own (the apps plugin archiving a folder):
 * the desk of `computer` there when it's given, else the space's default,
 * else one online. It answers the computer, whether it's online, and the
 * scope, `who` as given. Nobody calls it from outside: the caller checks
 * the person first, and calls it as the system.
 */
import { defineAction } from "../../../../runtime/mod.ts";
import { desksIn } from "../shared/where.ts";
import type { Scope } from "../shared/workloads.ts";

export const scopeAction = defineAction({
  description: "Where a space's work goes on its computer",
  input: {
    type: "object",
    properties: {
      in: { type: "string" },
      /** Whose shell and jobs: `agent:<name>` or `person:<id>`. */
      who: { type: "string", pattern: "^(agent|person):.+$" },
      /** This computer's desk there, rather than the space's default. */
      computer: { type: "string" },
    },
    required: ["in", "who"],
    additionalProperties: false,
  },
  run: async (ctx, input): Promise<{ computer: string; online: boolean; scope: Scope }> => {
    const desks = await desksIn(ctx, input.in);
    const desk = input.computer
      ? desks.find((d) => d.computer === input.computer)
      : desks.find((d) => d.online) ?? desks[0];
    if (!desk) {
      throw Object.assign(
        new Error(
          input.computer
            ? "That computer isn't in this space any more."
            : "There's no computer in this space.",
        ),
        { code: "not_found" },
      );
    }
    return {
      computer: desk.computer,
      online: desk.online,
      scope: { space: input.in, folder: desk.folder, who: input.who },
    };
  },
});
