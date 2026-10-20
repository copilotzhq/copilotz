import { assert, assertEquals } from "@std/assert";
import { createCopilotzApplication } from "../runtime/application/application.ts";
import { createTestDatabase } from "../runtime/testing/ominipg.ts";
import { defineCollection } from "../runtime/collections/definition.ts";
import {
  type AuthenticatedAuthority,
  credentialValidity,
} from "../runtime/authorization/authority.ts";
import { createHttpReads } from "./reads.ts";
import { createCopilotzClient } from "../client/index.ts";
import { reader } from "../runtime/testing/subscriptions.ts";

Deno.test("application and adapter observe share owner push with the SDK view handle", async () => {
  const db = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") ?? ":memory:",
  });
  const schema = `subs_app_${crypto.randomUUID().replaceAll("-", "")}`;
  const entry = defineCollection({
    name: "entry",
    schema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  });
  const application = await createCopilotzApplication({
    database: db,
    databaseSchema: schema,
    namespace: "main",
    collections: { entry },
    authorization: {
      collections: { entry: { id: "app", revision: "1" } },
      actions: {},
      policies: {
        app: {
          revision: "1",
          sources: [],
          evaluate() {
            return { collections: { entry: {} } };
          },
        },
      },
    },
  });
  const authority: AuthenticatedAuthority = {
    version: 1,
    principal: { kind: "api-key", id: "key" },
    scope: {
      owner: "schema",
      databaseSchema: schema,
      namespace: "main",
      tenant: "tenant",
      bindings: {},
    },
    policy: { id: "app", revision: "1" },
    validity: credentialValidity(new Date()),
    requestFacts: {
      endpoint: "entries",
      transport: "http",
      operation: "read",
      params: {},
      input: null,
    },
    provenance: { ingress: "http", source: "request" },
    authorityBasis: { kind: "credential", id: "key" },
    dependencies: [],
  };
  try {
    const host = await application.host.collections.entry.observe({}, {
      authority,
    });
    const first = await reader(host).next();
    assert(first.t === "snapshot");
    assertEquals(first.rows, []);
    host.detach();
    const read = await createHttpReads(application, {
      authority,
      namespace: "main",
      databaseSchema: schema,
    });
    const client = createCopilotzClient({ baseUrl: "/api", device: read });
    const snapshot = Promise.withResolvers<void>(),
      changed = Promise.withResolvers<void>();
    const live = client.collections.observe("entry", {}, {
      onChange(rows, frame) {
        if (frame.t === "snapshot") snapshot.resolve();
        if (rows.some((row) => row.id === "a")) changed.resolve();
      },
    });
    try {
      await snapshot.promise;
      await application.host.collections.entry.create({ id: "a" });
      await changed.promise;
      // The callback sees proposed state; allow its successful application to finish.
      await new Promise((resolve) => setTimeout(resolve, 0));
      assertEquals(live.rows.map((row) => row.id), ["a"]);
      assert(live.checkpoint);
      assert(BigInt(live.sequence!) > BigInt(first.sequence));
    } finally {
      live.close();
      await live.done;
    }
  } finally {
    await application.close();
    await db.query(`DROP SCHEMA "${schema}" CASCADE`);
    await db.close();
  }
});
