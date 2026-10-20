import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { localDispatcher } from "./local.ts";

Deno.test("local work captures inputs and shutdown retains capacity until physical drain", async () => {
  const release = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<AbortSignal>();
  let observed: unknown;
  const dispatcher = localDispatcher(
    {
      async held(context) {
        entered.resolve(context.signal);
        await release.promise;
        observed = [context.metadata, [
          ...await new Response(context.input).bytes(),
        ]];
      },
    },
    1,
    "local",
  );
  assertThrows(() =>
    dispatcher.dispatch({
      workload: "held",
      metadata: { invalid: (() => {}) as unknown as string },
    })
  );
  const metadata = { nested: { value: "captured" } };
  const body = new Uint8Array([1]);
  const work = await dispatcher.dispatch({ workload: "held", metadata, body });
  const output = work.output.pipeTo(new WritableStream()).catch(() =>
    undefined
  );
  const signal = await entered.promise;
  metadata.nested.value = "changed";
  body[0] = 2;
  let drained = false;
  const shutdown = dispatcher.drain().then(() => {
    drained = true;
  });
  assertEquals((await work.completed).status, "cancelled");
  assertEquals(signal.aborted, true);
  assertEquals(drained, false);
  await assertRejects(
    () => dispatcher.dispatch({ workload: "held" }),
    Error,
    "capacity",
  );
  release.resolve();
  await shutdown;
  await output;
  assertEquals(observed, [{ nested: { value: "captured" } }, [1]]);
});
