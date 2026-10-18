/** Named-port failure fixture. This proves driver drain, not SQL authority. */
import assert from "node:assert/strict";
import type { ActionContext } from "../actions/types.ts";
import type { RegisteredStreamPort } from "./stream-capability.ts";
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => resolve = done);
  return { promise, resolve };
}
export function streamFailureFixture(
  unknownCleanup: boolean | "hostile" = false,
) {
  const authored = gate(), cleanup = gate(), enteredCleanup = gate();
  const stopped = gate();
  let context!: Pick<ActionContext, "streams" | "signal">;
  let commandSignal: AbortSignal | undefined;
  const failure = new Error("checkpoint refused");
  const unknown = Object.assign(new Error("cleanup reply lost"), {
    code: "owner_commit_unknown",
    indeterminate: true,
  });
  if (unknownCleanup === "hostile") {
    Object.defineProperty(unknown, "code", {
      get() {
        throw new Error("error accessor must never execute");
      },
    });
  }
  const port: RegisteredStreamPort = {
    open: (input) => Promise.resolve({ id: input.id }),
    append(input) {
      return Promise.resolve({
        startOffset: input.expectedOffset,
        endOffset: input.expectedOffset + input.bytes.byteLength,
      });
    },
    checkpoint(_input, options) {
      commandSignal = options.signal;
      return Promise.reject(failure);
    },
    async abort(input, options) {
      assert.equal(options.signal, undefined);
      assert.equal(input.outcome, "failed");
      enteredCleanup.resolve();
      await cleanup.promise;
      if (unknownCleanup) throw unknown;
    },
  };
  return {
    port,
    unknown,
    async handle(ctx: Pick<ActionContext, "streams" | "signal">) {
      context = ctx;
      ctx.signal.addEventListener("abort", stopped.resolve, { once: true });
      const writer = await ctx.streams.open({
        mediaType: "text/plain",
        role: "output",
      });
      await writer.append({ bytes: new Uint8Array([1]), appendId: "chunk" });
      // Deliberately noncooperative authored work. Aborting the public signal
      // must not be confused with actual return, drain or terminal settlement.
      await authored.promise;
      await assert.rejects(
        writer.append({ bytes: new Uint8Array([2]), appendId: "late" }),
      );
    },
    async inspectBeforeRelease(isSettled: () => boolean) {
      await stopped.promise;
      await enteredCleanup.promise;
      assert.equal(context.signal.aborted, true);
      assert.equal(commandSignal?.aborted, true);
      assert.equal(isSettled(), false);
      authored.resolve();
      await new Promise((done) => setTimeout(done, 0));
      assert.equal(
        isSettled(),
        false,
        "held cleanup must prevent terminal settlement",
      );
      cleanup.resolve();
    },
    release() {
      authored.resolve();
      cleanup.resolve();
    },
  };
}
