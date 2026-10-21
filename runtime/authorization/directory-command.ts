import { stageTransactionEffect } from "../collections/transaction-effects.ts";
/** Explicit owner-local directory service commands in the source SQL transaction. */
import type { AuthenticatedAuthority } from "./authority.ts";
import type { CollectionPolicyInvocation } from "./intent.ts";
import type { SqlExecutor } from "../events/session.ts";
import { validateEventSchemaName } from "../events/schema.ts";
import { captureHostCommandJson } from "../application/host-command-json.ts";
import { stableStringify } from "../collections/equal.ts";
import { digestContent } from "../content/digest.ts";
import {
  afterCommandAuthorization,
  attachedDatabaseOwner,
  createSchemaCommandRunner,
} from "../engine/commands.ts";
import { withOwnerAuthorizationPhase } from "../engine/command-authorization.ts";
import { captureCollectionInvocation } from "./invocation.ts";
import { authorizationRefused, createOwnerEvaluator } from "./evaluator.ts";
import {
  type IdentityEvidenceReader,
  type OwnerCapabilityOptions,
  readIdentityEvidence,
} from "./identity-evidence.ts";

export type DirectoryCommandContext = Readonly<{
  authority: AuthenticatedAuthority;
  invocation: CollectionPolicyInvocation;
  input: unknown;
  databaseSchema: string;
  namespace: string;
  commandTime: string;
  signal: AbortSignal;
  evidence: IdentityEvidenceReader;
}>;
export type DatabaseDirectoryCommand = Readonly<{
  revision: string;
  databaseSchema: string;
  namespace: string;
  command: string;
  actions: readonly string[];
  evidence?: readonly string[];
  authorize(context: DirectoryCommandContext): boolean | Promise<boolean>;
  /** Trusted owner code. SQL only: no provider I/O, captured app handles or independent commits. */
  execute(
    context: DirectoryCommandContext & Readonly<{ transaction: SqlExecutor }>,
  ): Promise<unknown>;
}>;
export type DirectoryCommands = Readonly<{
  command(
    alias: string,
    input: unknown,
    options: Readonly<{ operationKey: string }>,
  ): Promise<unknown>;
}>;
export type TransactionDirectoryCommands = Readonly<{
  command(
    alias: string,
    input: unknown,
    options: Readonly<{ operationKey: string }>,
  ): Promise<void>;
}>;
export function defineDatabaseDirectoryCommand(
  value: DatabaseDirectoryCommand,
): DatabaseDirectoryCommand {
  validateEventSchemaName(value.databaseSchema);
  if (
    !value.namespace?.trim() || !value.command?.trim() ||
    !value.revision?.trim() ||
    !value.actions?.length || value.actions.some((a) => !a?.trim()) ||
    typeof value.authorize !== "function" || typeof value.execute !== "function"
  ) {
    throw new TypeError("Invalid directory command declaration.");
  }
  return Object.freeze({
    ...value,
    actions: Object.freeze([...value.actions]),
    evidence: Object.freeze([...(value.evidence ?? [])]),
  });
}
const digest = (value: unknown) =>
  digestContent(new TextEncoder().encode(stableStringify(value)));
