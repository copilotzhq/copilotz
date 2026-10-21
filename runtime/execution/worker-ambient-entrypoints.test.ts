import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { defineAction } from "../actions/define.ts";
import { defineProcessor } from "../plugins/processor.ts";
import { createPluginRegistry } from "../plugins/registry.ts";
import { captureCollectionInvocation } from "../authorization/invocation.ts";
import { hostIngressProof } from "../application/ingress/authority.ts";
import { createOwnerWorkerWorkloads } from "./owner-capability-worker.ts";
import {
  type CapabilityCall,
  type CapabilityInvocation,
  decodeCapability,
  encodeCapability,
} from "./owner-capability-wire.ts";

for (
  const kind of [
    "action",
    "resume",
    "reconcile",
    "processor",
    "processorError",
  ] as const
) {
  Deno.test(`worker ${kind} callback installs authority across awaits and revokes it on completion`, async () => {
    let captured: ReturnType<typeof captureCollectionInvocation>;
    const handler = async () => {
      captured = captureCollectionInvocation();
      assert(captured);
      assertEquals(captured.trustedHost, undefined);
      assertEquals(captured.authority, undefined); // Opaque owner capability, never a wire credential.
      assertThrows(hostIngressProof, Error, "Forbidden");
      await Promise.resolve();
      assertEquals(captureCollectionInvocation(), captured);
      await assertRejects(
        async () => {
          await Promise.resolve();
          return hostIngressProof();
        },
        Error,
        "Forbidden",
      );
      return { status: "indeterminate" as const };
    };
    const registry = createPluginRegistry({
      actions: {
        run: defineAction({
          id: "ambient.run",
          execute: handler,
          resume: handler,
          reconcile: handler,
        }),
      },
      processors: {
        run: defineProcessor({
          id: "ambient.processor",
          on: [{ eventType: "ambient.run" }],
          async handle() {
            await handler();
          },
          async onError() {
            await handler();
            return true;
          },
        }),
      },
    });
    const invocation: CapabilityInvocation = {
      id: "invocation",
      context: "opaque-context",
      kind,
      alias: "run",
      args: [],
      scope: {
        namespace: "space",
        databaseSchema: "public",
        now: new Date().toISOString(),
      },
    };
    let sent = false;
    const done = Promise.withResolvers<CapabilityCall>();
    await createOwnerWorkerWorkloads({ registry })["copilotz.delivery.v1"]({
      streamId: "test",
      workload: "copilotz.delivery.v1",
      metadata: {},
      signal: new AbortController().signal,
      input: new ReadableStream({
        start(c) {
          c.close();
        },
      }),
      sendMetadata: () => Promise.resolve(),
      async callHost(request) {
        assert(request.body instanceof Uint8Array);
        const call = decodeCapability(request.body) as CapabilityCall;
        let value: unknown;
        if (call.kind === "next") {
          if (!sent) {
            sent = true;
            value = { invocation };
          } else {
            await done.promise;
            value = { done: true };
          }
        } else if (call.kind === "complete") done.resolve(call);
        return {
          streamId: "call",
          metadata: Promise.resolve({}),
          started: Promise.resolve(),
          completed: Promise.resolve(),
          cancel: () => Promise.resolve(),
          output: new ReadableStream({
            start(c) {
              c.enqueue(encodeCapability({ value }));
              c.close();
            },
          }),
        };
      },
    });
    assertEquals((await done.promise).error, undefined);
    assert(captured);
    assertThrows(() => captured!.check(), Error, "ended");
    assertEquals(captureCollectionInvocation(), undefined);
  });
}
