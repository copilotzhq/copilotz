/**
 * What the plugin keeps, read and written as the system (people reach their
 * own through the guard; the plugin's work reaches all), and what it reads
 * of the computers plugin's: whether a computer is connected, and its name.
 */
import type { Context, Filter } from "../../../../runtime/mod.ts";
import type { CloudComputer, PoolVm } from "../contract.ts";

export const recordsOf = (ctx: Context) => ctx.as().db.collection<CloudComputer>("cloudComputer");
export const poolsOf = (ctx: Context) => ctx.as().db.collection<PoolVm>("poolVm");

/** The computer record, as the computers plugin keeps it: connected or not, and what it's called. */
export const computerOf = (ctx: Context, id: string) =>
  ctx.as().db.collection<{ online?: boolean; name?: string }>("computer").findOne({ _id: id });

/** Whether a computer is connected now. */
export const onlineOf = async (ctx: Context, id: string) =>
  (await computerOf(ctx, id))?.online === true;

/** A filter on a field still having the value read (or still having none). */
export const still = (field: string, value: unknown): Filter =>
  ({ [field]: value === undefined ? { $exists: false } : value }) as Filter;
