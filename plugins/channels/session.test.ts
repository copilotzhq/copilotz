import { assert, assertEquals, assertRejects } from "@std/assert";
import type {
  ApplicationOutput,
  ApplicationSendHandle,
  ApplicationSendInput,
  CopilotzApplication,
} from "@copilotz/copilotz/application";
import { type ChannelSessionEgress, createChannelSession } from "./session.ts";

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
};

function deferred<T>(): Deferred<T> {
  return Promise.withResolvers<T>();
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

const output = (name: string): ApplicationOutput => ({
  type: "stream.output",
  namespace: "session-test",
  streamId: name,
  mediaType: "text/plain",
  kind: "text",
  role: "output",
  metadata: { name },
  payload: new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  }),
  terminal: Promise.resolve({
    outcome: "completed",
    availability: "retained",
    capture: "complete",
    offset: 0,
    terminalAt: new Date(0).toISOString(),
  }),
} as ApplicationOutput);

function fixtureHandle(
  options: Readonly<{
    outputs: ReadableStream<ApplicationOutput>;
    done?: Deferred<void>;
    cancelled?: string[];
    detached?: string[];
  }>,
): ApplicationSendHandle {
  const done = options.done ?? deferred<void>();
  const cancelled = options.cancelled ?? [];
  const detached = options.detached ?? [];
  return {
    operationId: "operation-session-test",
    eventId: "event-session-test",
    correlationId: "correlation-session-test",
    replayCursor: "cursor-session-test",
    outputs: options.outputs,
    done: done.promise,
    async cancel(reason) {
      cancelled.push(reason ?? "");
      done.resolve();
    },
    async detach(reason) {
      detached.push(reason ?? "");
    },
  };
}

function application(
  send: (input: ApplicationSendInput) => Promise<ApplicationSendHandle>,
): Pick<CopilotzApplication, "send"> {
  return { send };
}

function closedOutputs(
  values: readonly ApplicationOutput[] = [],
): ReadableStream<ApplicationOutput> {
  return new ReadableStream({
    start(controller) {
      for (const value of values) controller.enqueue(value);
      controller.close();
    },
  });
}

Deno.test("Channel session maps one input, awaits ordered egress, and done", async () => {
  const seenInputs: ApplicationSendInput[] = [];
  const seenOutputs: string[] = [];
  const detached: string[] = [];
  const sendDone = deferred<void>();
  const handle = fixtureHandle({
    outputs: closedOutputs([output("one"), output("two")]),
    done: sendDone,
    detached,
  });
  const session = createChannelSession(
    application(async (input) => {
      seenInputs.push(input);
      return handle;
    }),
    {
      async ingress(input, signal) {
        assert(!signal.aborted);
        await Promise.resolve();
        return { type: "session.input", payload: { input } };
      },
      async egress(value, signal) {
        assert(!signal.aborted);
        seenOutputs.push((value as { streamId: string }).streamId);
        await Promise.resolve();
      },
    },
  );
  const sending = session.send("hello");
  await flush();
  sendDone.resolve();
  await sending;
  assertEquals(seenInputs, [{
    type: "session.input",
    payload: { input: "hello" },
  }]);
  assertEquals(seenOutputs, ["one", "two"]);
  assertEquals(detached, ["channel_session_completed"]);
});

Deno.test("Channel session interrupts pending admission and suppresses late output", async () => {
  const admission = deferred<ApplicationSendHandle>();
  const cancelled: string[] = [];
  const detached: string[] = [];
  const session = createChannelSession(
    application(() => admission.promise),
    {
      ingress(input, signal) {
        return {
          type: "session.input",
          payload: { input, aborted: signal.aborted },
        };
      },
      egress() {
        throw new Error("stale output must not be delivered");
      },
    },
  );
  const sending = session.send("before-admission");
  await flush();
  await session.interrupt("twilio-barge-in");
  const done = deferred<void>();
  admission.resolve({
    ...fixtureHandle({
      outputs: closedOutputs([output("late")]),
      done,
      cancelled,
      detached,
    }),
  });
  const interruption = await assertRejects(
    () => sending,
    DOMException,
    "twilio-barge-in",
  );
  assertEquals(interruption.name, "AbortError");
  await flush();
  assertEquals(cancelled, ["twilio-barge-in"]);
  assertEquals(detached, []);
  done.resolve();
});

Deno.test("Channel session preserves ordered asynchronous egress", async () => {
  const firstEgress = deferred<void>();
  const order: string[] = [];
  const handleDone = deferred<void>();
  const handle = fixtureHandle({
    outputs: closedOutputs([output("one"), output("two")]),
    done: handleDone,
  });
  const egress: ChannelSessionEgress = async (value) => {
    const id = (value as { streamId: string }).streamId;
    order.push(`start:${id}`);
    if (id === "one") await firstEgress.promise;
    order.push(`end:${id}`);
  };
  const session = createChannelSession(application(async () => handle), {
    ingress: () => ({ type: "ordered.input" }),
    egress,
  });
  const sending = session.send(undefined);
  await flush();
  assertEquals(order, ["start:one"]);
  firstEgress.resolve();
  await flush();
  assertEquals(order, ["start:one", "end:one", "start:two", "end:two"]);
  handleDone.resolve();
  await sending;
});