export function createDirectoryCommands(
  options: OwnerCapabilityOptions,
): DirectoryCommands {
  const run = createSchemaCommandRunner(
    options.session,
    options.databaseSchema,
  );
  const evaluate = options.registration &&
    createOwnerEvaluator({ ...options, registration: options.registration });
  return {
    async command(alias, value, call) {
      const binding = captureCollectionInvocation();
      const definitions = options.registration?.directoryCommands;
      const definition = definitions && Object.hasOwn(definitions, alias)
        ? definitions[alias]
        : undefined;
      const action = Object.entries(options.actions).find(([, a]) =>
        a.id === binding?.invocation.id
      )?.[0];
      if (
        !binding?.authority || binding.invocation.kind !== "action" ||
        !evaluate || !definition ||
        !action || !definition.actions.includes(action) ||
        binding.scope.databaseSchema !== options.databaseSchema ||
        typeof call?.operationKey !== "string" || !call.operationKey.trim()
      ) authorizationRefused();
      binding.check();
      const input = captureHostCommandJson(value);
      if (
        new TextEncoder().encode(stableStringify(input)).length > 16384
      ) authorizationRefused();
      const coordinates = {
        source: binding.authority.scope,
        operationId: binding.operationId,
        invocation: binding.invocation,
        alias,
        operationKey: call.operationKey,
      };
      const key = `directory.command:${await digest(coordinates)}`;
      const intent = {
        alias,
        revision: definition.revision,
        destination: {
          databaseSchema: definition.databaseSchema,
          namespace: definition.namespace,
          command: definition.command,
        },
        inputDigest: await digest(input),
      };
      const commit = () =>
        run(
          "authorization.directory.command",
          { key, intent },
          async (_, command) => {
            const owner = await attachedDatabaseOwner(
              command.transaction,
              definition.databaseSchema,
            );
            let complete = false;
            afterCommandAuthorization(command.transaction, () => {
              if (!complete) {
                throw new Error(
                  "Directory command did not complete; transaction refused.",
                );
              }
              owner.signal.throwIfAborted();
              return Promise.resolve();
            });
            let active = true;
            const check = () => {
              binding.check();
              owner.signal.throwIfAborted();
              if (!active) {
                throw new Error(
                  "Directory command capability ended.",
                );
              }
            };
            const evidence: IdentityEvidenceReader = {
              async get(name) {
                check();
                if (!definition.evidence?.includes(name)) {
                  authorizationRefused();
                }
                const result = await readIdentityEvidence(
                  options.registration!,
                  binding.authority!,
                  name,
                  command,
                );
                check();
                return result;
              },
            };
            const context = (): DirectoryCommandContext => ({
              authority: captureHostCommandJson(
                binding.authority!,
              ) as AuthenticatedAuthority,
              invocation: { ...binding.invocation },
              input: captureHostCommandJson(input),
              databaseSchema: definition.databaseSchema,
              namespace: definition.namespace,
              commandTime: command.commandTime,
              signal: binding.signal,
              evidence,
            });
            const authorize = async () => {
              check();
              await binding.assertCurrent?.(command, binding.invocation);
              const decision = await evaluate(binding.authority!, {
                kind: "directory",
                resource: alias,
                operation: "command",
                input,
                invocation: binding.invocation,
              }, command);
              if (
                !Array.isArray(decision.constraints.directoryCommands) ||
                !decision.constraints.directoryCommands.includes(alias) ||
                await withOwnerAuthorizationPhase(() =>
                    definition.authorize(context())
                  ) !== true
              ) authorizationRefused();
            };
            try {
              await authorize();
              const table = `"${options.databaseSchema}".owner_receipts`;
              const previous = (await command.transaction.query<
                { intent: unknown; result: unknown }
              >(
                `SELECT intent,result FROM ${table} WHERE owner='schema' AND domain='logical' AND key=$1 AND kind='directory.command'`,
                [key],
              )).rows[0];
              if (previous) {
                if (
                  stableStringify(previous.intent) !== stableStringify(intent)
                ) authorizationRefused();
                complete = true;
                return captureHostCommandJson(previous.result);
              }
              const transaction: SqlExecutor = {
                query(sql, params) {
                  check();
                  return command.transaction.query(sql, params);
                },
              };
              const result = captureHostCommandJson(
                await withOwnerAuthorizationPhase(() =>
                  definition.execute({ ...context(), transaction })
                ),
              );
              if (
                new TextEncoder().encode(stableStringify(result)).length > 16384
              ) authorizationRefused();
              await authorize();
              const audit = {
                ...intent,
                source: {
                  databaseSchema: options.databaseSchema,
                  namespace: binding.authority!.scope.namespace,
                  tenant: binding.authority!.scope.tenant,
                },
                invocation: binding.invocation,
                operationId: binding.operationId,
                outputDigest: await digest(result),
                commandTime: command.commandTime,
              };
              await command.transaction.query(
                `INSERT INTO ${table}(owner,domain,key,principal,kind,intent,result)
          VALUES('schema','logical',$1,$2,'directory.command',$3::jsonb,$4::jsonb)`,
                [
                  key,
                  binding.authority!.principal.id,
                  JSON.stringify(intent),
                  JSON.stringify(result),
                ],
              );
              for (
                const schema of new Set([
                  options.databaseSchema,
                  definition.databaseSchema,
                ])
              ) {
                await command.transaction.query(
                  `INSERT INTO "${schema}".owner_receipts(owner,domain,key,principal,kind,intent,result)
            VALUES('schema','logical',$1,$2,'directory.audit',$3::jsonb,'{}'::jsonb)`,
                  [
                    `${key}:audit`,
                    binding.authority!.principal.id,
                    JSON.stringify(audit),
                  ],
                );
              }
              complete = true;
              return result;
            } finally {
              active = false;
            }
          },
        );
      if (stageTransactionEffect(key, commit)) return undefined;
      return await commit();
    },
  };
}
