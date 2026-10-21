import { assertFlowOperation } from "./flow.ts";
import { createCredentialEffects } from "./credentials.ts";
import { authorizeOperation } from "./operation.ts";
import { afterSqlCommit } from "../events/session.ts";
import { completeOwnerDeadline, writeOwnerDeadline } from "../engine/alarms.ts";
import type { CommandContext } from "../engine/commands.ts";
import type { AuthorizationIntent } from "./evaluator.ts";
import { type AuthorityDependency, authorityDependsOn } from "./authority.ts";
import { loadCollectionRecord } from "../collections/reducer.ts";
import { createCoreTableNames } from "../events/schema.ts";
import { matchesCollectionFilter } from "../collections/predicate.ts";
/** Tenant-local protected commands and live authority. */
import type { SqlSession } from "../events/session.ts";
import {
  createSchemaCommandRunner,
  type DatabaseOwner,
} from "../engine/commands.ts";
import type { CollectionDefinition } from "../collections/definition.ts";
import type { OperationCatalog } from "../streams/catalog.ts";
import {
  authorizationRefused,
  createOwnerEvaluator,
  type OwnerAuthorization,
} from "./evaluator.ts";
import {
  captureOperationConstraints,
  matchesOperationConstraints,
} from "./metadata.ts";
import { type AuthenticatedAuthority, retainedAuthority } from "./authority.ts";

