import { defineDatabaseDirectoryCommand } from "./directory-command.ts";
import {
  defineIdentityVerifier,
  readIdentityEvidence,
} from "./identity-evidence.ts";
import { validateCollectionConstraints } from "./collection-constraints.ts";
import { defineDatabaseDirectoryRead } from "./directory-read.ts";
import { checkFlow } from "./flow.ts";
/** One owner-local policy evaluator. Policy code receives declared, tracked reads. */
import type {
  AuthenticatedAuthority,
  AuthorityDependency,
  AuthorityPolicy,
} from "./authority.ts";
import { credentialValidity, retainedAuthority } from "./authority.ts";
import { digestContent } from "../content/digest.ts";
import { stableStringify } from "../collections/equal.ts";
import type { ServerConstraints } from "./contracts.ts";
import { captureHostCommandJson } from "../application/host-command-json.ts";
import type { CollectionDefinition } from "../collections/definition.ts";
import type {
  CollectionQuery,
  CollectionRecord,
} from "../collections/types.ts";
import { loadCollectionRecord } from "../collections/reducer.ts";
import { queryCollectionRecords } from "../collections/query.ts";
import { createCoreTableNames } from "../events/schema.ts";
import type { SqlExecutor } from "../events/session.ts";
import { withOwnerAuthorizationPhase } from "../engine/command-authorization.ts";
import {
  isOwnerAuthorizationRefusal,
  markOwnerAuthorizationRefusal,
  withOwnerPolicyRefusal,
} from "../engine/authorization-refusal.ts";
import { standardActionError } from "../actions/errors.ts";
import {
  type AuthorizationSource,
  captureAuthorizationSource,
  readStaffSource,
  sourceAlias,
  validStaffSource,
} from "./directory.ts";

