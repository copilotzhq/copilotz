import { assertEquals } from "@std/assert";

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
  | "session"
  | "closeSession"
>;

const noRemovedConfigurationKeys: RemovedConfigurationKeys extends never ? true
  : false = true;
void noRemovedConfigurationKeys;

const emptyPlugin = definePlugin({
  id: "contract.empty",
  version: "3.0.0",
});

const validConfiguration = {
  namespace: "configuration-contract",
  databaseSchema: "public",
  database: { url: ":memory:", pgliteMemoryProfile: "low-memory" },
  core: {
    knowledge: false,
    finance: false,
  },
  plugins: [emptyPlugin],
  context: { agents: { support: { id: "support", name: "Support" } } },
  engine: {
    leaseMs: 120_000,
    maxAttempts: 3,
    retryCapMs: 30_000,
  },
} as const satisfies CreateCopilotzOptions;

Deno.test("v3 configuration composes plugins, context, persistence, and engine policy", async () => {
  const application = await createCopilotz(validConfiguration);
  try {
    assertEquals(application.config.databaseSchema, "public");
    assertEquals(application.config.declaredPluginIds, ["contract.empty"]);
    assertEquals(application.config.databaseOwnership, "application");
    assertEquals(application.plugins.context.agents.support, {
      id: "support",
      name: "Support",
    });
  } finally {
    await application.shutdown();
  }
});
