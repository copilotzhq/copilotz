import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { coreHttpAdapter, createCoreHttpAdapter } from "./index.ts";
import type {
  HttpAdapter,
  HttpHandlerContext,
} from "../../../../server/authoring/http-adapter/index.ts";

const time = "2026-01-01T00:00:00.000Z";
const display = (id: string) => ({
  id,
  namespace: "scope",
  externalId: `external:${id}`,
  participantType: "human",
  name: id,
  metadata: {},
  createdAt: time,
  updatedAt: time,
});
const selectedThread = {
  id: "thread-a",
  namespace: "scope",
  participantIds: ["member-a", "member-b"],
  metadata: {},
  createdAt: time,
  updatedAt: time,
};
const messages = ["member-a", "member-a", "member-b"].map((id, index) => ({
  id: `message-${index}`,
  namespace: "scope",
  threadId: selectedThread.id,
  senderId: id,
  recipientIds: [],
  content: [],
  metadata: {},
  createdAt: time,
  updatedAt: time,
}));
function fixture() {
  const calls: {
    collection: string;
    name: string;
    input: Record<string, unknown>;
  }[] = [];
  const raw: string[] = [];
  let rows: unknown = [display("member-b"), display("member-a")];
  let queryError: Error | undefined;
  let thread = structuredClone(selectedThread);
  let observations = 0;
  const context = {
    request: new Request(
      "https://example.test/threads/thread-a?participantDisplayQuery=untrusted",
    ),
    endpoint: {},
    params: { id: "thread-a" },
    input: {},
    scope: { actor: { id: "viewer" }, namespace: "scope" },
    constraints: { collections: { thread: {} } },
    read: {
      list: () => Promise.resolve([thread]),
      get: (_collection: string, id: string) => {
        raw.push(id);
        return Promise.resolve({
          ...display(id),
          email: "member@example.test",
          metadata: { private: true },
        });
      },
      query: (
        collection: string,
        name: string,
        input: Record<string, unknown>,
      ) => {
        if (collection === "message") return Promise.resolve(messages);
        calls.push({ collection, name, input });
        return queryError ? Promise.reject(queryError) : Promise.resolve(rows);
      },
      aggregate: () => Promise.resolve([]),
    },
    operations: {
      checkpoint: () => Promise.resolve("checkpoint"),
      observe: () => {
        observations++;
        return Promise.resolve(new Response("observation"));
      },
    },
  } as unknown as HttpHandlerContext;
  return {
    context,
    calls,
    raw,
    rows(value: unknown) {
      rows = value;
    },
    fail(error: Error) {
      queryError = error;
    },
    thread(value: typeof thread) {
      thread = value;
    },
    observations: () => observations,
  };
}
function handler(adapter: HttpAdapter, id: string) {
  const route = adapter.routes.find((route) => route.id === id);
  if (!route || !route.handler) throw new Error("Expected handler route.");
  return route.handler;
}

Deno.test("Core display query is static and uses exact route-owned thread, purpose and unique IDs", async () => {
  const options = { participantDisplayQuery: "threadDisplay" };
  const adapter = createCoreHttpAdapter(options);
  options.participantDisplayQuery = "changed";
  for (const route of ["list", "get", "messages"]) {
    const f = fixture();
    const result = await handler(adapter, `core.threads.${route}`)(f.context);
    const output = result instanceof Response ? await result.json() : result;
    assertEquals(f.raw, []);
    assertEquals(f.calls, [{
      collection: "participant",
      name: "threadDisplay",
      input: {
        threadId: "thread-a",
        participantIds: ["member-a", "member-b"],
        purpose: route === "messages" ? "senders" : "participants",
      },
    }]);
    assertEquals(Object.isFrozen(f.calls[0].input), true);
    assertEquals(Object.isFrozen(f.calls[0].input.participantIds), true);
    assertEquals(JSON.stringify(output).includes("email"), false);
    assertEquals(JSON.stringify(output).includes("private"), false);
    if (route === "messages") {
      assertEquals(
        output.data.map((row: { sender: { id: string } }) => row.sender.id),
        ["member-a", "member-a", "member-b"],
      );
    }
  }
});

