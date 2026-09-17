import { assertEquals, assertRejects } from "@std/assert";
import type {
  ApplicationOperationAttachment,
  ApplicationOperationStatus,
  InternalCopilotzApplication,
} from "../runtime/application/types.ts";
import type { OperationRecord } from "../runtime/streams/catalog.ts";
import type { HttpReadServices } from "../plugins/server/authoring/http-adapter/index.ts";
import type {
  ServerAuthorizedScope,
  ServerConstraints,
} from "../plugins/server/shared/contracts.ts";
import { createHttpOperations } from "./operations.ts";

type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve(value: T): void;
}>;

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => resolve = next);
  return { promise, resolve };
}

function status(
  operationId: string,
  metadata: Readonly<Record<string, unknown>> = {},
): ApplicationOperationStatus {
  return {
    operationId,
    namespace: "tenant",
    correlationId: `correlation-${operationId}`,
    state: "running",
    metadata,
    acceptedAt: "2026-09-16T00:00:00.000Z",
    updatedAt: "2026-09-16T00:00:00.000Z",
  };
}

function operation(
  operationId: string,
  metadata: Readonly<Record<string, unknown>>,
): OperationRecord {
  return {
    operationId,
    namespace: "tenant",
    rootEventId: `event-${operationId}`,
    correlationId: `correlation-${operationId}`,
    metadata,
    state: "running",
    acceptedAt: "2026-09-16T00:00:00.000Z",
    updatedAt: "2026-09-16T00:00:00.000Z",
  };
}

function closedAttachment(
  operationId: string,
  detach: () => void = () => undefined,
): ApplicationOperationAttachment {
  const outputs = new ReadableStream({
    start(controller) {
      controller.close();
    },
  });
  return {
    operationId,
    replayCursor: "{}",
    outputs,
    done: Promise.resolve(),
    async detach() {
      detach();
    },
  };
}

function testRead(): HttpReadServices {
  return {
    async get(collection, id) {
      return collection === "thread"
        ? {
          id,
          namespace: "tenant",
          createdAt: "2026-09-16T00:00:00.000Z",
          updatedAt: "2026-09-16T00:00:00.000Z",
        }
        : null;
    },
    async list() {
      return [];
    },
    async aggregate() {
      return [];
    },
    async query() {
      return [];
    },
  };
}

