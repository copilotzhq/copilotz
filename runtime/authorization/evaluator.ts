/** One owner-local policy evaluator. Policy code receives declared, tracked reads. */
import type {
  AuthenticatedAuthority,
  AuthorityDependency,
  AuthorityPolicy,
} from "./authority.ts";
import { retainedAuthority } from "./authority.ts";
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

export type AuthorizationIntent = Readonly<{
  kind:
    | "collection"
    | "action"
    | "operation"
    | "observation"
    | "session"
    | "asset"
    | "event";
  resource: string;
  operation: string;
  input: unknown;
}>;
export type AuthorizationRead = Readonly<{
  get(collection: string, id: string): Promise<CollectionRecord | null>;
  list(
    collection: string,
    query?: CollectionQuery,
  ): Promise<readonly CollectionRecord[]>;
}>;
export type OwnerPolicy = Readonly<{
  revision: string;
  /** Registered Collection aliases. Every read, including a missing row, is tracked. */
  sources: readonly string[];
  evaluate(
    context: Readonly<{
      authority: AuthenticatedAuthority;
      intent: AuthorizationIntent;
      commandTime: string;
      signal: AbortSignal;
      read: AuthorizationRead;
    }>,
  ): ServerConstraints | Promise<ServerConstraints>;
}>;
export type OwnerAuthorization = Readonly<{
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
  for (const [id, policy] of Object.entries(registration.policies)) {
    if (
      !id || !policy.revision || typeof policy.evaluate !== "function" ||
      !Array.isArray(policy.sources) ||
      new Set(policy.sources).size !== policy.sources.length ||
      policy.sources.some((source) => !Object.hasOwn(collections, source))
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
}
export function captureOwnerAuthorization(
  registration: OwnerAuthorization | undefined,
  collections: Readonly<Record<string, CollectionDefinition>>,
  actions: Readonly<Record<string, { id: string }>>,
): OwnerAuthorization | undefined {
  validateOwnerAuthorization(registration, collections, actions);
  if (!registration) return;
  return Object.freeze({
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
            sources: Object.freeze([...policy.sources]),
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
    const policy = registration.policies[authority.policy.id];
    if (
      !policy || policy.revision !== authority.policy.revision ||
      authority.scope.databaseSchema !== databaseSchema
    ) authorizationRefused();
    const required = intent.kind === "collection"
      ? registration.collections[intent.resource]
      : intent.kind === "action"
      ? registration.actions[intent.resource]
      : undefined;
    if (
      (intent.kind === "collection" || intent.kind === "action") &&
      (!required || required.id !== authority.policy.id ||
        required.revision !== authority.policy.revision)
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
    let active = true;
    let failed = false;
    const pending: Promise<unknown>[] = [];
    const assertActive = () => {
      command.signal.throwIfAborted();
      if (!active) throw new Error("Owner policy read lifetime ended.");
    };
    const source = (alias: string, id?: string) => {
      assertActive();
      if (!policy.sources.includes(alias)) {
        failed = true;
        authorizationRefused();
      }
      const definition = collections[alias];
      if (!definition) authorizationRefused();
      dependencies.push({
        owner: authority.scope.owner,
        namespace: authority.scope.namespace,
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
      if (authority.validity.kind === "attempt") {
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
      if (authority.authorityBasis.kind === "session") {
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
        if (
          !session || session.revoked_at ||
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
            intent: captureHostCommandJson(intent) as AuthorizationIntent,
            commandTime: command.commandTime,
            signal: command.signal,
            read: {
              get(alias, id) {
                const definition = source(alias, id);
                return track(() =>
                  loadCollectionRecord(
                    command.transaction,
                    tables,
                    authority.scope.namespace,
                    definition.name,
                    id,
                  )
                );
              },
              list(alias, query = {}) {
                const definition = source(alias);
                if (query.include?.length) authorizationRefused();
                return track(() =>
                  queryCollectionRecords(
                    command.transaction,
                    tables,
                    definition,
                    authority.scope.namespace,
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
      if (failed) {
        throw new Error("Owner authorization could not be completed.");
      }
      return {
        authority,
        constraints: captureHostCommandJson(constraints) as ServerConstraints,
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
