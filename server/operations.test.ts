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

function testApplication(
  options: Readonly<{
    operations?: Readonly<{
      list(input: unknown): Promise<readonly OperationRecord[]>;
      maxEventPosition(input: unknown): Promise<string | undefined>;
      listStreams(input: unknown): Promise<readonly []>;
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
    operations: options.operations ?? {
      async list() {
        return [];
      },
      async maxEventPosition() {
        return undefined;
      },
      async listStreams() {
        return [];
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
) {
  return await createHttpOperations(
    application,
    testScope(),
    constraints,
    testRead(),
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
