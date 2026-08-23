import { assertEquals } from "@std/assert";
import { defineAction } from "./define.ts";
import { createActionCallers } from "./invoker.ts";
import type {
  ActionCompletedData,
  ActionContext,
  ActionFailedData,
  ActionLifecycleEmitter,
  ActionLifecycleInput,
} from "./types.ts";

Deno.test("root Action identity combines host invocation and local operation", async () => {
  const terminal = new Map<
    string,
    ActionCompletedData | ActionFailedData
  >();
  const emitted: ActionLifecycleInput[] = [];
  const lifecycle: ActionLifecycleEmitter = {
    emit(input) {
      emitted.push(input);
      if (
        input.status === "completed" || input.status === "failed" ||
        input.status === "cancelled"
      ) {
        terminal.set(input.actionRunId, input);
      }
      return Promise.resolve(undefined as never);
    },
    terminal: (actionRunId) =>
      Promise.resolve(terminal.get(actionRunId) ?? null),
  };
  let executions = 0;
  const echo = defineAction({
    id: "test.echo",
    execute(input: Readonly<{ value: number }>) {
      executions += 1;
      return input;
    },
  });
  let hostInvocationKey = "event-1:action:1:test.echo";
  const actions = createActionCallers({ echo }, {
    actionLifecycle: lifecycle,
    createInvocationKey: () => hostInvocationKey,
    createContext: () => Object.freeze({}) as ActionContext,
  });

  assertEquals(
    await actions.echo({ value: 1 }, { operationKey: "core-message-input" }),
    { value: 1 },
  );
  assertEquals(
    await actions.echo({ value: 1 }, { operationKey: "core-message-input" }),
    { value: 1 },
  );
  hostInvocationKey = "event-2:action:1:test.echo";
  assertEquals(
    await actions.echo({ value: 2 }, { operationKey: "core-message-input" }),
    { value: 2 },
  );

  assertEquals(executions, 2);
  assertEquals(
    emitted.filter((event) => event.status === "invoked").map((event) =>
      event.actionRunId
    ),
    [
      "event-1:action:1:test.echo:core-message-input",
      "event-2:action:1:test.echo:core-message-input",
    ],
  );
});
