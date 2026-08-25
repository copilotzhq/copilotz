import { assertEquals } from "@std/assert";

import { createCopilotz, type CreateCopilotzOptions } from "../../index.ts";
import { definePlugin } from "@copilotz/copilotz/plugins";
import { createCopilotzApplication } from "../../runtime/application/application.ts";

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

Deno.test("package self-references resolve through name and exports", async () => {
  const repositoryRoot = new URL("../../", import.meta.url);
  const configuration = JSON.parse(
    await Deno.readTextFile(new URL("deno.json", repositoryRoot)),
  ) as {
    name: string;
    exports: Record<string, string>;
    imports: Record<string, string>;
  };

  assertEquals(configuration.name, "@copilotz/copilotz");
  assertEquals(
    Object.keys(configuration.imports).filter((specifier) =>
      specifier === configuration.name ||
      specifier.startsWith(`${configuration.name}/`)
    ),
    [],
  );
  for (const [subpath, target] of Object.entries(configuration.exports)) {
    const specifier = subpath === "."
      ? configuration.name
      : configuration.name + subpath.slice(1);
    assertEquals(
      import.meta.resolve(specifier),
      new URL(target, repositoryRoot).href,
      specifier,
    );
  }
});

const emptyPlugin = definePlugin({
  id: "contract.empty",
  version: "3.0.0",
});

const validConfiguration = {
  namespace: "configuration-contract",
  databaseSchema: "public",
  database: { url: ":memory:", pgliteMemoryProfile: "low-memory" },
  plugins: [emptyPlugin],
  resources: {
    agents: { support: { id: "support", name: "Support" } },
  },
  engine: {
    leaseMs: 120_000,
    maxAttempts: 3,
    retryCapMs: 30_000,
  },
} as const satisfies CreateCopilotzOptions;

Deno.test("package configuration composes plugins, resources, persistence, and engine policy", async () => {
  const application = await createCopilotz(validConfiguration);
  try {
    assertEquals(Object.keys(application).sort(), ["close", "observe", "send"]);
  } finally {
    await application.close();
  }

  const internal = await createCopilotzApplication(validConfiguration);
  try {
    assertEquals(internal.config.databaseSchema, "public");
    assertEquals(internal.config.pluginIds, ["contract.empty"]);
    assertEquals(internal.config.databaseOwnership, "application");
    assertEquals(internal.plugins.resources.agents.support, {
      id: "support",
      name: "Support",
    });
  } finally {
    await internal.shutdown();
  }
});
