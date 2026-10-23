import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  createTestApplication,
  defineTestServerFacade,
} from "../../../runtime/testing/server-authorization.test.ts";
import { createTestDatabase } from "../../../runtime/testing/ominipg.ts";
import { definePlugin } from "@copilotz/copilotz/plugins";
import { corePlugin } from "@copilotz/copilotz/core";
import { coreHttpAdapter } from "../index.ts";
import { createServerFacadeFetchHandler } from "../../../server/facade.ts";
import {
  createCopilotzClient,
  createDeviceTransport,
} from "../../../client/index.ts";
import { reader } from "../../../runtime/testing/subscriptions.ts";
import { messageReadSelection } from "../../core/views/reads.ts";
import type { CollectionRecord } from "@copilotz/copilotz/collections";
import type {
  HttpAdapter,
  HttpReadServices,
} from "../../server/authoring/http-adapter/index.ts";
import { coreVisibilityReads, projectCoreOutput } from "./tool-visibility.ts";

const windowQuery = {
  where: { threadId: "thread" },
  order: { field: "createdAt", direction: "desc" as const },
  limit: 100,
};

Deno.test("visibility: real owner policy admits HTTP and device windows without internal queries", async () => {
  const database = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") ?? ":memory:",
  });
  const schema = `visread_${crypto.randomUUID().replaceAll("-", "")}`;
  const counts = { list: 0, get: 0, query: 0, observe: 0, resolve: 0 };
  const resolvedIds: string[][] = [];
  const adapter: HttpAdapter = {
    ...coreHttpAdapter,
    reads(read, scope, resolve) {
      const measured = Object.fromEntries(
        Object.entries(read).map((
          [name, method],
        ) => [name, (...args: unknown[]) => {
          if (name in counts) counts[name as keyof typeof counts]++;
          return Reflect.apply(method, read, args);
        }]),
      ) as HttpReadServices;
      return coreVisibilityReads(measured, scope, (name, rows, options) => {
        counts.resolve++;
        resolvedIds.push(
          rows.filter((row) => (row.content as unknown[]).length).map((row) =>
            row.id
          ),
        );
        return resolve(name, rows, options);
      });
    },
    routes: [...coreHttpAdapter.routes, {
      id: "test.window",
      method: "GET",
      path: "/window",
      handler: ({ read }) =>
        read.list("message", windowQuery, messageReadSelection),
    }],
  };
  const application = await createTestApplication({
    database,
    databaseSchema: schema,
    namespace: "main",
    plugins: [
      definePlugin({ ...corePlugin, processors: {} }),
      definePlugin({
        id: "test.visibility.http",
        version: "1",
        adapters: { http: { core: adapter } },
      }),
    ],
    resources: {
      server: {
        default: defineTestServerFacade({
          expose: { collections: true },
          authenticate(request) {
            return {
              actor: {
                id: request.headers.get("authorization")?.replace(
                  "Bearer ",
                  "",
                ) ?? "outsider",
              },
            };
          },
          async evaluate(
            _request,
            { intent, scope, read },
          ): Promise<
            import("../../server/shared/contracts.ts").ServerConstraints
          > {
            const input = intent.input as {
              args?: { where?: { threadId?: string } };
            };
            if (
              intent.kind !== "collection" || intent.resource !== "message" ||
              intent.operation !== "list" ||
              input.args?.where?.threadId !== "thread"
            ) {
              return { collections: {} };
            }
            const thread = await read.get("thread", "thread");
            return {
              collections:
                (thread?.participantIds as string[]).includes(scope.actor!.id)
                  ? { message: { where: { threadId: "thread" } } }
                  : {},
            };
          },
        }),
      },
    },
  });
  const handler = createServerFacadeFetchHandler(application, {
    upgradeDevice: (request) => Deno.upgradeWebSocket(request),
  });
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    handler,
  );
  const baseUrl = `http://127.0.0.1:${server.addr.port}/api`;
  const devices: ReturnType<typeof createDeviceTransport>[] = [];
  const resetCounts = () => {
    for (const key of Object.keys(counts) as (keyof typeof counts)[]) {
      counts[key] = 0;
    }
    resolvedIds.length = 0;
  };
  try {
    const records = application.collections.withScope({ namespace: "main" });
    for (const id of ["human", "other", "agent"]) {
      await records.participant.create({
        id,
        externalId: id,
        participantType: id === "agent" ? "agent" : "human",
      });
    }
    await records.thread.create({
      id: "thread",
      participantIds: ["human", "other", "agent"],
    });
    const body = async (id: string, text: string, kind = "text") => {
      const asset = await application.content.assets.publish({
        namespace: "main",
        mediaType: kind === "json" ? "application/json" : "text/plain",
        body: new TextEncoder().encode(text),
        idempotencyKey: id,
      });
      return {
        assetId: asset.id,
        kind,
        role: "body",
        mediaType: asset.mediaType,
      };
    };
    const small = await body("small", "VISIBLE");
    const secret = await body("private", "PRIVATE_RESULT");
    const oversized = await body("oversized", "L".repeat(65537));
    const json = await body("json", '{"secret":true}', "json");
    // Unique bodies exercise the aggregate budget (deduplicated assets count once).
    const budget = await Promise.all(
      Array.from(
        { length: 5 },
        (_, i) => body(`budget-${i}`, String(i).repeat(60000)),
      ),
    );
    for (let i = 0; i < 100; i++) {
      const policy = ["public_status", "requester_only", "public"][i - 97];
      await records.message.create({
        id: `m${String(i).padStart(3, "0")}`,
        threadId: "thread",
        senderId: policy ? "agent" : "human",
        content: [
          policy
            ? secret
            : i === 3
            ? oversized
            : i === 4
            ? json
            : i >= 5 && i < 10
            ? budget[i - 5]
            : small,
        ],
        visibility: policy
          ? { kind: "tool", policy, requesterId: "agent", initiatorId: "human" }
          : { kind: "public" },
        metadata: policy
          ? {
            toolStatus: "completed",
            toolId: "tool",
            toolInvocation: { id: "call", input: "PRIVATE_ARGUMENT" },
            private: "PRIVATE_METADATA",
          }
          : {},
      });
    }
    const checkRows = (rows: readonly CollectionRecord[], viewer: string) => {
      assertEquals(rows.length, 100);
      const byId = new Map(rows.map((row) => [row.id, row]));
      for (
        const [id, readable] of [["m097", viewer !== "other"], [
          "m098",
          viewer === "agent",
        ], ["m099", true]] as const
      ) {
        const row = byId.get(id)!;
        if (!readable) {
          assertEquals(row.content, []);
          assertEquals(
            (row.metadata as Record<string, unknown>).toolStatus,
            "completed",
          );
          assertEquals(JSON.stringify(row).includes("PRIVATE_"), false);
          assert(
            !resolvedIds.at(-1)!.includes(id),
            "unreadable result must not reach content resolution",
          );
        } else {assertEquals(
            (row.content as { value?: string }[])[0].value,
            "PRIVATE_RESULT",
          );}
      }
      assertEquals(
        (byId.get("m003")!.content as { deferred: string }[])[0].deferred,
        "size",
      );
      assertEquals(
        (byId.get("m004")!.content as { resolve: boolean; value?: unknown }[])[
          0
        ].resolve,
        false,
      );
      assertEquals(
        (byId.get("m004")!.content as { value?: unknown }[])[0].value,
        undefined,
      );
      const selected = rows.filter((row) =>
        Number(row.id.slice(1)) >= 5 && Number(row.id.slice(1)) < 10
      ).map((
        row,
      ) => (row.content as { value?: string; deferred?: string }[])[0]);
      assertEquals(
        selected.filter((entry) => entry.value !== undefined).length,
        4,
      );
      assertEquals(
        selected.filter((entry) => entry.deferred === "budget").length,
        1,
      );
      assertEquals(
        (byId.get("m050")!.content as { value: string }[])[0].value,
        "VISIBLE",
      );
    };
    for (const viewer of ["human", "other", "agent"]) {
      const headers = { authorization: `Bearer ${viewer}` };
      resetCounts();
      const response = await handler(
        new Request(`${baseUrl}/window`, { headers }),
      );
      assertEquals(response.status, 200, await response.clone().text());
      const result = await response.json();
      checkRows(result.data, viewer);
      assertEquals(counts, {
        list: 1,
        get: 0,
        query: 0,
        observe: 0,
        resolve: 1,
      });
      console.log(`HTTP 100-row window (${viewer}): ${JSON.stringify(counts)}`);
      const client = createCopilotzClient({
        baseUrl,
        getRequestHeaders: () => headers,
      });
      const listed = await client.collections.list("message", windowQuery) as {
        data: CollectionRecord[];
      };
      assertEquals(listed.data.length, 100);
      assertEquals(
        (listed.data.find((row) => row.id === "m098")!.content as unknown[])
          .length,
        viewer === "agent" ? 1 : 0,
      );
      await assertRejects(() =>
        client.collections.query("message", "history", {
          threadId: "thread",
          view: "all",
        })
      );
      await assertRejects(() =>
        client.collections.list("message", { where: { threadId: "foreign" } })
      );
      resetCounts();
      const device = createDeviceTransport({
        url: baseUrl.replace("http", "ws") + "/device",
        credentials: () => headers,
        socket: (url) => new WebSocket(url),
      });
      devices.push(device);
      const subscription = await device.observe(
        "message",
        windowQuery,
        messageReadSelection,
      );
      const frames = reader(subscription);
      try {
        const snapshot = await frames.next();
        assert(snapshot.t === "snapshot", JSON.stringify(snapshot));
        checkRows(snapshot.rows, viewer);
        assertEquals(counts, {
          list: 0,
          get: 0,
          query: 0,
          observe: 1,
          resolve: 1,
        });
        console.log(
          `Device 100-row snapshot (${viewer}): ${JSON.stringify(counts)}`,
        );
        resetCounts();
        await records.message.update({
          id: "m098",
          set: {
            metadata: { toolStatus: "failed", private: "PRIVATE_FAILURE" },
          },
        });
        const batch = await frames.next();
        assert(batch.t === "batch", JSON.stringify(batch));
        const changed = batch.changes.find((change) =>
          change.record?.id === "m098"
        )!.record!;
        assertEquals(
          (changed.metadata as Record<string, unknown>).toolStatus,
          "failed",
        );
        if (viewer !== "agent") {
          assertEquals(changed.content, []);
          assertEquals(JSON.stringify(changed).includes("PRIVATE_"), false);
        }
        assertEquals(counts, {
          list: 0,
          get: 0,
          query: 0,
          observe: 0,
          resolve: 1,
        });
        console.log(`Device batch (${viewer}): ${JSON.stringify(counts)}`);
      } finally {
        subscription.detach();
        device.close();
      }
      await records.message.update({
        id: "m098",
        set: { metadata: { toolStatus: "completed" } },
      });
    }
    const outsider = await handler(
      new Request(`${baseUrl}/window`, {
        headers: { authorization: "Bearer outsider" },
      }),
    );
    assertEquals(outsider.status, 403);
  } finally {
    for (const device of devices) device.close();
    await server.shutdown();
    await application.close();
    await database.query(`DROP SCHEMA "${schema}" CASCADE`);
    await database.close();
  }
});

