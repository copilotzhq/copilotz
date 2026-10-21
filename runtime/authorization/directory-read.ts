/** Declared, read-only delegation to a directory owner in the same database. */
import type { AuthenticatedAuthority } from "./authority.ts";
import type { CollectionPolicyInvocation } from "./intent.ts";
import type { CollectionDefinition } from "../collections/definition.ts";
import type { CollectionRecord } from "../collections/types.ts";
import type { SqlSession } from "../events/session.ts";
import {
  createCoreTableNames,
  validateEventSchemaName,
} from "../events/schema.ts";
import { loadCollectionRecord } from "../collections/reducer.ts";
import { captureHostCommandJson } from "../application/host-command-json.ts";
import { createSchemaCommandRunner } from "../engine/commands.ts";
import { withOwnerAuthorizationPhase } from "../engine/command-authorization.ts";
import { withOwnerPolicyRefusal } from "../engine/authorization-refusal.ts";
import { captureCollectionInvocation } from "./invocation.ts";
import {
  authorizationRefused,
  createOwnerEvaluator,
  type OwnerAuthorization,
} from "./evaluator.ts";
import { digestContent } from "../content/digest.ts";
import { stableStringify } from "../collections/equal.ts";

export type DirectoryReader = Readonly<{
  get(
    alias: string,
    id: string,
  ): Promise<Readonly<Record<string, unknown>> | null>;
}>;

export type DatabaseDirectoryRead = Readonly<{
  kind: "database-directory-read";
  revision: string;
  databaseSchema: string;
  namespace: string;
  collection: CollectionDefinition;
  /** Registered Action aliases allowed to request this capability. */
  actions: readonly string[];
  /** Exact top-level fields disclosed. No implicit record or credential fields. */
  fields: readonly string[];
  maxBytes: number;
  /** Destination owner's policy, called with the fresh record before disclosure. */
  authorize(
    context: Readonly<{
      authority: AuthenticatedAuthority;
      invocation: CollectionPolicyInvocation;
      id: string;
      record: CollectionRecord | null;
      commandTime: string;
      signal: AbortSignal;
    }>,
  ): boolean | Promise<boolean>;
}>;

/** Composition owns placement; Action input never selects a directory owner. */
export function defineDatabaseDirectoryRead(
  options: Omit<DatabaseDirectoryRead, "kind" | "maxBytes"> & {
    maxBytes?: number;
  },
): DatabaseDirectoryRead {
  validateEventSchemaName(options.databaseSchema);
  const maxBytes = options.maxBytes ?? 16_384;
  if (
    !options.revision?.trim() || !options.namespace?.trim() ||
    !options.collection?.name || !options.actions.length ||
    !options.fields.length ||
    [...options.actions, ...options.fields].some((value) =>
      typeof value !== "string" || !value.trim() ||
      ["__proto__", "constructor", "prototype"].includes(value)
    ) || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 65_536 ||
    typeof options.authorize !== "function"
  ) throw new TypeError("Invalid directory read declaration.");
  return Object.freeze({
    ...options,
    kind: "database-directory-read",
    collection: Object.freeze({ ...options.collection }),
    actions: Object.freeze([...options.actions]),
    fields: Object.freeze([...options.fields]),
    maxBytes,
  });
}

export function createDirectoryReader(options: {
  session: SqlSession;
  databaseSchema: string;
  registration?: OwnerAuthorization;
  collections: Readonly<Record<string, CollectionDefinition>>;
  actions: Readonly<Record<string, { id: string }>>;
}): DirectoryReader {
  const run = createSchemaCommandRunner(
    options.session,
    options.databaseSchema,
  );
  const evaluate = options.registration && createOwnerEvaluator({
    registration: options.registration,
    collections: options.collections,
    databaseSchema: options.databaseSchema,
  });
  return {
    async get(alias, id) {
      const binding = captureCollectionInvocation();
      if (
        !binding?.authority || binding.invocation.kind !== "action" || !evaluate
      ) authorizationRefused();
      binding.check();
      if (
        binding.scope.databaseSchema !== options.databaseSchema ||
        typeof id !== "string" || !id.trim()
      ) authorizationRefused();
      const declarations = options.registration?.directoryReads;
      const declaration = declarations && Object.hasOwn(declarations, alias)
        ? declarations[alias]
        : undefined;
      const action = Object.entries(options.actions).find(([, definition]) =>
        definition.id === binding.invocation.id
      )?.[0];
      if (!declaration || !action || !declaration.actions.includes(action)) {
        authorizationRefused();
      }
      return await run(
        "authorization.directory.read",
        { alias, id },
        async (_, command) => {
          binding.check();
          await binding.assertCurrent?.(command, binding.invocation);
          const authority = binding.authority!;
          const intent = {
            kind: "directory" as const,
            resource: alias,
            operation: "get",
            input: { id },
            invocation: binding.invocation,
          };
          const allowed = async () => {
            const decision = await evaluate(authority, intent, command);
            const grants = decision.constraints.directoryReads;
            if (
              !Array.isArray(grants) ||
              grants.some((grant) => typeof grant !== "string") ||
              !grants.includes(alias)
            ) authorizationRefused();
          };
          await allowed();
          const record = await loadCollectionRecord(
            command.transaction,
            createCoreTableNames(declaration.databaseSchema),
            declaration.namespace,
            declaration.collection.name,
            id,
          );
          if (
            await withOwnerAuthorizationPhase(() =>
              withOwnerPolicyRefusal(() =>
                declaration.authorize({
                  authority: captureHostCommandJson(
                    authority,
                  ) as AuthenticatedAuthority,
                  invocation: captureHostCommandJson(
                    binding.invocation,
                  ) as CollectionPolicyInvocation,
                  id,
                  record: captureHostCommandJson(record) as
                    | CollectionRecord
                    | null,
                  commandTime: command.commandTime,
                  signal: binding.signal,
                }), binding.signal)
            ) !== true
          ) authorizationRefused();
          const result = record === null
            ? null
            : captureHostCommandJson(Object.fromEntries(
              declaration.fields.filter((field) => Object.hasOwn(record, field))
                .map((field) => [field, record[field]]),
            )) as Readonly<Record<string, unknown>>;
          const bytes = new TextEncoder().encode(stableStringify(result));
          if (bytes.length > declaration.maxBytes) authorizationRefused();
          await allowed();
          binding.check();
          await binding.assertCurrent?.(command, binding.invocation);
          // A read is fresh, never a cached identity lookup. Audit commits before
          // its result is returned; no private payload or credential is recorded.
          await command.transaction.query(
            `INSERT INTO "${options.databaseSchema}".owner_receipts(owner,domain,key,principal,kind,intent,result) VALUES('schema','logical',$1,$2,'authorization.directory',$3::jsonb,'{}'::jsonb)`,
            [
              `authorization.directory:${crypto.randomUUID()}`,
              authority.principal.id,
              JSON.stringify({
                principal: authority.principal,
                tenant: authority.scope.tenant,
                namespace: authority.scope.namespace,
                invocation: binding.invocation,
                operationId: binding.operationId,
                alias,
                revision: declaration.revision,
                destination: {
                  databaseSchema: declaration.databaseSchema,
                  namespace: declaration.namespace,
                  collection: declaration.collection.name,
                },
                idDigest: await digestContent(new TextEncoder().encode(id)),
                resultDigest: await digestContent(bytes),
                fields: declaration.fields,
                commandTime: command.commandTime,
              }),
            ],
          );
          return result;
        },
      );
    },
  };
}
