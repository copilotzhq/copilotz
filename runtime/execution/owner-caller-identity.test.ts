import { assert, assertEquals, assertThrows } from "@std/assert";
import type { WorkerWorkHandler } from "../../dependencies/oxian-worker.ts";
import { defineAction } from "../actions/define.ts";
import { actionCallerDefinitionId } from "../actions/invoker.ts";
import type { ActionContext } from "../actions/types.ts";
import { createPluginRegistry } from "../plugins/registry.ts";
import { createOwnerWorkerWorkloads } from "./owner-capability-worker.ts";
import {
  type CapabilityCall,
  type CapabilityInvocation,
  decodeCapability,
  encodeCapability,
} from "./owner-capability-wire.ts";
import { snapshotToolStageActionIds } from "../../plugins/core/processors/project-text-result/tool-plan.ts";
import type { CoreToolProcessorContext } from "../../plugins/core/shared/runtime-context.ts";
import type { LlmToolCall } from "../../plugins/llm/shared/contracts.ts";

/** Exercise the real workload/context and wire codec without a database owner. */
async function invoke(
  execute: (context: ActionContext) => unknown | Promise<unknown>,
) {
  const calls: CapabilityCall[] = [];
  const complete = Promise.withResolvers<CapabilityCall>();
  const invocation: CapabilityInvocation = {
    id: "invocation",
    context: "context",
    kind: "action",
    alias: "run",
    args: [{}],
    scope: {
      namespace: "scope",
      databaseSchema: "public",
      operationKey: "operation",
      now: new Date(0).toISOString(),
    },
  };
  const registry = createPluginRegistry({
    actions: {
      toolAlias: defineAction({
        id: "test.registered-tool",
        execute: () => undefined,
      }),
      otherAlias: defineAction({
        id: "test.other-tool",
        execute: () => undefined,
      }),
      run: defineAction({
        id: "test.caller-root",
        execute: (_input: unknown, context: ActionContext) => execute(context),
      }),
    },
  });
  let sent = false;
  const work: Parameters<WorkerWorkHandler>[0] = {
    streamId: "stream",
    workload: "copilotz.delivery.v1",
    metadata: {},
    signal: new AbortController().signal,
    input: new ReadableStream({ start: (controller) => controller.close() }),
    sendMetadata: () => Promise.resolve(),
    async callHost(request) {
      assert(request.body instanceof Uint8Array);
      const call = decodeCapability(request.body) as CapabilityCall;
      calls.push(call);
      let value: unknown;
      if (call.kind === "next") {
        if (!sent) {
          sent = true;
          value = { invocation };
        } else {
          await complete.promise;
          value = { done: true };
        }
      } else if (call.kind === "complete") complete.resolve(call);

      return {
        streamId: "host-call",
        metadata: Promise.resolve({}),
        started: Promise.resolve(),
        cancel: () => Promise.resolve(),
        output: new ReadableStream({
          start(controller) {
            controller.enqueue(encodeCapability({ value }));
            controller.close();
          },
        }),
        completed: Promise.resolve(),
      };
    },
  };
  await createOwnerWorkerWorkloads({ registry })[work.workload](work);
  const result = await complete.promise;
  if (result.error) throw result.error;
  return { calls, value: result.value };
}

Deno.test("worker Action callers retain registered definition identity without minting it from public properties", async () => {
  let retained: ActionContext["actions"][string] | undefined;
  const { value, calls } = await invoke((context) => {
    const caller = context.actions.toolAlias;
    retained = caller;
    assertEquals(actionCallerDefinitionId(caller), "test.registered-tool");
    assertEquals(
      actionCallerDefinitionId(context.actions.otherAlias),
      "test.other-tool",
    );
    assertEquals(typeof caller.prepare, "function");
    Object.assign(caller, { id: "forged", definition: { id: "forged" } });
    assertEquals(actionCallerDefinitionId(caller), "test.registered-tool");
    const copied = Object.assign(() => undefined, caller);
    assertEquals(actionCallerDefinitionId(copied), undefined);
    assertEquals(
      actionCallerDefinitionId({
        id: "test.registered-tool",
        definition: { id: "test.registered-tool" },
      }),
      undefined,
    );
    return "identity checked";
  });
  assertEquals(value, "identity checked");
  assertEquals(calls.filter((c) => c.kind === "call"), []);
  assertThrows(() => retained!({}), Error, "owner_assignment_ended");
});

Deno.test("Core snapshots worker caller identity only for the exact advertised Action", async () => {
  await invoke((context) => {
    const plan = [{
      id: "call",
      action: "toolAlias",
      input: {},
    }] as LlmToolCall[];
    const coreContext = context as unknown as CoreToolProcessorContext;
    assertEquals(snapshotToolStageActionIds(coreContext, plan, ["toolAlias"]), [
      ["test.registered-tool"],
    ]);
    assertEquals(snapshotToolStageActionIds(coreContext, plan, []), [[null]]);
    const substituted = {
      ...context,
      actions: { ...context.actions, toolAlias: context.actions.otherAlias },
    } as unknown as CoreToolProcessorContext;
    assertEquals(snapshotToolStageActionIds(substituted, plan, ["toolAlias"]), [
      ["test.other-tool"],
    ]);
    const forged = {
      ...context,
      actions: {
        toolAlias: Object.assign(() => undefined, {
          id: "test.registered-tool",
        }),
      },
    } as unknown as CoreToolProcessorContext;
    assertEquals(snapshotToolStageActionIds(forged, plan, ["toolAlias"]), [[
      null,
    ]]);
  });
});
