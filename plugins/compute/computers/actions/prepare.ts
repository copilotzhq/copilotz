/**
 * `computer.prepare` `{ computer }`: one of the person's computers, ready
 * for plans, as it is now, for the connect flow (views/web/connect-flow.ts)
 * before it installs or signs anything in there. Each call checks again; it
 * never answers from what the record remembers:
 *
 * 1. Not theirs: `forbidden`. Shared into a space where others' agents work
 *    on it as them: `computer_shared` (their plans can't run there).
 * 2. Offline, it's woken when something wakes it (a cloud computer); one
 *    that doesn't wake (a laptop that's off) fails `offline`, saying so.
 * 3. Its program older than the app's release: one the app keeps is put to
 *    sleep and woken again, once (its new VM runs the release); the
 *    person's own is offered the release (it updates itself as it does when
 *    it connects), and waited for, up to two minutes. Still old (nothing
 *    could update it), it goes on: `program.current` says so.
 * 4. It asks the computer what its plans' CLIs are now (`engineStatus`,
 *    kept on it), and answers that.
 *
 * Who it is and how it stands show on the person's computer as it goes (the
 * `computer.mine` query, live): waking, coming back, its version.
 */
import { defineAction, failure, forbidden, inPerson } from "../../../../runtime/mod.ts";
import type { Computer } from "../collections/computer.ts";
import type { ComputerEngines } from "./engines.ts";
import {
  type EngineName,
  type EngineSeen,
  engineStatus,
  sharedWithOthers,
} from "../shared/engines.ts";
import { offerUpdate, older } from "../shared/update.ts";
import { restart, wake } from "../shared/wake.ts";
import type { Info } from "../shared/workloads.ts";

/** One computer of the person's, ready for plans, as it is now. */
export type Prepared = ComputerEngines & {
  /** Its program's version, and whether it's the app's release or newer. */
  program: { version?: string; current: boolean };
};

/** How long a computer that's updating itself is waited for. */
export const UPDATE_MS = 120_000;
/** How long a restarted computer has to come back as its new VM. */
const BACK_MS = 60_000;

export const prepareAction = defineAction({
  description:
    "Gets one of your computers ready for your plans: awake, on this app's program, and what its plans' CLIs are now",
  input: {
    type: "object",
    properties: { computer: { type: "string" } },
    required: ["computer"],
    additionalProperties: false,
  },
  allow: inPerson,
  run: async (ctx, input): Promise<Prepared> => {
    const computers = ctx.as().db.collection<Computer>("computer");
    const read = () => computers.findOne({ _id: input.computer, owner: ctx.actor!.id });
    let computer = await read();
    if (!computer) throw forbidden("That isn't one of your computers.");
    const name = computer.name ?? "Your computer";
    if (await sharedWithOthers(ctx, computer._id)) {
      throw failure(
        "computer_shared",
        `${name} is shared with others' agents, so your plans can't run on it.`,
        { public: true, status: 409 },
      );
    }
    if (!computer.online) {
      const woke = await wake(ctx, computer._id);
      if (woke !== true) {
        throw failure("offline", typeof woke === "string" ? woke : `${name} is off.`, {
          public: true,
        });
      }
      computer = await read() ?? computer;
    }
    const versionOf = (c: Computer) => (c.info as Info | undefined)?.version;
    if (older(ctx, versionOf(computer))) {
      const before = computer.seen;
      if (computer.status) {
        // One the app keeps: a new VM runs the app's release (its pool's VMs update themselves).
        if (await restart(ctx, computer._id) === true) {
          computer = await until(read, (c) => c.online && c.seen !== before, BACK_MS) ?? computer;
        }
      } else if (
        await offerUpdate(ctx, "computer", computer._id, computer.info as Info)
      ) {
        // The person's own: it updates, goes, and comes again as the release.
        computer = await until(
          read,
          (c) => c.online && !older(ctx, versionOf(c)),
          UPDATE_MS,
        ) ?? computer;
      }
    }
    const said = computer.online ? await engineStatus(ctx, computer._id) : undefined;
    const version = versionOf(computer);
    return {
      computer: computer._id,
      ...(computer.name ? { name: computer.name } : {}),
      online: computer.online,
      ...(computer.status ? { status: computer.status } : {}),
      shared: false,
      engines: {
        ...(computer.engines as Partial<Record<EngineName, EngineSeen>> | undefined),
        ...said,
      },
      program: { ...(version ? { version } : {}), current: !older(ctx, version) },
    };
  },
});

/** What `read` answers once `done` says so, within `ms`; else undefined. */
async function until(
  read: () => Promise<Computer | null>,
  done: (computer: Computer) => boolean,
  ms: number,
): Promise<Computer | undefined> {
  for (const end = Date.now() + ms; Date.now() < end;) {
    const now = await read();
    if (now && done(now)) return now;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return undefined;
}