Deno.test("Core configured display rejects missing, substituted, duplicate, foreign and private projection rows", async (t) => {
  const valid = [display("member-a"), display("member-b")];
  const invalid: [string, unknown][] = [
    ["missing row", valid.slice(0, 1)],
    ["extra row", [...valid, display("extra")]],
    ["duplicate row", [valid[0], valid[0]]],
    ["substituted row", [valid[0], display("substitute")]],
    ["foreign namespace", [valid[0], { ...valid[1], namespace: "other" }]],
    ["email", [valid[0], { ...valid[1], email: "secret@example.test" }]],
    ["metadata", [valid[0], { ...valid[1], metadata: { token: "secret" } }]],
    ["extra field", [valid[0], { ...valid[1], token: "secret" }]],
    ["invalid type", [valid[0], { ...valid[1], participantType: "admin" }]],
    ["nonarray", {}],
  ];
  for (const [name, rows] of invalid) {
    await t.step(name, async () => {
      const f = fixture();
      f.rows(rows);
      await assertRejects(
        () =>
          Promise.resolve(
            handler(
              createCoreHttpAdapter({
                participantDisplayQuery: "threadDisplay",
              }),
              "core.threads.get",
            )(f.context),
          ),
        Error,
        "projection is invalid",
      );
      assertEquals(f.raw, []);
    });
  }
});

Deno.test("Core configured display preserves query refusal and has no raw fallback", async () => {
  const f = fixture();
  const denied = Object.assign(new Error("Forbidden"), {
    code: "forbidden",
    status: 403,
  });
  f.fail(denied);
  const error = await assertRejects(() =>
    Promise.resolve(
      handler(
        createCoreHttpAdapter({ participantDisplayQuery: "missing" }),
        "core.threads.get",
      )(f.context),
    )
  );
  assertEquals(error, denied);
  assertEquals(f.raw, []);
});

Deno.test("Core display bounds requested IDs before query and rejects scope mismatch", async () => {
  for (
    const ids of [
      ["member-a", "member-a"],
      [""],
      Array.from({ length: 1001 }, (_, i) => `id-${i}`),
    ]
  ) {
    const f = fixture();
    f.thread({ ...selectedThread, participantIds: ids });
    await assertRejects(
      () =>
        Promise.resolve(
          handler(
            createCoreHttpAdapter({ participantDisplayQuery: "threadDisplay" }),
            "core.threads.get",
          )(f.context),
        ),
      Error,
      "projection is invalid",
    );
    assertEquals(f.calls.length, 0);
    assertEquals(f.raw, []);
  }
  const f = fixture();
  f.thread({ ...selectedThread, namespace: "other" });
  await assertRejects(
    () =>
      Promise.resolve(
        handler(
          createCoreHttpAdapter({ participantDisplayQuery: "threadDisplay" }),
          "core.threads.get",
        )(f.context),
      ),
    Error,
    "projection is invalid",
  );
  assertEquals(f.calls.length, 0);
});

Deno.test("Core default projection remains unchanged and observe does not acquire display authority", async () => {
  const f = fixture();
  const result = await handler(coreHttpAdapter, "core.threads.get")(f.context);
  assertEquals(f.raw, ["member-a", "member-b"]);
  assertEquals(f.calls, []);
  assertEquals(JSON.stringify(result).includes("member@example.test"), true);
  const observe = fixture();
  await handler(
    createCoreHttpAdapter({ participantDisplayQuery: "threadDisplay" }),
    "core.threads.observe",
  )(observe.context);
  assertEquals(observe.observations(), 1);
  assertEquals(observe.calls, []);
  assertEquals(observe.raw, []);
});

Deno.test("Core rejects malformed static display query names at construction", () => {
  for (const name of ["", " spaces ", "x/route", "a".repeat(129)]) {
    assertThrows(
      () => createCoreHttpAdapter({ participantDisplayQuery: name }),
      TypeError,
      "static query name",
    );
  }
});

Deno.test("Core display batches large selections and refuses the whole response after a later denial", async () => {
  const ids = Array.from({ length: 1000 }, (_, index) => `member-${index}`);
  for (const failBatch of [false, true]) {
    const f = fixture();
    f.thread({ ...selectedThread, participantIds: ids });
    const calls: string[][] = [];
    const context = {
      ...f.context,
      read: {
        ...f.context.read,
        query: (
          _collection: string,
          _name: string,
          input: Record<string, unknown>,
        ) => {
          const batch = input.participantIds as string[];
          calls.push([...batch]);
          if (failBatch && calls.length === 2) {
            return Promise.reject(new Error("Denied later batch"));
          }
          return Promise.resolve(batch.map(display));
        },
      },
    };
    const run = () =>
      Promise.resolve(
        handler(
          createCoreHttpAdapter({ participantDisplayQuery: "threadDisplay" }),
          "core.threads.get",
        )(context),
      );
    if (failBatch) {
      await assertRejects(run, Error, "Denied later batch");
      assertEquals(calls.length, 2);
    } else {
      await run();
      assertEquals(calls.length, 250);
      assertEquals(calls.flat(), ids);
    }
    assertEquals(calls.every((ids) => ids.length <= 4), true);
    assertEquals(f.raw, []);
  }
});
