/**
 * A person's plans on their computers (see shared/engines.ts), for their
 * settings: which CLIs each of their computers has, signed in or not
 * (`computer.engines`), and signing one in (`computer.engine.login`), which
 * runs the CLI's own sign-in there and is asked again until it's done.
 * On a laptop the CLI opens their browser itself; elsewhere (a cloud
 * computer) it says a link, and the code its page shows goes back to it as
 * `input`. Nothing of the sign-in is kept here: only whether it's done.
 * Asked to (`install`), it first runs the CLI's official installer there
 * when the CLI is missing (macOS and Linux; `INSTALL`, never a command from
 * the caller): the person's click is the consent. Signing out
 * (`computer.engine.logout`) runs the CLI's own sign-out there, each its own
 * way (see program/agents/engines.ts): a cloud computer signed in to a plan
 * isn't shared with others' agents.
 *
 * Only the person themselves, on their own computers. A computer that
 * sleeps isn't woken to be asked: it shows what it last said. Signing in or
 * out wakes it; a laptop that's off must be turned on.
 */
import { defineAction, forbidden, inPerson } from "../../../../runtime/mod.ts";
import type { Computer } from "../collections/computer.ts";
import {
  type EngineName,
  ENGINES,
  type EngineSeen,
  engineStatus,
  sharedWithOthers,
  signedOut,
} from "../shared/engines.ts";
import { INSTALL } from "../shared/install.ts";
import { failed } from "../shared/failed.ts";
import { wake } from "../shared/wake.ts";
import { type LoginState, WORK } from "../shared/workloads.ts";

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

/** Wakes `computer` when it's off and can be (a cloud computer); else fails with `offline`. */
async function awake(
  ctx: Parameters<Parameters<typeof defineAction>[0]["run"]>[0],
  computer: Computer,
  offline: string,
) {
  if (computer.online) return;
  const woke = await wake(ctx, computer._id);
  if (woke !== true) {
    throw Object.assign(new Error(typeof woke === "string" ? woke : offline), {
      code: "offline",
      public: true,
    });
  }
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
      // An older computer program doesn't know the work: what it last said stays.
      const said = computer.online ? await engineStatus(ctx, computer._id) : undefined;
      if (said) engines = { ...engines, ...said };
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
      /** Installs the CLI first, with its official installer, when it's missing there (not on Windows). */
      install: { type: "boolean" },
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
    await awake(ctx, computer, "The computer is offline.");
    const answer = await ctx.workers.call<LoginState>("computer", computer._id, WORK.agentsLogin, {
      engine: input.engine,
      ...(input.input !== undefined ? { input: input.input } : {}),
      ...(input.stop ? { stop: true } : {}),
      ...(input.install ? { install: INSTALL[input.engine as EngineName] } : {}),
    });
    const error = failed(answer);
    if (error) throw error;
    if (answer.state !== "done") return answer;
    // Done: what's true there now, kept, and whether its CLI is there (an installer may have failed).
    const said = (await engineStatus(ctx, computer._id, [input.engine as EngineName]))
      ?.[input.engine as EngineName];
    return said ? { ...answer, installed: said.installed } : answer;
  },
});

export const engineLogoutAction = defineAction({
  description: "Signs a plan's CLI out on one of your computers, by its own sign-out",
  input: {
    type: "object",
    properties: { computer: { type: "string" }, engine: { enum: [...ENGINES] } },
    required: ["computer", "engine"],
    additionalProperties: false,
  },
  allow: inPerson,
  run: async (ctx, input) => {
    const computer = await ctx.as().db.collection<Computer>("computer")
      .findOne({ _id: input.computer, owner: ctx.actor!.id });
    if (!computer) throw forbidden("That isn't one of your computers.");
    await awake(
      ctx,
      computer,
      `${computer.name ?? "The computer"} is off: turn it on to sign out there.`,
    );
    const answer = await ctx.workers.call("computer", computer._id, WORK.agentsLogout, {
      engine: input.engine,
    });
    const error = failed(answer);
    if (error) throw error;
    const said = await engineStatus(ctx, computer._id, [input.engine as EngineName]);
    if (!said) await signedOut(ctx, computer._id, input.engine as EngineName);
    return { ok: true };
  },
});