function testScope(): ServerAuthorizedScope {
  return { namespace: "tenant", databaseSchema: "test" };
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withDeadline<T>(
  promise: Promise<T>,
  milliseconds: number,
  message: string,
  onTimeout?: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          onTimeout?.();
          reject(new Error(message));
        }, milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function testApplication(
  options: Readonly<{
    operations?: Readonly<{
      list(input: unknown): Promise<readonly OperationRecord[]>;
      maxEventPosition(input: unknown): Promise<string | undefined>;
      listStreams(input: unknown): Promise<readonly []>;
      onChange?(listener: (operationId: string) => void): Promise<() => void>;
    }>;
    attach(input: unknown): Promise<ApplicationOperationAttachment>;
    operationStatus(input: unknown): Promise<ApplicationOperationStatus | null>;
  }>,
): InternalCopilotzApplication {
  const application = {
    config: {
      namespace: "tenant",
      databaseSchema: "test",
      pluginIds: [],
      databaseOwnership: "injected" as const,
    },
    operations: options.operations
      ? {
        ...options.operations,
        onChange: options.operations.onChange ?? (async () => () => undefined),
      }
      : {
        async list() {
          return [];
        },
        async maxEventPosition() {
          return undefined;
        },
        async listStreams() {
          return [];
        },
        async onChange() {
          return () => undefined;
        },
      },
    databaseScope: async () => application,
    attach: options.attach,
    operationStatus: options.operationStatus,
  };
  return application as unknown as InternalCopilotzApplication;
}

async function createOperations(
  application: InternalCopilotzApplication,
  constraints: ServerConstraints = {},
  read: HttpReadServices = testRead(),
) {
  return await createHttpOperations(
    application,
    testScope(),
    constraints,
    read,
  );
}

Deno.test("late operation attachments are detached after observation abort", async () => {
  const attachmentReady = deferred<ApplicationOperationAttachment>();
  const attachStarted = deferred<void>();
  let detachCalls = 0;
  let outputPulls = 0;
  const application = testApplication({
    attach: async () => {
      attachStarted.resolve();
      return await attachmentReady.promise;
    },
    operationStatus: async () => status("operation"),
  });
  const operations = await createOperations(application);
  const controller = new AbortController();
  const observation = await operations.observe({
    operationIds: ["operation"],
    signal: controller.signal,
  });
  await attachStarted.promise;
  controller.abort("client_closed");
  const outputs = new ReadableStream({
    pull() {
      outputPulls++;
      return new Promise<void>(() => undefined);
    },
  }, { highWaterMark: 0 });
  attachmentReady.resolve({
    operationId: "operation",
    replayCursor: "{}",
    outputs,
    done: Promise.resolve(),
    async detach() {
      detachCalls++;
    },
  });

  await observation.done;
  assertEquals(detachCalls, 1);
  assertEquals(outputPulls, 0);
});

Deno.test("thread discovery authorizes nested operation metadata without status N+1 reads", async () => {
  const statusCalls: unknown[] = [];
  const record = operation("operation", {
    operationMetadata: {
      access: { roles: ["owner", "editor"] },
    },
  });
  const application = testApplication({
    attach: async () => closedAttachment("operation"),
    operationStatus: async (input) => {
      statusCalls.push(input);
      return status("operation", {
        access: { roles: ["owner", "editor"] },
      });
    },
    operations: {
      async list() {
        return [record];
      },
      async maxEventPosition() {
        return "0";
      },
      async listStreams() {
        return [];
      },
    },
  });
  const operations = await createOperations(application, {
    operations: { metadata: { access: { roles: ["owner", "editor"] } } },
  });
  const controller = new AbortController();
  const observation = await operations.observe({
    threadId: "thread",
    signal: controller.signal,
  });
  controller.abort("test_finished");
  await observation.done;
  assertEquals(statusCalls.length, 0);
});

Deno.test("thread discovery rejects nested operation metadata that does not match", async () => {
  const application = testApplication({
    attach: async () => closedAttachment("operation"),
    operationStatus: async () => status("operation"),
    operations: {
      async list() {
        return [operation("operation", {
          operationMetadata: { access: { roles: ["viewer"] } },
        })];
      },
      async maxEventPosition() {
        return "0";
      },
      async listStreams() {
        return [];
      },
    },
  });
  const operations = await createOperations(application, {
    operations: { metadata: { access: { roles: ["owner"] } } },
  });
  const error = await assertRejects(() =>
    operations.observe({ threadId: "thread" })
  );
  assertEquals((error as { code?: string }).code, "operation_not_found");
  assertEquals((error as { status?: number }).status, 404);
});

Deno.test("thread observation discovers only notified operations", async () => {
  const initial = operation("initial", { operationMetadata: {} });
  const notified = operation("notified", { operationMetadata: {} });
  const notifiedAgain = operation("notified-again", {
    operationMetadata: {},
  });
  const listInputs: unknown[] = [];
  const targetedDiscovery = deferred<void>();
  let targetedDiscoveryCount = 0;
  let notify!: (operationId: string) => void;
  const application = testApplication({
    attach: async (input) =>
      closedAttachment(
        (input as { operationId: string }).operationId,
      ),
    operationStatus: async () => status("operation"),
    operations: {
      async list(input) {
        listInputs.push(input);
        const operationIds = (input as { operationIds?: readonly string[] })
          .operationIds;
        if (operationIds?.length) {
          targetedDiscoveryCount++;
          if (targetedDiscoveryCount === 2) targetedDiscovery.resolve();
        }
        return operationIds?.length
          ? operationIds.includes(notified.operationId)
            ? [notified]
            : operationIds.includes(notifiedAgain.operationId)
            ? [notifiedAgain]
            : []
          : [initial];
      },
      async maxEventPosition() {
        return "0";
      },
      async listStreams() {
        return [];
      },
      async onChange(listener) {
        notify = listener;
        return () => undefined;
      },
    },
  });
  const operations = await createOperations(application);
  const controller = new AbortController();
  const observation = await operations.observe({
    threadId: "thread",
    signal: controller.signal,
  });
  notify(notified.operationId);
  notify(notifiedAgain.operationId);
  await withDeadline(
    targetedDiscovery.promise,
    2_000,
    "Timed out waiting for targeted discovery.",
    () => controller.abort("targeted_discovery_timeout"),
  );
  for (let index = 0; index < 4; index++) notify(notified.operationId);
  await pause(300);
  controller.abort("test_finished");
  await observation.done;
  assertEquals(listInputs.length, 3);
  assertEquals(
    listInputs.slice(1).map((input) =>
      (input as { operationIds?: readonly string[] }).operationIds
    ),
    [[notified.operationId], [notifiedAgain.operationId]],
  );
});

Deno.test("idle thread observation avoids full discovery scans", async () => {
  let listCalls = 0;
  const application = testApplication({
    attach: async () => closedAttachment("initial"),
    operationStatus: async () => status("initial"),
    operations: {
      async list() {
        listCalls++;
        return [operation("initial", { operationMetadata: {} })];
      },
      async maxEventPosition() {
        return "0";
      },
      async listStreams() {
        return [];
      },
    },
  });
  const operations = await createOperations(application);
  const controller = new AbortController();
  const observation = await operations.observe({
    threadId: "thread",
    signal: controller.signal,
  });
  await pause(700);
  controller.abort("test_finished");
  await observation.done;
  assertEquals(listCalls, 1);
});

Deno.test("idle thread observation still validates thread access", async () => {
  let threadReads = 0;
  let removeCalls = 0;
  const application = testApplication({
    attach: async () => closedAttachment("initial"),
    operationStatus: async () => status("initial"),
    operations: {
      async list() {
        return [operation("initial", { operationMetadata: {} })];
      },
      async maxEventPosition() {
        return "0";
      },
      async listStreams() {
        return [];
      },
      async onChange() {
        return () => removeCalls++;
      },
    },
  });
  const read: HttpReadServices = {
    ...testRead(),
    async get(collection, id) {
      if (collection === "thread") {
        threadReads++;
        if (threadReads > 1) return null;
      }
      return {
        id,
        namespace: "tenant",
        createdAt: "2026-09-16T00:00:00.000Z",
        updatedAt: "2026-09-16T00:00:00.000Z",
      };
    },
  };
  const operations = await createOperations(application, {}, read);
  const observation = await operations.observe({ threadId: "thread" });
  const error = await assertRejects(() => observation.done);
  assertEquals((error as { code?: string }).code, "thread_not_found");
  assertEquals(threadReads, 2);
  assertEquals(removeCalls, 1);
});

Deno.test("missed change hints recover on the bounded safety resync", async () => {
  let listCalls = 0;
  let visible = false;
  const attached: string[] = [];
  const application = testApplication({
    attach: async (input) => {
      const operationId = (input as { operationId: string }).operationId;
      attached.push(operationId);
      return closedAttachment(operationId);
    },
    operationStatus: async () => status("initial"),
    operations: {
      async list() {
        listCalls++;
        return visible
          ? [
            operation("initial", { operationMetadata: {} }),
            operation("missed", { operationMetadata: {} }),
          ]
          : [operation("initial", { operationMetadata: {} })];
      },
      async maxEventPosition() {
        return "0";
      },
      async listStreams() {
        return [];
      },
    },
  });
  const operations = await createOperations(application);
  const controller = new AbortController();
  const observation = await operations.observe({
    threadId: "thread",
    signal: controller.signal,
  });
  await pause(300);
  visible = true;
  await pause(5_250);
  controller.abort("test_finished");
  await observation.done;
  assertEquals(listCalls, 2);
  assertEquals(attached, ["initial", "missed"]);
});

Deno.test("thread observation overflow requests one bounded full resync", async () => {
  let notify!: (operationId: string) => void;
  let listCalls = 0;
  const application = testApplication({
    attach: async () => closedAttachment("initial"),
    operationStatus: async () => status("initial"),
    operations: {
      async list() {
        listCalls++;
        return [];
      },
      async maxEventPosition() {
        return "0";
      },
      async listStreams() {
        return [];
      },
      async onChange(listener) {
        notify = listener;
        return () => undefined;
      },
    },
  });
  const operations = await createOperations(application);
  const controller = new AbortController();
  const observation = await operations.observe({
    threadId: "thread",
    signal: controller.signal,
  });
  for (let index = 0; index < 33; index++) notify(`operation-${index}`);
  await pause(350);
  controller.abort("test_finished");
  await observation.done;
  assertEquals(listCalls, 2);
});

Deno.test("thread observation removes its change listener on initial failure and abort", async () => {
  let removeCalls = 0;
  const failing = testApplication({
    attach: async () => closedAttachment("operation"),
    operationStatus: async () => status("operation"),
    operations: {
      async list() {
        throw new Error("discovery failed");
      },
      async maxEventPosition() {
        return "0";
      },
      async listStreams() {
        return [];
      },
      async onChange() {
        return () => removeCalls++;
      },
    },
  });
  const failingOperations = await createOperations(failing);
  const failureController = new AbortController();
  const failure = await withDeadline(
    assertRejects(() =>
      failingOperations.observe({
        threadId: "thread",
        signal: failureController.signal,
      })
    ),
    2_000,
    "Timed out waiting for initial discovery failure.",
    () => failureController.abort("initial_failure_timeout"),
  );
  void failure;
  assertEquals(removeCalls, 1);

  let notify!: (operationId: string) => void;
  const running = testApplication({
    attach: async () => closedAttachment("operation"),
    operationStatus: async () => status("operation"),
    operations: {
      async list() {
        return [operation("operation", { operationMetadata: {} })];
      },
      async maxEventPosition() {
        return "0";
      },
      async listStreams() {
        return [];
      },
      async onChange(listener) {
        notify = listener;
        return () => removeCalls++;
      },
    },
  });
  const runningOperations = await createOperations(running);
  const controller = new AbortController();
  const observation = await runningOperations.observe({
    threadId: "thread",
    signal: controller.signal,
  });
  notify("operation");
  controller.abort("test_finished");
  await withDeadline(
    observation.done,
    2_000,
    "Timed out waiting for observation abort.",
    () => controller.abort("abort_timeout"),
  );
  assertEquals(removeCalls, 2);

  const subscription = deferred<() => void>();
  let lateRemoveCalls = 0;
  const late = testApplication({
    attach: async () => closedAttachment("operation"),
    operationStatus: async () => status("operation"),
    operations: {
      async list() {
        return [];
      },
      async maxEventPosition() {
        return "0";
      },
      async listStreams() {
        return [];
      },
      async onChange() {
        return await subscription.promise;
      },
    },
  });
  const lateOperations = await createOperations(late);
  const lateController = new AbortController();
  const pendingObserve = lateOperations.observe({
    threadId: "thread",
    signal: lateController.signal,
  });
  lateController.abort("test_finished");
  subscription.resolve(() => lateRemoveCalls++);
  const lateObservation = await pendingObserve;
  await lateObservation.done;
  assertEquals(lateRemoveCalls, 1);
});
