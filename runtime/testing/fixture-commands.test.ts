/** Test-owned SQL setup; this adapter is never published with the library. */
import {
  createCopilotz,
  type CreateCopilotzOptions,
} from "../../create-copilotz.ts";
import {
  createCopilotzGateway,
  type CreateCopilotzGatewayOptions,
} from "../application/gateway.ts";
import type {
  HostCommandDefinitions,
  HostCommands,
} from "./fixture-command-types.ts";

export async function createFixtureCopilotz<T extends HostCommandDefinitions>(
  options: Exclude<CreateCopilotzOptions, { role: "worker" | "shard" }> & {
    hostCommands?: T;
  },
) {
  const { hostCommands: definitions, ...configuration } = options;
  const app = configuration.role === "gateway"
    ? await createCopilotz(configuration)
    : await createCopilotz(configuration);
  return withFixtureCommands(app, options, definitions);
}

export async function createFixtureGateway<T extends HostCommandDefinitions>(
  options: CreateCopilotzGatewayOptions & { hostCommands: T },
) {
  const { hostCommands, ...configuration } = options;
  return withFixtureCommands(
    await createCopilotzGateway(configuration),
    options,
    hostCommands,
  );
}

function withFixtureCommands<
  A extends object,
  T extends HostCommandDefinitions,
>(
  app: A,
  options: CreateCopilotzGatewayOptions,
  definitions: T | undefined,
) {
  const database = options.database;
  if (!database || typeof database !== "object" || !("query" in database)) {
    throw new Error("Fixture commands require a test-owned database.");
  }
  const hostCommands: HostCommands<T> = {
    invoke(name, input) {
      const definition = definitions![name];
      return database.transaction(async (transaction) => {
        const context = {
          query: transaction.query.bind(transaction),
          commandTime: new Date().toISOString(),
          signal: new AbortController().signal,
          scope: {
            databaseSchema: definition.databaseSchema ??
              options.databaseSchema ?? "public",
            namespace: definition.namespace,
            principal: definition.principal,
          },
          afterCommit() {
            throw new Error("Fixture setup does not publish.");
          },
        };
        await definition.authorize(input, context);
        return await definition.execute(input, context);
      }) as Promise<Awaited<ReturnType<T[typeof name]["execute"]>>>;
    },
  };
  return Object.assign(app, { hostCommands });
}