Deno.test("visibility: projection reads stay constant for 1 and 100 rows, including batches and feeds", async () => {
  for (const size of [1, 100]) {
    const rows: CollectionRecord[] = Array.from({ length: size }, (_, i) => ({
      namespace: "main",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      id: `m${i}`,
      threadId: "thread",
      content: [{ assetId: "private" }],
      visibility: {
        kind: "tool",
        policy: "requester_only",
        requesterId: "agent",
        initiatorId: "human",
      },
      metadata: {
        toolStatus: "completed",
        llmReasoning: [{ assetId: "private-reasoning" }],
        private: "SECRET",
      },
    }));
    const reads: string[] = [], resolutions: number[] = [];
    const base: HttpReadServices = {
      get() {
        reads.push("get");
        return Promise.resolve(rows[0]);
      },
      list() {
        reads.push("list");
        return Promise.resolve(rows);
      },
      query(_collection, name, input) {
        reads.push(`query:${name}`);
        assertEquals(input.viewerParticipantIds, ["human"]);
        assertEquals(input.content, false);
        return Promise.resolve(rows);
      },
      aggregate() {
        throw new Error("Unexpected aggregate");
      },
      observe(_name, _query, options) {
        reads.push("observe");
        assertEquals(options?.content, false);
        return Promise.resolve({
          detach() {},
          frames: {
            async *[Symbol.asyncIterator]() {
              yield {
                t: "snapshot" as const,
                checkpoint: "a",
                rows,
                sequence: "1",
                complete: true as const,
              };
              yield {
                t: "batch" as const,
                checkpoint: "b",
                from: "1",
                to: "2",
                changes: [
                  ...rows.map((record) => ({
                    seq: "2",
                    id: record.id,
                    record,
                  })),
                  { seq: "2", id: "removed", record: null },
                ],
              };
              yield { t: "reset" as const, reason: "scope" };
            },
          },
        });
      },
    };
    const scope = { actor: { id: "human" } } as Parameters<
      typeof coreVisibilityReads
    >[1];
    const read = coreVisibilityReads(base, scope, (_name, projected) => {
      resolutions.push(projected.length);
      for (const row of projected) {
        assertEquals(row.content, []);
        assertEquals(
          (row.metadata as Record<string, unknown>).toolStatus,
          "completed",
        );
        assertEquals(JSON.stringify(row).includes("private-reasoning"), false);
        assertEquals(JSON.stringify(row).includes("SECRET"), false);
      }
      return Promise.resolve(projected);
    });
    await read.get("message", "m0", messageReadSelection);
    assertEquals(reads.splice(0), ["get"]);
    assertEquals(resolutions.splice(0), [1]);
    await read.list("message", windowQuery, messageReadSelection);
    assertEquals(reads.splice(0), ["list"]);
    assertEquals(resolutions.splice(0), [size]);
    await read.query("message", "byThreadId", {
      threadId: "thread",
      viewerParticipantIds: ["agent"],
      ...messageReadSelection,
    });
    assertEquals(reads.splice(0), ["query:byThreadId"]);
    assertEquals(resolutions.splice(0), [size]);
    const stream = await read.observe(
      "message",
      windowQuery,
      messageReadSelection,
    );
    const frames = reader(stream);
    await frames.next();
    assertEquals(reads.splice(0), ["observe"]);
    assertEquals(resolutions.splice(0), [size]);
    const batch = await frames.next();
    assert(batch.t === "batch");
    assertEquals(batch.changes.length, size + 1);
    assertEquals(batch.changes.at(-1)!.record, null);
    assertEquals(reads.splice(0), []);
    assertEquals(resolutions.splice(0), [size]);
    assertEquals(await frames.next(), { t: "reset", reason: "scope" });
    assertEquals(resolutions.splice(0), []);
    const output = await projectCoreOutput(
      {
        type: "message.updated",
        data: { record: rows[0], operation: "update", intent: "SECRET" },
        metadata: {},
      } as Parameters<typeof projectCoreOutput>[0],
      scope,
      read,
      () => Promise.resolve([]),
    );
    assert(output);
    assertEquals(JSON.stringify(output).includes("SECRET"), false);
    assertEquals(reads.splice(0), ["list"]);
    assertEquals(resolutions.splice(0), [size]);
    console.log(
      `${size}-row bound: window 1 read / 1 resolution; batch 0 reads / 1 resolution`,
    );
  }
});