export type AuthorizationIntent = Readonly<{
  kind:
    | "collection"
    | "action"
    | "operation"
    | "observation"
    | "session"
    | "flow"
    | "asset"
    | "event"
    | "directory"
    | "identity";
  resource: string;
  operation: string;
  input: unknown;
  /** Owner-resolved root source, used when capturing a flow continuation. */
  sourceOperationId?: string;
  sourceEventId?: string;
  sourceDeliveryId?: string;
  /** Owner-resolved executing identity. Absent for direct ingress calls. */
  invocation?: Readonly<{
    kind: "action" | "processor" | "alarm";
    id: string;
    runId?: string;
    parentRunId?: string;
  }>;
}>;
export type AuthorizationRead = Readonly<{
  get(collection: string, id: string): Promise<CollectionRecord | null>;
  list(
    collection: string,
    query?: CollectionQuery,
  ): Promise<readonly CollectionRecord[]>;
}>;
export type DirectoryPolicyProvenance = Readonly<{
  command: string;
  databaseSchema: string;
  namespace: string;
}>;
export type OwnerPolicy = Readonly<{
  revision: string;
  /** Local Collection aliases, or explicit directory capabilities for staff grants. */
  sources: readonly AuthorizationSource[];
  evidence?: readonly string[];
  evaluate(
    context: Readonly<{
      authority: AuthenticatedAuthority;
      directory?: DirectoryPolicyProvenance;
      intent: AuthorizationIntent;
      commandTime: string;
      signal: AbortSignal;
      read: AuthorizationRead;
      evidence: import("./identity-evidence.ts").IdentityEvidenceReader;
    }>,
  ): ServerConstraints | Promise<ServerConstraints>;
}>;
export type OwnerAuthorization = Readonly<{
  identityVerifiers?: Readonly<
    Record<string, import("./identity-evidence.ts").IdentityVerifier>
  >;
  directoryCommands?: Readonly<
    Record<string, import("./directory-command.ts").DatabaseDirectoryCommand>
  >;
  directoryReads?: Readonly<
    Record<string, import("./directory-read.ts").DatabaseDirectoryRead>
  >;
  /** Explicit tenant placement for owner-generated alarm occurrences, by namespace. */
  systemScopes?: Readonly<
    Record<string, import("./authority.ts").AuthorityScope>
  >;
  policies: Readonly<Record<string, OwnerPolicy>>;
  collections: Readonly<Record<string, AuthorityPolicy>>;
  actions: Readonly<Record<string, AuthorityPolicy>>;
}>;
export type AuthorizationDecision = Readonly<{
  authority: AuthenticatedAuthority;
  constraints: ServerConstraints;
  dependencies: readonly AuthorityDependency[];
}>;
export function authorizationRefused(): never {
  throw markOwnerAuthorizationRefusal(
    standardActionError({ code: "forbidden", status: 403 })!,
  );
}
export function validateOwnerAuthorization(
  registration: OwnerAuthorization | undefined,
  collections: Readonly<Record<string, CollectionDefinition>>,
  actions: Readonly<Record<string, { id: string }>>,
): void {
  if (!registration) {
    if (
      Object.values(collections).some((definition) =>
        definition.ownerPolicy === "required"
      )
    ) {
      throw new TypeError(
        "Required owner authorization registration is missing.",
      );
    }
    return;
  }
  for (
    const [namespace, scope] of Object.entries(registration.systemScopes ?? {})
  ) {
    if (
      !namespace || scope.namespace !== namespace || scope.owner !== "schema" ||
      !scope.databaseSchema?.trim() || !scope.tenant?.trim() ||
      !scope.bindings ||
      Object.values(scope.bindings).some((value) => typeof value !== "string")
    ) {
      throw new TypeError(
        "System authority requires explicit valid tenant placement.",
      );
    }
  }
  for (
    const [alias, declaration] of Object.entries(
      registration.identityVerifiers ?? {},
    )
  ) {
    defineIdentityVerifier(declaration);
    if (
      !alias ||
      declaration.actions.some((action) =>
        !Object.hasOwn(registration.actions, action)
      )
    ) throw new TypeError("Identity verifiers require policy-bound Actions.");
  }
  for (
    const [alias, declaration] of Object.entries(
      registration.directoryCommands ?? {},
    )
  ) {
    defineDatabaseDirectoryCommand(declaration);
    if (
      !alias || declaration.actions.some((action) =>
        !Object.hasOwn(registration.actions, action)
      ) ||
      declaration.evidence?.some((evidence) =>
        !Object.hasOwn(registration.identityVerifiers ?? {}, evidence)
      )
    ) {
      throw new TypeError(
        "Directory commands require policy-bound Actions and declared evidence.",
      );
    }
  }
  for (const [id, policy] of Object.entries(registration.policies)) {
    if (
      !id || !policy.revision || typeof policy.evaluate !== "function" ||
      policy.evidence?.some((alias) =>
        !Object.hasOwn(registration.identityVerifiers ?? {}, alias)
      ) ||
      !Array.isArray(policy.sources) ||
      new Set(policy.sources.map(sourceAlias)).size !== policy.sources.length ||
      policy.sources.some((source) =>
        typeof source === "string"
          ? !Object.hasOwn(collections, source)
          : !validStaffSource(source) ||
            Object.hasOwn(collections, source.alias)
      )
    ) {
      throw new TypeError(
        "Owner policies require a revision, evaluator and declared registered sources.",
      );
    }
  }
  for (
    const [bindings, resources] of [[registration.collections, collections], [
      registration.actions,
      actions,
    ]] as const
  ) {
    for (const [alias, ref] of Object.entries(bindings)) {
      if (
        !Object.hasOwn(resources, alias) ||
        registration.policies[ref.id]?.revision !== ref.revision
      ) {
        throw new TypeError(
          "Owner authorization resource or policy revision is unknown.",
        );
      }
    }
  }
  for (const [alias, definition] of Object.entries(collections)) {
    if (
      definition.ownerPolicy === "required" &&
      !Object.hasOwn(registration.collections, alias)
    ) {
      throw new TypeError("Required Collection authority binding is missing.");
    }
  }
  for (
    const [alias, declaration] of Object.entries(
      registration.directoryReads ?? {},
    )
  ) {
    if (
      !alias || declaration.kind !== "database-directory-read" ||
      declaration.actions.some((action) =>
        !Object.hasOwn(registration.actions, action)
      )
    ) {
      throw new TypeError(
        "Directory reads require declared, policy-bound Actions.",
      );
    }
    defineDatabaseDirectoryRead(declaration);
  }
}
export function captureOwnerAuthorization(
  registration: OwnerAuthorization | undefined,
  collections: Readonly<Record<string, CollectionDefinition>>,
  actions: Readonly<Record<string, { id: string }>>,
): OwnerAuthorization | undefined {
  validateOwnerAuthorization(registration, collections, actions);
  if (!registration) return;
  return Object.freeze({
    directoryCommands: Object.freeze(
      Object.fromEntries(
        Object.entries(registration.directoryCommands ?? {}).map((
          [alias, declaration],
        ) => [alias, defineDatabaseDirectoryCommand(declaration)]),
      ),
    ),
    identityVerifiers: Object.freeze(
      Object.fromEntries(
        Object.entries(registration.identityVerifiers ?? {}).map((
          [alias, declaration],
        ) => [alias, defineIdentityVerifier(declaration)]),
      ),
    ),
    directoryReads: Object.freeze(Object.fromEntries(
      Object.entries(registration.directoryReads ?? {}).map((
        [alias, declaration],
      ) => [alias, defineDatabaseDirectoryRead(declaration)]),
    )),
    ...(registration.systemScopes
      ? {
        systemScopes: Object.freeze(
          captureHostCommandJson(registration.systemScopes),
        ) as OwnerAuthorization["systemScopes"],
      }
      : {}),
    policies: Object.freeze(
      Object.fromEntries(
        Object.entries(registration.policies).map((
          [id, policy],
        ) => [
          id,
          Object.freeze({
            revision: policy.revision,
            evidence: Object.freeze([...(policy.evidence ?? [])]),
            sources: Object.freeze(
              policy.sources.map(captureAuthorizationSource),
            ),
            evaluate: policy.evaluate,
          }),
        ]),
      ),
    ),
    collections: Object.freeze(
      captureHostCommandJson(
        registration.collections,
      ) as OwnerAuthorization["collections"],
    ),
    actions: Object.freeze(
      captureHostCommandJson(
        registration.actions,
      ) as OwnerAuthorization["actions"],
    ),
  });
}
export type OwnerEvaluator = (
  authority: AuthenticatedAuthority,
  intent: AuthorizationIntent,
  command: Readonly<
    { transaction: SqlExecutor; commandTime: string; signal: AbortSignal }
  >,
) => Promise<AuthorizationDecision>;
export function createOwnerEvaluator(
  options: Readonly<{
    registration: OwnerAuthorization;
    collections: Readonly<Record<string, CollectionDefinition>>;
    databaseSchema: string;
    /** Package-only live delegation; never accepted from a worker or retained authority. */
    directory?: DirectoryPolicyProvenance & {
      evidence: import("./identity-evidence.ts").IdentityEvidenceReader;
    };
  }>,
): OwnerEvaluator {
  const { registration, collections, databaseSchema } = options;
  const tables = createCoreTableNames(databaseSchema);
  return async function evaluate(
    value: AuthenticatedAuthority,
    intent: AuthorizationIntent,
    command: Readonly<
      { transaction: SqlExecutor; commandTime: string; signal: AbortSignal }
    >,
  ): Promise<AuthorizationDecision> {
    let authority = retainedAuthority(value);
    const directory = options.directory;
    if (directory && intent.kind !== "collection") authorizationRefused();
    const reference = directory
      ? registration.collections[intent.resource]
      : authority.policy;
    const namespace = directory?.namespace ?? authority.scope.namespace;
    const policy = reference && registration.policies[reference.id];
    if (
      !policy || policy.revision !== reference?.revision ||
      (!directory && authority.scope.databaseSchema !== databaseSchema)
    ) authorizationRefused();
    const required = intent.kind === "collection"
      ? registration.collections[intent.resource]
      : intent.kind === "action"
      ? registration.actions[intent.resource]
      : undefined;
    if (
      (intent.kind === "collection" || intent.kind === "action") &&
      (!required || required.id !== reference?.id ||
        required.revision !== reference?.revision)
    ) authorizationRefused();
    command.signal.throwIfAborted();
    if (
      authority.validity.kind === "credential" &&
      (Date.parse(authority.validity.expiresAt) <=
          Date.parse(command.commandTime) ||
        Date.parse(authority.validity.admittedAt) >
          Date.parse(command.commandTime))
    ) authorizationRefused();
    const dependencies: AuthorityDependency[] = [];
    const staffReads: Array<Record<string, unknown>> = [];
    let active = true;
    let failed = false;
    const pending: Promise<unknown>[] = [];
    const assertActive = () => {
      command.signal.throwIfAborted();
      if (!active) throw new Error("Owner policy read lifetime ended.");
    };
    const source = (alias: string, id?: string) => {
      assertActive();
      const declared = policy.sources.find((entry) =>
        sourceAlias(entry) === alias
      );
      if (!declared) {
        failed = true;
        authorizationRefused();
      }
      if (typeof declared !== "string") return declared;
      const definition = collections[alias];
      if (!definition) authorizationRefused();
      dependencies.push({
        owner: authority.scope.owner,
        namespace,
        collection: definition.name,
        ...(id === undefined ? {} : { id }),
      });
      return definition;
    };
    const track = <T>(run: () => Promise<T>): Promise<T> => {
      const promise = Promise.resolve().then(run).then((result) => {
        assertActive();
        return result;
      }).catch((error) => {
        failed = true;
        throw error;
      });
      pending.push(promise);
      return promise;
    };
    try {
      if (!directory && authority.validity.kind === "attempt") {
        const live = await command.transaction.query(
          `SELECT id FROM ${tables.event_deliveries} WHERE id=$1 AND lease_owner=$2 AND owner_epoch=$3::bigint AND status='leased' AND lease_expires_at>$4::timestamptz`,
          [
            authority.validity.attempt,
            authority.validity.worker,
            authority.validity.epoch,
            command.commandTime,
          ],
        );
        if (!live.rows.length) authorizationRefused();
      }
      if (!directory) await checkFlow(authority, intent, command);
      if (!directory && authority.authorityBasis.kind === "session") {
        const rows = await command.transaction.query<
          { expires_at: string; revoked_at: string | null }
        >(
          `SELECT expires_at::text,revoked_at::text FROM "${
            databaseSchema.replaceAll('"', '""')
          }".authorization_sessions WHERE namespace=$1 AND tenant=$2 AND id=$3 AND principal=$4`,
          [
            authority.scope.namespace,
            authority.scope.tenant,
            authority.authorityBasis.id,
            authority.principal.id,
          ],
        );
        const session = rows.rows[0];
        let completingLogout = false;
        if (
          session?.revoked_at && intent.invocation?.runId &&
          (intent.kind === "action" && intent.operation === "authorize" ||
            intent.kind === "collection" &&
              (intent.input as { phase?: string })?.phase === "result")
        ) {
          // A nested logout and its already-captured caller may finish the same
          // operation. This exception grants no new capture or mutation.
          const effect = await command.transaction.query(
            `SELECT 1 FROM "${databaseSchema}".authorization_effects WHERE namespace=$1 AND tenant=$2 AND method='session.revoke' AND claims->>'id'=$4 AND (run_id=$3 OR operation_id=(SELECT source_event_id FROM "${databaseSchema}".authorization_invocations WHERE namespace=$1 AND run_id=$3))`,
            [
              authority.scope.namespace,
              authority.scope.tenant,
              intent.invocation.runId,
              authority.authorityBasis.id,
            ],
          );
          completingLogout = effect.rows.length > 0;
        }
        if (
          session?.revoked_at && intent.kind === "operation" &&
          intent.operation === "read"
        ) {
          const effect = await command.transaction.query(
            `SELECT 1 FROM "${databaseSchema}".authorization_effects WHERE namespace=$1 AND tenant=$2 AND operation_id=$3 AND method='session.revoke' AND claims->>'id'=$4`,
            [
              authority.scope.namespace,
              authority.scope.tenant,
              intent.resource,
              authority.authorityBasis.id,
            ],
          );
          completingLogout = effect.rows.length > 0;
        }
        if (
          !session || session.revoked_at && !completingLogout ||
          Date.parse(session.expires_at) <= Date.parse(command.commandTime)
        ) authorizationRefused();
        if (
          authority.validity.kind === "credential" &&
          Date.parse(session.expires_at) <
            Date.parse(authority.validity.expiresAt)
        ) {
          authority = retainedAuthority({
            ...authority,
            validity: {
              ...authority.validity,
              expiresAt: new Date(session.expires_at).toISOString(),
            },
          });
        }
        dependencies.push({
          owner: authority.scope.owner,
          namespace: authority.scope.namespace,
          collection: "@authorization/session",
          id: authority.authorityBasis.id,
        });
      }
      const constraints = await withOwnerAuthorizationPhase(() =>
        withOwnerPolicyRefusal(() => {
          const result = policy.evaluate({
            authority,
            ...(directory
              ? {
                directory: {
                  command: directory.command,
                  databaseSchema,
                  namespace,
                },
              }
              : {}),
            intent: captureHostCommandJson(intent) as AuthorizationIntent,
            commandTime: command.commandTime,
            signal: command.signal,
            evidence: {
              get(alias) {
                assertActive();
                if (!policy.evidence?.includes(alias)) {
                  failed = true;
                  authorizationRefused();
                }
                return track(() =>
                  directory
                    ? directory.evidence.get(alias)
                    : readIdentityEvidence(
                      registration,
                      authority,
                      alias,
                      command,
                    )
                );
              },
            },
            read: {
              get(alias, id) {
                const definition = source(alias, id);
                if ("kind" in definition) {
                  staffReads.push({
                    owner: definition.owner,
                    namespace: definition.namespace,
                    collection: definition.collection,
                    id,
                  });
                  return track(() =>
                    readStaffSource(definition, { id }, command, databaseSchema)
                  ) as Promise<CollectionRecord | null>;
                }
                return track(() =>
                  loadCollectionRecord(
                    command.transaction,
                    tables,
                    namespace,
                    definition.name,
                    id,
                  )
                );
              },
              list(alias, query = {}) {
                const definition = source(alias);
                if (query.include?.length) authorizationRefused();
                if ("kind" in definition) {
                  query = captureHostCommandJson(query, {
                    omitUndefinedProperties: true,
                  }) as CollectionQuery;
                  staffReads.push({
                    owner: definition.owner,
                    namespace: definition.namespace,
                    collection: definition.collection,
                    query,
                  });
                  return track(() =>
                    readStaffSource(
                      definition,
                      { query },
                      command,
                      databaseSchema,
                    )
                  ) as Promise<readonly CollectionRecord[]>;
                }
                return track(() =>
                  queryCollectionRecords(
                    command.transaction,
                    tables,
                    definition,
                    namespace,
                    query,
                  )
                );
              },
            },
          });
          if (!(result instanceof Promise)) active = false;
          return result;
        }, command.signal)
      );
      await Promise.all(pending);
      if (
        authority.flow && intent.invocation?.kind === "processor" &&
        (!Array.isArray(constraints.flowProcessors) ||
          !constraints.flowProcessors.includes(intent.invocation.id))
      ) authorizationRefused();
      if (failed) {
        throw new Error("Owner authorization could not be completed.");
      }
      if (staffReads.length) {
        if (authority.validity.kind === "credential") {
          authority = retainedAuthority({
            ...authority,
            validity: {
              ...authority.validity,
              expiresAt: credentialValidity(
                new Date(command.commandTime),
                authority.validity.expiresAt,
              ).expiresAt,
            },
          });
        }
        await command.transaction.query(
          `INSERT INTO ${tables.owner_receipts}(owner,domain,key,principal,kind,intent,result) VALUES('schema','logical',$1,$2,'authorization.staff',$3::jsonb,'null')`,
          [
            `authorization.staff:${crypto.randomUUID()}`,
            authority.principal.id,
            JSON.stringify({
              principal: authority.principal,
              scope: authority.scope,
              provenance: authority.provenance,
              policy: authority.policy,
              commandTime: command.commandTime,
              // Audit what was done, not the payload: input may hold secrets.
              operation: {
                kind: intent.kind,
                resource: intent.resource,
                operation: intent.operation,
                inputDigest: await digestContent(
                  new TextEncoder().encode(
                    stableStringify(intent.input ?? null),
                  ),
                ),
                ...(intent.invocation ? { invocation: intent.invocation } : {}),
              },
              sources: staffReads,
            }),
          ],
        );
      }
      let captured: ServerConstraints;
      try {
        captured = captureHostCommandJson(constraints) as ServerConstraints;
        validateCollectionConstraints(captured);
      } catch {
        authorizationRefused();
      }
      return {
        authority,
        constraints: captured,
        dependencies,
      };
    } catch (error) {
      if (failed) {
        throw new Error("Owner authorization could not be completed.", {
          cause: error,
        });
      }
      if (isOwnerAuthorizationRefusal(error)) authorizationRefused();
      throw new Error("Owner authorization could not be completed.");
    } finally {
      active = false;
      await Promise.allSettled(pending);
    }
  };
}

/** Resource bindings select the common evaluator; there are no per-Collection callbacks. */
export function collectionAuthorizations(
  registration: OwnerAuthorization | undefined,
  collections: Readonly<Record<string, CollectionDefinition>>,
  databaseSchema: string,
): import("./resources.ts").CollectionPolicyRegistrations {
  if (!registration) return new Map();
  const evaluate = createOwnerEvaluator({
    registration,
    collections,
    databaseSchema,
  });
  return new Map(
    Object.entries(registration.collections).map(([alias, reference]) => {
      const name = collections[alias].name;
      return [name, { alias, name, reference, evaluate }];
    }),
  );
}
