/**
 * A person's plans on their computers (see shared/engines.ts), for their
 * settings: which CLIs each of their computers has, signed in or not
 * (`computer.engines`), and signing one in (`computer.engine.login`), which
 * runs the CLI's own sign-in there and is asked again until it's done.
 * On a laptop the CLI opens their browser itself; elsewhere (a cloud
 * computer) it says a link, and the code its page shows goes back to it as
 * `input`. Nothing of the sign-in is kept here: only whether it's done.
 *
 * Only the person themselves, on their own computers. A computer that
 * sleeps isn't woken to be asked: it shows what it last said.
 */
import { defineAction, forbidden, inPerson } from "../../../../runtime/mod.ts";
import type { Computer } from "../collections/computer.ts";
import { type EngineName, ENGINES, type EngineSeen, sharedWithOthers } from "../shared/engines.ts";
import { failed } from "../shared/failed.ts";
import { wake } from "../shared/wake.ts";
import { type EngineStatus, type LoginState, WORK } from "../shared/workloads.ts";

/** One computer of theirs, and its engines. */
export type ComputerEngines = {
  computer: string;
  name?: string;
  online: boolean;
  /** A computer the app keeps (a cloud computer): `kind`, and how it is. */
  status?: Computer["status"];
  /** Others' agents work on it as its owner: their plans can't run here. */
  shared: boolean;
  engines: Partial<Record<EngineName, EngineSeen>>;
};

/** Keeps what a computer said of its engines on it. */
async function keep(
  ctx: Parameters<Parameters<typeof defineAction>[0]["run"]>[0],
  computer: Computer,
  said: EngineStatus[],
): Promise<Partial<Record<EngineName, EngineSeen>>> {
  const at = new Date().toISOString();
  const engines = { ...(computer.engines as Partial<Record<EngineName, EngineSeen>> | undefined) };
  for (const status of said) {
    if (!(ENGINES as readonly string[]).includes(status.engine)) continue;
    engines[status.engine as EngineName] = {
      installed: status.installed,
      signedIn: status.signedIn,
      ...(status.version ? { version: status.version } : {}),
      ...(status.account ? { account: status.account } : {}),
      at,
    };
  }
  await ctx.as().db.collection<Computer>("computer").updateOne({ _id: computer._id }, {
    $set: { engines },
  });
  return engines;
}

export const enginesAction = defineAction({
  description: "Your computers, and which plans' CLIs each runs, signed in or not",
  input: { type: "object", properties: {}, additionalProperties: false },
  allow: inPerson,
  run: async (ctx): Promise<ComputerEngines[]> => {
    const computers = await ctx.as().db.collection<Computer>("computer")
      .find({ owner: ctx.actor!.id }, { sort: { seen: -1 } });
    return await Promise.all(computers.map(async (computer) => {
      let engines = (computer.engines ?? {}) as Partial<Record<EngineName, EngineSeen>>;
      if (computer.online) {
        const said = await ctx.workers.call<EngineStatus[] | { error: unknown }>(
          "computer",
          computer._id,
          WORK.agentsStatus,
          {},
        ).catch(() => undefined);
        // An older computer program doesn't know the work: it shows nothing installed.
        if (Array.isArray(said)) engines = await keep(ctx, computer, said);
      }
      return {
        computer: computer._id,
        ...(computer.name ? { name: computer.name } : {}),
        online: computer.online,
        ...(computer.status ? { status: computer.status } : {}),
        shared: await sharedWithOthers(ctx, computer._id),
        engines,
      };
    }));
  },
});

export const engineLoginAction = defineAction({
  description: "Signs a plan's CLI in on one of your computers, step by step",
  // What's typed is a sign-in code: never recorded.
  record: false,
  input: {
    type: "object",
    properties: {
      computer: { type: "string" },
      engine: { enum: [...ENGINES] },
      /** What the CLI asks for (the code the sign-in page shows). */
      input: { type: "string", maxLength: 4096 },
      /** Stops a sign-in under way. */
      stop: { type: "boolean" },
    },
    required: ["computer", "engine"],
    additionalProperties: false,
  },
  allow: inPerson,
  run: async (ctx, input): Promise<LoginState> => {
    const computer = await ctx.as().db.collection<Computer>("computer")
      .findOne({ _id: input.computer, owner: ctx.actor!.id });
    if (!computer) throw forbidden("That isn't one of your computers.");
    if (await sharedWithOthers(ctx, computer._id)) {
      throw forbidden(
        "Others' agents work on this computer as you: your plan's sign-in would be theirs to reach.",
      );
    }
    if (!computer.online) {
      const woke = await wake(ctx, computer._id);
      if (woke !== true) {
        throw Object.assign(
          new Error(typeof woke === "string" ? woke : "The computer is offline."),
          { code: "offline", public: true },
        );
      }
    }
    const answer = await ctx.workers.call<LoginState>("computer", computer._id, WORK.agentsLogin, {
      engine: input.engine,
      ...(input.input !== undefined ? { input: input.input } : {}),
      ...(input.stop ? { stop: true } : {}),
    });
    const error = failed(answer);
    if (error) throw error;
    if (answer.state === "done") {
      const said = await ctx.workers.call<EngineStatus[]>(
        "computer",
        computer._id,
        WORK.agentsStatus,
        { engines: [input.engine] },
      ).catch(() => undefined);
      if (Array.isArray(said)) await keep(ctx, computer, said);
    }
    return answer;
  },
});
