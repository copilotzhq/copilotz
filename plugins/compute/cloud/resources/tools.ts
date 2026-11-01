/**
 * What agents manage cloud computers with, for the person they work for, in
 * the conversation's space: `list_computers`, `create_computer` and
 * `manage_computer` (add one here, remove it, rename it, make it the default,
 * destroy it). Each calls the Action a person would, as that person, so its
 * rules are the same ones. Destroying loses its disk, so its person is asked
 * first, every time; nothing else is. A person's own machine isn't an agent's
 * to manage: sharing one lets others' agents run commands on it.
 *
 *   agents: { assistant: { tools: ["terminal", "create_computer", "manage_computer"] } }
 */
import type { Actor, ViewContext } from "../../../../runtime/mod.ts";
import { personOf } from "../../../../runtime/mod.ts";
import {
  principalOf,
  type Thread,
  type Tool,
  tool,
  type ToolContext,
} from "../../../agents/chat/contract.ts";
import { nameOf, namesFor } from "../../../access/spaces/contract.ts";
import type { CloudComputer } from "../contract.ts";
import type { Offered } from "../collections/cloud-computer.ts";
import { runs, standingOf } from "../shared/people.ts";
import { computerOf, recordsOf } from "../shared/records.ts";

type Space = { _id: string; can?: string[] };
type Desk = {
  _id: string;
  computer: string;
  in: string;
  owner: string;
  name?: string;
  default?: boolean;
  online?: boolean;
};
type Sizes = {
  sizes: Offered[];
  disk: { gb: number; gbMonth: number | null };
  warmMinutes: number;
  create: boolean;
  why?: string;
};

/** Where the person an agent works for may write: its own conversation's space. */
const offer = (_agent: string, thread: Thread, ctx: ViewContext) => {
  if (!thread.in || !personOf(ctx.actor)) return false;
  const spaces = ctx.db.collection("space").query<Space[]>("reached", {}).value;
  return !!spaces?.find((s) => s._id === thread.in)?.can?.includes("write");
};

/** The conversation's space and the person the agent works for, or why there are none. */
async function whereFor(ctx: ToolContext) {
  const principal = principalOf(ctx.actor) as Actor | undefined;
  if (!principal) {
    return { missing: "Computers are a person's, and you aren't working for one here." };
  }
  const thread = await ctx.db.collection<Thread>("thread").findOne({ _id: ctx.thread });
  if (!thread?.in) {
    return { missing: "This conversation isn't in a space, so no computer goes here." };
  }
  return { person: principal.id, space: thread.in, as: ctx.as(principal) };
}

const errorOf = (error: unknown) => `Error: ${error instanceof Error ? error.message : error}`;

/** A computer an agent can name: in this space, or a cloud computer of its person's. */
type Known = { id: string; name: string; owner: string; desk?: Desk; cloud?: CloudComputer };

/** This space's computers, then its person's other cloud computers. */
async function knownTo(ctx: ToolContext, person: string, space: string): Promise<Known[]> {
  // Read as the agent (for its person), so only what they reach.
  const desks = await ctx.db.collection<Desk>("desk").find({ in: space });
  const records = await recordsOf(ctx).find({
    $or: [{ _id: { $in: desks.map((d) => d.computer) } }, { owner: person }],
  });
  const clouds = new Map(records.map((r) => [r._id, r]));
  const here = desks.map((desk): Known => ({
    id: desk.computer,
    name: desk.name ?? desk.computer,
    owner: desk.owner,
    desk,
    ...(clouds.has(desk.computer) ? { cloud: clouds.get(desk.computer) } : {}),
  }));
  const elsewhere = await Promise.all(
    records.filter((r) => r.owner === person && !desks.some((d) => d.computer === r._id)).map(
      async (cloud): Promise<Known> => ({
        id: cloud._id,
        name: (await computerOf(ctx, cloud._id))?.name ?? cloud._id,
        owner: person,
        cloud,
      }),
    ),
  );
  return [...here, ...elsewhere];
}

/** The computer an agent named (its id, or its name), or what it's told instead. */
function chosen(known: Known[], given: string): Known | string {
  const key = given.trim().toLowerCase();
  const byId = known.find((k) => k.id === given);
  if (byId) return byId;
  const named = known.filter((k) => k.name.trim().toLowerCase() === key);
  if (named.length === 1) return named[0];
  const list = known.map((k) => `"${k.name}" (${k.id})`).join(", ") || "none";
  return named.length
    ? `More than one is called "${given}". Give the id of the one you mean: ${list}.`
    : `There's no computer called "${given}". Those you can name: ${list}.`;
}

const listComputers = tool({
  offer,
  description: "The computers you can manage: this space's, the other cloud computers of the " +
    "person you work for, the sizes a new one can be with what they cost, and whether they may " +
    "make one now.",
  input: { type: "object", properties: {} },
  run: async (_input, ctx) => {
    const where = await whereFor(ctx);
    if ("missing" in where) return where.missing;
    const { person, space, as } = where;
    const known = await knownTo(ctx, person, space);
    const names = await namesFor(ctx, known.map((k) => k.owner));
    const shown = (k: Known) => ({
      id: k.id,
      name: k.name,
      ...(k.cloud
        ? { size: k.cloud.size, state: k.cloud.state }
        : { machine: `${nameOf(k.owner, names)}'s own` }),
    });
    const offered = await as.db.collection("cloudComputer").query<Sizes>("sizes", {});
    return {
      here: known.filter((k) => k.desk).map((k) => ({
        ...shown(k),
        ...(k.desk!.default ? { default: true } : {}),
      })),
      yours_elsewhere: known.filter((k) => !k.desk).map(shown),
      sizes: offered.sizes.map((s) => ({
        id: s.id,
        label: s.label,
        vcpu: s.vcpu,
        memory_gb: s.memory,
        usd_per_hour_awake: s.hour,
      })),
      disk_gb: offered.disk.gb,
      disk_usd_per_gb_month: offered.disk.gbMonth,
      sleeps_after_minutes_unused: offered.warmMinutes,
      can_create: offered.create,
      ...(offered.why ? { why_not: offered.why } : {}),
    };
  },
});