Deno.test("Channel sessions isolate interruption", async () => {
  const rightDone = deferred<void>();
  const handles = [
    fixtureHandle({ outputs: closedOutputs(), done: deferred<void>() }),
    fixtureHandle({
      outputs: closedOutputs([output("survives")]),
      done: rightDone,
    }),
  ];
  const received: string[] = [];
  let index = 0;
  const app = application(async () => handles[index++]);
  const left = createChannelSession(app, {
    ingress: () => ({ type: "left.input" }),
    egress: () => {
      received.push("left");
    },
  });
  const right = createChannelSession(app, {
    ingress: () => ({ type: "right.input" }),
    egress: (value) => {
      received.push((value as { streamId: string }).streamId);
    },
  });
  const leftSend = left.send(undefined);
  const rightSend = right.send(undefined);
  await flush();
  await left.interrupt("left-only");
  await flush();
  rightDone.resolve();
  await flush();
  await rightSend;
  await assertRejects(() => leftSend, Error, "left-only");
  assertEquals(received, ["survives"]);
});

Deno.test("Channel session stops queued output when operation fails", async () => {
  const failure = new Error("operation failed");
  const done = deferred<void>();
  const egressStarted = deferred<void>();
  const releaseEgress = deferred<void>();
  const seen: string[] = [];
  const detached: string[] = [];
  const handle = fixtureHandle({
    outputs: new ReadableStream({
      start(controller) {
        controller.enqueue(output("before-failure"));
        controller.enqueue(output("queued-after-failure"));
      },
    }),
    done,
    detached,
  });
  const session = createChannelSession(application(async () => handle), {
    ingress: () => ({ type: "failure.input" }),
    egress: async (value) => {
      seen.push((value as { streamId: string }).streamId);
      egressStarted.resolve();
      await releaseEgress.promise;
    },
  });
  const sending = session.send(undefined);
  await egressStarted.promise;
  done.reject(failure);
  releaseEgress.resolve();
  await assertRejects(() => sending, Error, "operation failed");
  assertEquals(seen, ["before-failure"]);
  assertEquals(detached.length, 1);
});

Deno.test("Channel session cancels on egress failure without waiting for durable cancel", async () => {
  const cancel = deferred<void>();
  const cancelled: string[] = [];
  const handle: ApplicationSendHandle = {
    ...fixtureHandle({
      outputs: new ReadableStream({
        start(controller) {
          controller.enqueue(output("bad"));
        },
      }),
      cancelled,
    }),
    async cancel(reason) {
      cancelled.push(reason ?? "");
      await cancel.promise;
    },
  };
  const session = createChannelSession(application(async () => handle), {
    ingress: () => ({ type: "egress-failure.input" }),
    egress: () => Promise.reject(new Error("provider write failed")),
  });
  await assertRejects(
    () => session.send(undefined),
    Error,
    "provider write failed",
  );
  assertEquals(cancelled, ["provider write failed"]);
  cancel.resolve();
});

Deno.test("Channel session supersedes pending admission and closes idempotently", async () => {
  const firstAdmission = deferred<ApplicationSendHandle>();
  const calls: ApplicationSendInput[] = [];
  const secondDone = deferred<void>();
  const secondHandle = fixtureHandle({
    outputs: closedOutputs(),
    done: secondDone,
  });
  let sends = 0;
  const session = createChannelSession(
    application(async (input) => {
      calls.push(input);
      sends += 1;
      return sends === 1 ? firstAdmission.promise : secondHandle;
    }),
    {
      ingress: (input) => ({ type: "supersede.input", payload: { input } }),
      egress: () => undefined,
    },
  );
  const first = session.send("first");
  await flush();
  const second = session.send("second");
  const firstDone = deferred<void>();
  const firstCancelled: string[] = [];
  firstAdmission.resolve({
    ...fixtureHandle({
      outputs: closedOutputs([output("stale")]),
      done: firstDone,
      cancelled: firstCancelled,
    }),
  });
  await flush();
  await assertRejects(() => first, Error, "superseded");
  secondDone.resolve();
  await second;
  await session.close();
  await session.close();
  await assertRejects(() => session.send("after-close"), Error, "closed");
  assertEquals(calls.map((entry) => entry.payload), [
    { input: "first" },
    { input: "second" },
  ]);
  assertEquals(firstCancelled, ["Channel session turn superseded."]);
});
