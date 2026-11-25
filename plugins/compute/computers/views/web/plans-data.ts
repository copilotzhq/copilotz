/**
 * What Your plans, Your computers and the welcome's step read, live, as a
 * View reads: the person's computers (what each last said of its CLIs),
 * where each is shared (its desks, and the spaces they reach), the kinds of
 * computer the app keeps (cloud computers) and whether they can make one,
 * the accounts that pay for models and the person's own, and the plans the
 * app uses (the `planList` resource's query, in the person's order; without
 * it, every plan the app has). Undefined until it's all there.
 */
import type { ReactNode } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import type { Account, ProviderShown } from "../../../../access/accounts/contract.ts";
import type { Reached } from "../../../../access/spaces/contract.ts";
import type { Computer } from "../../collections/computer.ts";
import type { Desk } from "../../collections/desk.ts";
import { blockedBy, type Kind, kindByComputer, kindsOf, queryOf } from "./kinds.ts";
import { nameOf } from "./names.ts";
import {
  type Listed,
  type Machine,
  type PlanList,
  type PlanShown,
  plansOf,
  sharedIn,
} from "./plan-states.ts";

/** What the plans' Views read, ready. */
export type PlansData = {
  computers: Computer[];
  machines: Machine[];
  kinds: Kind[];
  kindOf: Record<string, Kind>;
  accounts: Account[];
  plans: PlanShown[];
  /** The resource that lists the plans, and saves their order, when the app's tiers give it. */
  list?: PlanList;
  /** The person's Personal space: a computer made or connected for plans goes there. */
  personal?: string;
};

/** What the plans' Views read, as a View reads it: undefined until it's all there. */
export function plansData(ctx: ViewContext<ReactNode>): PlansData | undefined {
  const mine = ctx.db.collection("computer").query<Computer[]>("mine", {}).value;
  const spaces = ctx.db.collection("space").query<Reached[]>("reached", {}).value;
  const desks = (mine ?? []).map((c) =>
    ctx.db.collection("desk").query<Desk[]>("of", { computer: c._id }).value
  );
  const kinds = kindsOf(ctx.resources.computerKinds);
  const records = kinds.map((k) => {
    const [collection, query] = queryOf(k.mine)!;
    return ctx.db.collection(collection).query<{ _id: string }[]>(query, {}).value;
  });
  // Whether the person may make each kind now (a guest, an org out of credits can't).
  const makeable = kinds.map((k) => {
    const named = k.add?.available ? queryOf(k.add.available) : undefined;
    return named ? ctx.db.collection(named[0]).query<unknown>(named[1], {}).value : undefined;
  });
  const providers = ctx.db.collection("account").query<ProviderShown[]>("providers", {}).value;
  const accounts = ctx.db.collection<Account>("account").find({}).value;
  const list = ctx.resources.planList as PlanList | undefined;
  const named = list ? queryOf(list.query) : undefined;
  const listed = named ? ctx.db.collection(named[0]).query<Listed[]>(named[1], {}).value : null;
  if (
    mine === undefined || spaces === undefined || desks.some((d) => d === undefined) ||
    records.some((r) => r === undefined) || providers === undefined || accounts === undefined ||
    listed === undefined
  ) return undefined;
  const kindOf = kindByComputer(kinds, records);
  return {
    computers: mine,
    machines: mine.map((computer, i) => {
      const kind = kindOf[computer._id];
      return {
        computer,
        name: nameOf(computer),
        ...(kind ? { kind: { view: kind.view, ...(kind.icon ? { icon: kind.icon } : {}) } } : {}),
        shared: sharedIn(desks[i] ?? [], spaces),
      };
    }),
    kinds: kinds.map((k, i) => {
      const blocked = blockedBy(k, makeable[i]);
      return blocked ? { ...k, blocked } : k;
    }),
    kindOf,
    accounts,
    plans: plansOf(listed ?? undefined, providers),
    ...(list ? { list } : {}),
    ...(spaces.find((s) => s.kind === "personal")
      ? { personal: spaces.find((s) => s.kind === "personal")!._id }
      : {}),
  };
}
