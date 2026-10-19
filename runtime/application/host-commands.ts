import { withOwnerQueryContext } from "../engine/owner-query-context.ts";
import type {
  CommandCaller,
  CommandContext,
  CommandRequest,
  DatabaseOwner,
} from "../engine/commands.ts";
import { validateEventSchemaName } from "../events/schema.ts";
import { captureHostCommandJson } from "./host-command-json.ts";
import type {
  HostCommandContext,
  HostCommandDefinitions,
  HostCommandJson,
  HostCommands,
} from "./host-command-types.ts";

function schema(value: unknown): string {
  const name = text(value, "Database schema");
  // PostgreSQL truncates longer identifiers, which would alias fixed scopes.
  if (name.length > 63) {
    throw new TypeError("Database schema exceeds 63 characters.");
  }
  return validateEventSchemaName(name);
}

function text(value: unknown, name: string): string {
  if (
    typeof value !== "string" || !value.trim() || value !== value.trim() ||
    value.length > 1024
  ) {
    throw new TypeError(
      `${name} must be a non-empty bounded string without surrounding whitespace.`,
    );
  }
  return value;
}

/** The same explicit-scope validator is used before opening any persistence. */
export function hostDatabaseScopes(
  defaultSchema: string,
  scopes: readonly string[] | undefined,
  definitions: HostCommandDefinitions | undefined,
): readonly string[] {
  if (scopes !== undefined && !Array.isArray(scopes)) {
    throw new TypeError("databaseScopes must be an array.");
  }
  const result = new Set<string>();
  for (const requested of scopes ?? []) result.add(schema(requested));
  if (
    definitions !== undefined &&
    (!definitions || typeof definitions !== "object" ||
      Array.isArray(definitions))
  ) {
    throw new TypeError("hostCommands must be a command registration map.");
  }
  for (const [name, definition] of Object.entries(definitions ?? {})) {
    text(name, "Host command name");
    if (
      !definition || typeof definition.authorize !== "function" ||
      typeof definition.execute !== "function"
    ) {
      throw new TypeError(
        "Every host command requires authorize and execute callbacks.",
      );
    }
    text(definition.namespace, "Host command namespace");
    text(definition.principal, "Host command principal");
    result.add(schema(definition.databaseSchema ?? defaultSchema));
  }
  return Object.freeze([...result]);
}

/** Each callback gets a revocable query-only handle, never a session. */
async function callback<T>(
  run: (context: HostCommandContext) => T | Promise<T>,
  command: CommandContext,
  scope: HostCommandContext["scope"],
  signal: AbortSignal,
): Promise<T> {
  return await withOwnerQueryContext(run, command, signal, (assertActive) => ({
    scope,
    afterCommit(publication: () => void | Promise<void>) {
      assertActive();
      if (typeof publication !== "function") {
        throw new TypeError("afterCommit requires a callback.");
      }
      command.afterCommit(publication);
    },
  }));
}

/** Binds trusted registrations to the existing schema owner; adds no queue. */
export function createHostCommands(
  options: Readonly<{
    definitions?: HostCommandDefinitions;
    defaultSchema: string;
    signal: AbortSignal;
    admit(): Promise<void>;
    openScope(schema: string): Promise<unknown>;
  }>,
) {
  const definitions = new Map(
    Object.entries(options.definitions ?? {}).map(([name, definition]) =>
      [
        name,
        Object.freeze({
          ...definition,
          databaseSchema: definition.databaseSchema ?? options.defaultSchema,
        }),
      ] as const
    ),
  );
  const bindings = new Map<string, {
    owner: DatabaseOwner;
    invoke: (
      caller: CommandCaller,
      request: CommandRequest<HostCommandJson>,
    ) => Promise<HostCommandJson>;
    scope: HostCommandContext["scope"];
  }>();
  const install = (schema: string, owner: DatabaseOwner) => {
    for (const [name, definition] of definitions) {
      if (definition.databaseSchema !== schema) continue;
      const scope = Object.freeze({
        databaseSchema: schema,
        namespace: definition.namespace,
        principal: definition.principal,
      });
      const signal = AbortSignal.any([owner.signal, options.signal]);
      const invoke = owner.register<HostCommandJson, HostCommandJson>(
        `host.command:${name}`,
        {
          authorize: (input, command) =>
            callback(
              (context) => definition.authorize(input, context),
              command,
              scope,
              signal,
            ),
          execute: async (input, command) =>
            captureHostCommandJson(
              await callback(
                (context) => definition.execute(input, context),
                command,
                scope,
                signal,
              ),
            ),
        },
      );
      bindings.set(name, { owner, invoke, scope });
    }
  };
  const commands: HostCommands = Object.freeze({
    invoke(name, input, invokeOptions = {}) {
      // Capture synchronously, including the key, before any admission/recovery await.
      const captured = captureHostCommandJson(input);
      const key = invokeOptions.idempotencyKey === undefined
        ? undefined
        : text(invokeOptions.idempotencyKey, "Host command idempotency key");
      const definition = definitions.get(name);
      if (!definition) {
        return Promise.reject(new TypeError(`Unknown host command '${name}'.`));
      }
      return (async () => {
        options.signal.throwIfAborted();
        await options.admit();
        await options.openScope(definition.databaseSchema);
        const binding = bindings.get(name);
        if (!binding) throw new Error("Host command owner is not initialized.");
        await binding.owner.ready;
        options.signal.throwIfAborted();
        const result = await binding.invoke({
          principal: binding.scope.principal,
          epoch: binding.owner.epoch!,
        }, {
          input: captured,
          ...(key === undefined ? {} : {
            receipt: {
              identity: {
                domain: "logical" as const,
                key: JSON.stringify([
                  "host.command.v1",
                  binding.scope.databaseSchema,
                  binding.scope.namespace,
                  name,
                  binding.scope.principal,
                  key,
                ]),
              },
              intent: captured,
            },
          }),
        });
        // Receipt replays receive the same bounded immutable output guarantee.
        return captureHostCommandJson(result);
      })();
    },
  });
  return { commands, install } as const;
}
