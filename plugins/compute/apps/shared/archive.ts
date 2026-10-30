/**
 * An app's folder as its computer sends it (`computer.archive`): a gzipped
 * tar, streamed. Where it goes on the computer comes from the computers
 * plugin (`computer.scope`, as the system: the app's space and computer),
 * never from what an agent asks. A computer that can't archive it answers
 * a failure (JSON) instead of gzip, told apart by its first byte.
 */
import type { Context } from "../../../../runtime/mod.ts";
import {
  type ArchiveInput,
  type Failed,
  type Scope,
  WORK,
} from "../../computers/shared/workloads.ts";
import type { AppDoc } from "../collections/app.ts";
import { failure, messageOf } from "./errors.ts";

export type Where = { computer: string; online: boolean; scope: Scope };

/** Where the app's folder is: its space's desk of its computer. */
export const whereOf = (ctx: Context, app: Pick<AppDoc, "space" | "by" | "source">) =>
  ctx.as().call<Where>("computer.scope", {
    in: app.space,
    who: `person:${app.by}`,
    computer: app.source.computer,
  });

/**
 * The app's folder as a stream. A computer that fails partway errors the
 * stream, which fails whatever reads it (the host's build).
 */
export async function archiveOf(
  ctx: Context,
  app: Pick<AppDoc, "space" | "by" | "source">,
): Promise<ReadableStream<Uint8Array>> {
  const { computer, scope } = await whereOf(ctx, app);
  const input: ArchiveInput = { scope, ...(app.source.path ? { path: app.source.path } : {}) };
  const job = await ctx.workers.dispatch("computer", computer, WORK.archive, input).catch(
    (error) => {
      throw (error as { code?: string }).code === "offline"
        ? failure("The space's computer is offline: start it again, then publish again.", "offline")
        : error;
    },
  );
  // The stream says how it went; the job's end is seen to, so its failure isn't unhandled.
  job.done.catch(() => {});
  return await unlessFailed(job.output);
}

/** The stream as it comes, unless what came is a failure (JSON, where gzip starts 0x1f 0x8b). */
export async function unlessFailed(
  output: ReadableStream<Uint8Array>,
): Promise<ReadableStream<Uint8Array>> {
  const reader = output.getReader();
  let first = await reader.read();
  while (!first.done && first.value.length === 0) first = await reader.read();
  if (first.done) throw failure("The computer sent an empty archive.");
  if (first.value[0] === 0x7b) {
    const chunks = [first.value];
    for (let next = await reader.read(); !next.done; next = await reader.read()) {
      chunks.push(next.value);
    }
    const text = await new Blob(chunks as BlobPart[]).text();
    const said = (() => {
      try {
        return JSON.parse(text) as Partial<Failed>;
      } catch {
        return {};
      }
    })();
    throw failure(
      `The computer couldn't archive the folder: ${said.error?.message ?? text.slice(0, 200)}`,
      said.error?.code ?? "failed",
    );
  }
  const head = first.value;
  let sent = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(head);
        return;
      }
      // A computer that stops partway (past `maxBytes`, `tar` failing) errors the stream.
      const next = await reader.read().catch((error) => {
        throw failure(`The computer couldn't archive the folder: ${messageOf(error)}`);
      });
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    cancel: (reason) => reader.cancel(reason),
  });
}
