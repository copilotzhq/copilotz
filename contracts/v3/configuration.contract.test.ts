import { assertEquals, assertRejects } from "@std/assert";

import {
  createCopilotz,
  type CreateCopilotzOptions,
  definePlugin,
} from "../../index.ts";

type RemovedConfigurationKeys = Extract<
  keyof CreateCopilotzOptions,
  | "dbConfig"
  | "dbInstance"
  | "agents"
  | "tools"
  | "processors"
  | "queueTTL"
  | "queueId"
  | "ackMode"
  | "resourcesPath"
  | "useWebWorker"
>;

const noRemovedConfigurationKeys: RemovedConfigurationKeys extends never ? true
  : false = true;
void noRemovedConfigurationKeys;

const emptyPlugin = definePlugin({
  manifest: { id: "contract.empty", version: "3.0.0", provides: {} },
  resources: {},
});

const validConfiguration = {
  namespace: "configuration-contract",
  schema: "public",
  database: { url: ":memory:", pgliteMemoryProfile: "low-memory" },
  core: {
    knowledge: false,
    finance: false,
  },
  plugins: [emptyPlugin],
  resources: { agents: [{ id: "support", name: "Support" }] },
  engine: {
    leaseMs: 120_000,
    maxAttempts: 3,
    retryCapMs: 30_000,
  },
} as const satisfies CreateCopilotzOptions;

Deno.test("v3 configuration composes plugins, resources, persistence, and engine policy", async () => {
  const application = await createCopilotz(validConfiguration);
  try {
    assertEquals(application.config.schema, "public");
    assertEquals(application.config.declaredPluginIds, ["contract.empty"]);
    assertEquals(application.config.sessionOwnership, "application");
    assertEquals(application.plugins.get("agents", "support"), {
      id: "support",
      name: "Support",
    });
  } finally {
    await application.shutdown();
  }
});

Deno.test("v3 persistence ownership inputs are unambiguous", async () => {
  await assertRejects(
    () =>
      createCopilotz({
        namespace: "invalid",
        core: false,
        session: {
          query: async () => ({ rows: [] }),
          transaction: async (operation) =>
            await operation({ query: async () => ({ rows: [] }) }),
        },
        database: { url: ":memory:" },
      }),
    TypeError,
    "either session or database",
  );
});