export type AuthorityObservation = Readonly<{
  /** Cached gate for Collection push; notices fence it before queued policy work. */
  current(): boolean;
  publish<T>(send: () => Promise<T>): Promise<T>;
  close(): void;
}>;
export type AuthorizationOwner = Readonly<{
  credentials: ReturnType<typeof createCredentialEffects>;
  assertResources(
    resources: Readonly<
      { collections: readonly string[]; actions: readonly string[] }
    >,
  ): void;
  operation(
    authority: AuthenticatedAuthority,
    id: string,
  ): Promise<import("../streams/catalog.ts").OperationRecord>;
  observe(
    authority: AuthenticatedAuthority,
    input: Readonly<
      {
        collection?: string;
        query?: import("../collections/types.ts").CollectionQuery;
        record?: Readonly<{ collection: string; id: string }>;
        operationIds?: readonly string[];
      }
    >,
    failed: (error: unknown) => void,
    changed?: (
      decision: import("./evaluator.ts").AuthorizationDecision,
    ) => void,
  ): Promise<AuthorityObservation>;
  notice(change: { namespace: string; collection?: string; id?: string }): void;
  asset(authority: AuthenticatedAuthority, id: string): Promise<void>;
  createSession(
    authority: AuthenticatedAuthority,
    input: Readonly<{ id: string; principal: string; expiresAt: string }>,
  ): Promise<void>;
  revokeSession(authority: AuthenticatedAuthority, id: string): Promise<void>;
}>;
export function createAuthorizationOwner(
  options: Readonly<{
    master?: import("../actions/secret-adapter.ts").SecretAdapter;
    actions?: Readonly<Record<string, { id: string }>>;
    session: SqlSession;
    databaseSchema: string;
    owner: DatabaseOwner;
    registration?: OwnerAuthorization;
    collections: Readonly<Record<string, CollectionDefinition>>;
    operations: OperationCatalog;
  }>,
): AuthorizationOwner {
  const run = createSchemaCommandRunner(
    options.session,
    options.databaseSchema,
    () => Promise.resolve(options.owner),
  );
  const evaluate = options.registration &&
    createOwnerEvaluator({
      registration: options.registration,
      collections: options.collections,
      databaseSchema: options.databaseSchema,
    });
  const operation = (value: AuthenticatedAuthority, id: string) => {
    const authority = retainedAuthority(value);
    return run("authorization.operation", { id }, async (_, command) => {
      return await authorizeOperation(
        evaluate,
        options.operations,
        authority,
        id,
        "read",
        command,
      );
    });
  };
  type Channel = {
    id: string;
    authority: AuthenticatedAuthority;
    intent: AuthorizationIntent;
    selection: {
      collection?: string;
      record?: Readonly<{ collection: string; id: string }>;
      operationIds?: readonly string[];
    };
    dependencies: readonly AuthorityDependency[];
    generation: number;
    active: boolean;
    pending: number;
    changed?: (
      decision: import("./evaluator.ts").AuthorizationDecision,
    ) => void;
    failed(reason: unknown): void;
  };
  const channels = new Map<string, Channel>();
  const expired = () =>
    Object.assign(new Error("Observation admission expired."), {
      code: "observation_renewal_required",
      reason: "lifetime",
    });
  const revoked = () =>
    Object.assign(new Error("Observation authority was revoked."), {
      code: "revoked",
      status: 403,
    });
  const check = (channel: Channel) => {
    options.owner.signal.throwIfAborted();
    if (!channel.active) throw revoked();
    if (
      channel.authority.validity.kind === "credential" &&
      Date.parse(channel.authority.validity.expiresAt) <= Date.now()
    ) throw expired();
  };
  const close = (channel: Channel, reason?: unknown) => {
    if (!channel.active) return;
    channel.active = false;
    channel.generation++;
    channels.delete(channel.id);
    if (reason !== undefined) channel.failed(reason);
  };
  options.owner.signal.addEventListener("abort", () => {
    for (const channel of channels.values()) {
      close(channel, options.owner.signal.reason);
    }
  }, { once: true });
  const checkObservation = async (
    channel: Channel,
    command: CommandContext,
  ) => {
    check(channel);
    if (!evaluate) authorizationRefused();
    const decision = await evaluate(channel.authority, channel.intent, command);
    channel.authority = decision.authority;
    const input = channel.selection;
    const dependencies = [...decision.dependencies];
    if (input.collection) {
      const definition = options.collections[input.collection];
      if (
        !definition || !(decision.constraints.collections?.[input.collection] ??
          decision.constraints.collections?.[definition.name])
      ) authorizationRefused();
    }
    if (input.record) {
      const definition = options.collections[input.record.collection];
      const filter =
        decision.constraints.collections?.[input.record.collection] ??
          (definition && decision.constraints.collections?.[definition.name]);
      if (!definition || !filter) authorizationRefused();
      const record = await loadCollectionRecord(
        command.transaction,
        createCoreTableNames(options.databaseSchema),
        channel.authority.scope.namespace,
        definition.name,
        input.record.id,
      );
      if (!record || !matchesCollectionFilter(filter, record)) {
        authorizationRefused();
      }
      dependencies.push({
        owner: channel.authority.scope.owner,
        namespace: channel.authority.scope.namespace,
        collection: definition.name,
        id: input.record.id,
      });
    }
    for (const id of input.operationIds ?? []) {
      await assertFlowOperation(channel.authority, id, command.transaction);
      const result = await options.operations.get(
        channel.authority.scope.namespace,
        id,
        command.transaction,
      );
      if (
        !result || !decision.constraints.operations ||
        !matchesOperationConstraints(
          result.metadata?.operationMetadata ?? {},
          captureOperationConstraints(decision.constraints.operations),
        )
      ) {
        throw Object.assign(new Error("Operation was not found."), {
          code: "operation_not_found",
          status: 404,
        });
      }
    }
    channel.dependencies = dependencies;
    return decision;
  };
  const channelTable = `"${
    options.databaseSchema.replaceAll('"', '""')
  }".authorization_channels`;
  const observe = async (
    value: AuthenticatedAuthority,
    input: Readonly<
      {
        collection?: string;
        query?: import("../collections/types.ts").CollectionQuery;
        record?: Readonly<{ collection: string; id: string }>;
        operationIds?: readonly string[];
      }
    >,
    failed: (error: unknown) => void,
    changed?: (
      decision: import("./evaluator.ts").AuthorizationDecision,
    ) => void,
  ) => {
    const authority = retainedAuthority(value);
    const channel: Channel = {
      id: crypto.randomUUID(),
      authority,
      selection: input,
      intent: {
        kind: input.collection ? "collection" : "observation",
        resource: input.collection ?? input.record?.id ?? "operations",
        operation: input.collection ? "list" : "attach",
        input: input.collection
          ? {
            collection: {
              alias: input.collection,
              name: options.collections[input.collection]?.name ??
                input.collection,
            },
            method: "list",
            phase: "read",
            args: input.query ?? {},
          }
          : input,
      },
      dependencies: [],
      generation: 0,
      active: true,
      pending: 0,
      changed,
      failed,
    };
    await run("authorization.attach", {}, async (_, command) => {
      const decision = await checkObservation(channel, command);
      await command.transaction.query(
        `INSERT INTO ${channelTable}(id,namespace,tenant,authority,dependencies,owner_epoch) VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6)`,
        [
          channel.id,
          authority.scope.namespace,
          authority.scope.tenant,
          JSON.stringify(authority),
          JSON.stringify(channel.dependencies),
          command.caller.epoch,
        ],
      );
      if (channel.authority.validity.kind === "credential") {
        await writeOwnerDeadline(command.transaction, options.databaseSchema, {
          source: "authorization",
          key: channel.id,
          namespace: authority.scope.namespace,
          dueAt: channel.authority.validity.kind === "credential"
            ? channel.authority.validity.expiresAt
            : null,
        });
      }
      afterSqlCommit(command.transaction, () => {
        channels.set(channel.id, channel);
        channel.changed?.(decision);
      });
    });
    return {
      current() {
        check(channel);
        return channel.pending === 0;
      },
      async publish<T>(send: () => Promise<T>): Promise<T> {
        const delivered = Promise.withResolvers<T>();
        void delivered.promise.catch(() => undefined);
        await run(
          "authorization.publish",
          { id: channel.id },
          async (_, command) => {
            await checkObservation(channel, command);
            const generation = channel.generation;
            command.afterCommit(async () => {
              try {
                check(channel);
                if (generation !== channel.generation) {
                  delivered.resolve(await this.publish(send));
                  return;
                }
                delivered.resolve(await send());
              } catch (error) {
                delivered.reject(error);
              }
            });
          },
        ).catch((error) => {
          const reason = (error as { code?: string })?.code ===
              "observation_renewal_required"
            ? error
            : revoked();
          close(channel, reason);
          throw reason;
        });
        return await delivered.promise;
      },
      close() {
        close(channel);
        void run(
          "authorization.detach",
          { id: channel.id },
          async (_, command) => {
            await command.transaction.query(
              `DELETE FROM ${channelTable} WHERE id=$1`,
              [channel.id],
            );
            await writeOwnerDeadline(
              command.transaction,
              options.databaseSchema,
              {
                source: "authorization",
                key: channel.id,
                namespace: authority.scope.namespace,
                dueAt: null,
              },
            );
          },
        ).catch(() => undefined);
      },
    };
  };
  const notice = (
    change: { namespace: string; collection?: string; id?: string },
  ) => {
    for (const channel of channels.values()) {
      if (
        channel.authority.scope.namespace !== change.namespace ||
        !channel.dependencies.some((dependency) =>
          !change.collection ||
          authorityDependsOn(dependency, {
            owner: channel.authority.scope.owner,
            namespace: change.namespace,
            collection: change.collection,
            ...(change.id ? { id: change.id } : {}),
          })
        )
      ) continue;
      channel.generation++;
      channel.pending++;
      void run(
        "authorization.reauthorize",
        { id: channel.id },
        async (_, command) => {
          const decision = await checkObservation(channel, command);
          await command.transaction.query(
            `UPDATE ${channelTable} SET dependencies=$2::jsonb WHERE id=$1`,
            [channel.id, JSON.stringify(channel.dependencies)],
          );
          afterSqlCommit(command.transaction, () => {
            channel.pending--;
            channel.changed?.(decision);
          });
        },
      ).catch(() => close(channel, revoked()));
    }
  };
  options.owner.registerAlarmSource({
    name: "authorization",
    async wake(deadlines) {
      for (const deadline of deadlines) {
        await run(
          "authorization.expire",
          { id: deadline.key },
          async (_, command) => {
            await completeOwnerDeadline(
              command.transaction,
              options.databaseSchema,
              deadline,
            );
            await command.transaction.query(
              `DELETE FROM ${channelTable} WHERE id=$1`,
              [deadline.key],
            );
            afterSqlCommit(command.transaction, () => {
              const channel = channels.get(deadline.key);
              if (channel) close(channel, expired());
            });
          },
        );
      }
    },
  });

  const sessionTable = `"${
    options.databaseSchema.replaceAll('"', '""')
  }".authorization_sessions`;
  const createSession = async (
    value: AuthenticatedAuthority,
    input: Readonly<{ id: string; principal: string; expiresAt: string }>,
    joined?: CommandContext,
    invocation?: { kind: "action"; id: string; runId: string },
  ) => {
    const authority = retainedAuthority(value);
    if (
      !input.id.trim() || !input.principal.trim() ||
      !Number.isFinite(Date.parse(input.expiresAt))
    ) throw new TypeError("Invalid tenant session.");
    const execute = async (command: CommandContext) => {
      if (!evaluate) authorizationRefused();
      const decision = await evaluate(authority, {
        kind: "session",
        resource: input.id,
        operation: "create",
        input,
        ...(invocation ? { invocation } : {}),
      }, command);
      const grant = decision.constraints.sessions?.create;
      const lifetime = Date.parse(input.expiresAt) -
        Date.parse(command.commandTime);
      if (
        !grant || grant.principal !== input.principal ||
        !Number.isSafeInteger(grant.maxAge) || grant.maxAge <= 0 ||
        grant.maxAge > 31536000 || lifetime <= 0 ||
        lifetime > grant.maxAge * 1000
      ) authorizationRefused();
      await command.transaction.query(
        `INSERT INTO ${sessionTable}(namespace,tenant,id,principal,expires_at) VALUES($1,$2,$3,$4,$5::timestamptz)`,
        [
          authority.scope.namespace,
          authority.scope.tenant,
          input.id,
          input.principal,
          input.expiresAt,
        ],
      );
    };
    if (joined) await execute(joined);
    else {await run("authorization.session.create", input, (_, command) =>
        execute(command));}
  };
  const revokeSession = async (
    value: AuthenticatedAuthority,
    id: string,
    joined?: CommandContext,
    invocation?: { kind: "action"; id: string; runId: string },
  ) => {
    const authority = retainedAuthority(value);
    const execute = async (command: CommandContext) => {
      if (!evaluate) authorizationRefused();
      const decision = await evaluate(authority, {
        kind: "session",
        resource: id,
        operation: "revoke",
        input: { id },
        ...(invocation ? { invocation } : {}),
      }, command);
      const permission = decision.constraints.sessions?.revoke;
      if (
        permission !== "tenant" &&
        !(permission === "self" &&
          authority.authorityBasis.kind === "session" &&
          authority.authorityBasis.id === id)
      ) authorizationRefused();
      await command.transaction.query(
        `UPDATE ${sessionTable} SET revoked_at=COALESCE(revoked_at,$4::timestamptz) WHERE namespace=$1 AND tenant=$2 AND id=$3`,
        [
          authority.scope.namespace,
          authority.scope.tenant,
          id,
          command.commandTime,
        ],
      );
      afterSqlCommit(command.transaction, () => {
        for (const channel of channels.values()) {
          if (
            channel.authority.scope.tenant === authority.scope.tenant &&
            channel.authority.scope.namespace === authority.scope.namespace &&
            channel.authority.authorityBasis.kind === "session" &&
            channel.authority.authorityBasis.id === id
          ) close(channel, revoked());
        }
      });
    };
    if (joined) await execute(joined);
    else {await run("authorization.session.revoke", { id }, (_, command) =>
        execute(command));}
  };
  return {
    credentials: createCredentialEffects({
      session: options.session,
      schema: options.databaseSchema,
      master: options.master,
      evaluate,
      actions: options.actions ?? {},
      authorizeProjection: (authority, id, command) =>
        authorizeOperation(
          evaluate,
          options.operations,
          authority,
          id,
          "read",
          command,
        ),
      create: createSession,
      revoke: revokeSession,
    }),
    asset(value, id) {
      const authority = retainedAuthority(value);
      return run("authorization.asset", { id }, async (_, command) => {
        if (!evaluate) authorizationRefused();
        const decision = await evaluate(authority, {
          kind: "asset",
          resource: id,
          operation: "read",
          input: { id },
        }, command);
        if (!decision.constraints.assets?.read?.includes(id)) {
          authorizationRefused();
        }
      });
    },
    operation,
    observe,
    notice,
    createSession,
    revokeSession,
    assertResources(resources) {
      for (const kind of ["collections", "actions"] as const) {
        for (const alias of resources[kind]) {
          if (!options.registration?.[kind][alias]) {
            throw new TypeError(
              `Missing owner authorization binding for ${kind} '${alias}'.`,
            );
          }
        }
      }
      if (!options.registration) {
        throw new TypeError(
          "Server requires owner authorization registrations.",
        );
      }
    },
  };
}