const createComputer = tool({
  offer,
  description: "Makes a cloud computer in this space, for the person you work for: yours and " +
    "the space's agents can work on it straight away, its first use waking it. Do it when the " +
    "work needs a computer and this space has none, or one that's separate. Tell them you made " +
    "it and what it costs. size: from list_computers (the smallest unless you say).",
  input: {
    type: "object",
    properties: {
      size: { type: "string" },
      name: { type: "string", minLength: 1, maxLength: 64 },
    },
  },
  run: async (input, ctx) => {
    const where = await whereFor(ctx);
    if ("missing" in where) return where.missing;
    const { person, space, as } = where;
    try {
      const offered = await as.db.collection("cloudComputer").query<Sizes>("sizes", {});
      const size = input.size ?? offered.sizes[0]?.id;
      if (!size) return "The app offers no cloud computers.";
      const label = offered.sizes.find((s) => s.id === size)?.label;
      const name = input.name?.trim() || `${label ?? size} cloud computer`;
      const known = await knownTo(ctx, person, space);
      if (known.some((k) => k.desk && k.name.trim().toLowerCase() === name.toLowerCase())) {
        return `This space already has a computer called "${name}". To make another, name it.`;
      }
      const { computer } = await as.call<{ computer: string }>("cloud.create", {
        size,
        in: space,
        name,
      });
      const isDefault = !known.some((k) => k.desk);
      return {
        computer,
        name,
        size,
        usd_per_hour_awake: offered.sizes.find((s) => s.id === size)?.hour ?? null,
        note: `It's in this space, asleep, and your computer tools wake it${
          isDefault ? "" : `: give computer "${name}" to use it, as it isn't the default`
        }. It sleeps after ${offered.warmMinutes} minutes unused.`,
      };
    } catch (error) {
      return errorOf(error);
    }
  },
});

const manageComputer = tool({
  offer,
  description: "Changes a cloud computer: add (one of your person's, into this space), remove " +
    "(out of this space; it and its files stay), rename (give name), default (the one this " +
    "space's agents use), or destroy (for good, its files with it; its person is asked first). " +
    "computer: its name or id, from list_computers.",
  input: {
    type: "object",
    properties: {
      computer: { type: "string" },
      action: { enum: ["add", "remove", "rename", "default", "destroy"] },
      name: { type: "string", minLength: 1, maxLength: 64 },
    },
    required: ["computer", "action"],
  },
  run: async (input, ctx) => {
    const where = await whereFor(ctx);
    if ("missing" in where) return where.missing;
    const { person, space, as } = where;
    try {
      const found = chosen(await knownTo(ctx, person, space), input.computer);
      if (typeof found === "string") return found;
      if (!found.cloud) {
        const names = await namesFor(ctx, [found.owner]);
        return `"${found.name}" is ${nameOf(found.owner, names)}'s own machine: it's theirs to ` +
          "manage, from the space's Computer tab.";
      }
      const notHere = `"${found.name}" isn't in this space.`;
      switch (input.action) {
        case "add":
          if (found.desk) return `"${found.name}" is in this space already.`;
          await as.call("computer.share", { computer: found.id, in: space });
          return `"${found.name}" is in this space now.`;
        case "remove":
          if (!found.desk) return notHere;
          await as.call("computer.unshare", { desk: found.desk._id });
          return `"${found.name}" is out of this space. It and its files stay.`;
        case "rename":
          if (!input.name?.trim()) return "What should it be called? Give name.";
          if (found.owner !== person) return "Only its owner renames it.";
          await as.call("computer.rename", { computer: found.id, name: input.name });
          return `It's called "${input.name.trim()}" now.`;
        case "default":
          if (!found.desk) return notHere;
          await as.call("computer.default", { desk: found.desk._id });
          return `This space's agents use "${found.name}" now, unless told otherwise.`;
        case "destroy": {
          if (!found.desk) return notHere;
          // Told now, rather than after their person's yes.
          if (found.owner !== person && !runs(await standingOf(as))) {
            return "Only its owner, or the org's owners and admins, destroy it.";
          }
          const asked = await ctx.call<true | string>("computer.allowed", {
            thread: ctx.thread,
            agent: ctx.agent,
            kind: "destroy",
            detail: found.name,
            computer: found.desk._id,
          });
          if (asked !== true) return asked;
          await as.call("cloud.destroy", { computer: found.id });
          return `"${found.name}" is gone, and its files with it.`;
        }
      }
    } catch (error) {
      return errorOf(error);
    }
  },
});

/** By the names agents list them under. */
export const tools: Record<string, Tool> = {
  list_computers: listComputers,
  create_computer: createComputer,
  manage_computer: manageComputer,
};
