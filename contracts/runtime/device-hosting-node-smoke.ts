// Bundle with deno bundle, then execute the emitted module with native Node.
// Requires COPILOTZ_TEST_POSTGRES_URL and a resolvable pg installation.
import process from "node:process";
import { createTestDatabase } from "../../runtime/testing/ominipg.ts";
import {
  createTestCopilotz,
  defineTestServerFacade,
} from "../../runtime/testing/server-authorization.test.ts";
import { defineCollection } from "../../index.ts";
import { listen } from "../../runtime/adapters/node/index.ts";
import {
  createCopilotzClient,
  createDeviceTransport,
} from "../../client/index.ts";
const schema = `device_native_${crypto.randomUUID().replaceAll("-", "")}`;
const entry = defineCollection({
  name: "entry",
  schema: {
    type: "object",
    properties: { id: { type: "string" }, active: { type: "boolean" } },
    required: ["id"],
  },
});
const url = process.env.COPILOTZ_TEST_POSTGRES_URL;
if (!url) throw new Error("COPILOTZ_TEST_POSTGRES_URL is required");
const database = await createTestDatabase({
  url,
  ...(process.env.COPILOTZ_NODE_PG_MODULE
    ? {
      pgProvider: { moduleSpecifier: process.env.COPILOTZ_NODE_PG_MODULE },
    }
    : {}),
});
const app = await createTestCopilotz({
  database,
  databaseSchema: schema,
  namespace: "main",
  collections: {
    entry,
    session: defineCollection({ name: "session", schema: entry.schema }),
  },
  resources: {
    server: {
      default: defineTestServerFacade({
        expose: { collections: { include: ["entry"] } },
        authenticate(request) {
          return request.headers.get("authorization") === "Bearer session"
            ? {}
            : new Response(null, { status: 403 });
        },
        async evaluate(_request, { read }) {
          return (await read.get("session", "viewer"))?.active
            ? {}
            : new Response(null, { status: 403 });
        },
      }),
    },
  },
});
let device: ReturnType<typeof createDeviceTransport> | undefined;
async function until(check: () => boolean) {
  const deadline = Date.now() + 15000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}
try {
  await app.collections.session.create({ id: "viewer", active: true });
  const listener = await listen(app);
  const baseUrl = new URL("api", listener.url).href;
  device = createDeviceTransport({
    url: baseUrl.replace("http", "ws") + "/device",
    credentials: () => ({ authorization: "Bearer session" }),
  });
  const live = createCopilotzClient({ baseUrl, device }).collections.observe(
    "entry",
  );
  void live.done.catch(() => {});
  await until(() => live.status === "ready");
  await app.collections.entry.create({ id: "a", active: true });
  await until(() => live.rows.some((row) => row.id === "a"));
  await app.collections.session.update({
    id: "viewer",
    set: { active: false },
  });
  await until(() => live.status === "denied");
  if (live.rows.length) throw new Error("Revoked records retained");
  live.close();
  console.log(
    JSON.stringify({
      runtime: process.version,
      snapshot: true,
      delta: true,
      revoked: true,
    }),
  );
} finally {
  device?.close();
  await app.close();
  await database.query(`DROP SCHEMA "${schema}" CASCADE`);
  await database.close();
}
