/** Actual public owner/worker context flow. Source records are created through
 * owner Collection commands; fixture SQL is assertion/policy reads only. */
import assert from "node:assert/strict";
import {
  createCopilotz,
  type OwnerConnectionOptions,
  type OwnerStorageOptions,
} from "../../create-copilotz.ts";
import { defineAction } from "../actions/define.ts";
import type { ActionContext } from "../actions/types.ts";
import { defineCollection } from "../collections/definition.ts";
import { definePlugin } from "../plugins/types.ts";
import { defineView } from "../views/definition.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import { encodeOwnerMetadataConstraints } from "../owner/metadata-constraints.ts";
import { ownerAssignmentKey } from "../owner/assignments.ts";
import type { OwnerCaller } from "../owner/boundary.ts";
import type { SqlExecutor, SqlSession } from "../events/session.ts";
import type { Hypervisor } from "../../dependencies/oxian-hypervisor.ts";
import { resolveOxianSource } from "../../scripts/test-owner-connected.mjs";

export async function eventually(check: () => boolean | Promise<boolean>) {
  const until = Date.now() + 12_000;
  while (!await check()) {
    if (Date.now() >= until) {
      throw new Error("preparation host fixture timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
export async function fixture(
  mode: "in-process" | "websocket",
  scenario = "normal",
) {
  const { entrypoints } = await resolveOxianSource(
    process.env.COPILOTZ_OXIAN_SOURCE_ROOT!,
  );
  const { createHypervisor } = await import(entrypoints["./hypervisor"]);
  const { createWorker } = await import(entrypoints["./worker"]);
  const { serve } = await import(entrypoints["./adapters/node"]);
  const db = await createTestDatabase({ pgliteMemoryProfile: "low-memory" });
  const state = {
    rendered: 0,
    mapped: 0,
    childExecuted: 0,
    projected: 0,
    originalAllowed: true,
    replacedConfiguration: false,
    version: "original",
    parentCtx: true,
    recordId: scenario,
    rootResultAllowed: true,
    revokeChildInput: false,
    revokeChildResult: false,
    originalChecks: 0,
  };
  const errors: unknown[] = [];
  const plugin = definePlugin({
    id: "prepared-context",
    version: "1",
    collections: {
      notes: defineCollection({
        name: "context_note",
        schema: {
          type: "object",
          properties: {
            id: { type: "string" },
            title: { type: "string" },
            hidden: { type: "string" },
          },
          required: ["title", "hidden"],
        } as const,
      }),
    },
    actions: {
      child: defineAction({
        id: "context.child",
        inputSchema: { type: "string" } as const,
        outputSchema: { type: "string" } as const,
        execute(value: string) {
          state.childExecuted++;
          if (scenario === "result-revoked" || state.revokeChildResult) {
            state.originalAllowed = false;
          }
          return `child:${value}`;
        },
      }),
      parent: defineAction({
        id: "context.parent",
        inputSchema: { type: "string" } as const,
        outputSchema: { type: "array", items: { type: "string" } } as const,
        async execute(id: string, ctx: ActionContext) {
          await ctx.transaction(({ collections }) => {
            collections.notes.create({ id, title: "first", hidden: "private" });
          }, { operationKey: "source" });
          const request = {
            preparation: scenario === "missing" ? "missing" : "notes.context",
            recordId: id,
            mode: scenario === "generic" ? "brief" : "context",
          };
          const first = await ctx.actions.child.prepareNamed(request, {
            operationKey: "reply",
          });
          if (!["normal", "generic", "snapshot"].includes(scenario)) {
            return [String(first)];
          }
          await ctx.transaction(({ collections }) => {
            collections.notes.update({
              id,
              set: { title: "changed", hidden: "changed-private" },
            });
          }, { operationKey: "edit-source" });
          state.version = "changed";
          const duplicate = await ctx.actions.child.prepareNamed(request, {
            operationKey: "reply",
          });
          return [String(first), String(duplicate)];
        },
      }),
    },
    views: {
      note: defineView({
        id: "context.note",
        shows: "context_note",
        renderer: "text",
        modes: ["context"],
        render(value: { record: { title: string } }) {
          state.rendered++;
          if (scenario === "parent-revoked") state.parentCtx = false;
          return `${value.record.title}:${state.version}`;
        },
      }),
    },
  });
  async function currentSource(
    tx: SqlExecutor,
    caller: OwnerCaller,
    time: string,
  ) {
    if (
      caller.principal.kind !== "worker" ||
      !["parent", "embedded"].includes(caller.principal.workerId)
    ) throw new Error("source principal refused");
    if (
      typeof caller.sessionId !== "string" ||
      typeof caller.assignmentId !== "string"
    ) throw new Error("source binding refused");
    // The real host first proves current authenticated Started/ctx authority.
    // At claim, that exact reservation precedes attempt activation. Only an
    // untouched pending row or this exact current attempt satisfies the data policy.
    const rows = await tx.query<
      { namespace: string; binding: Record<string, unknown> }
    >(
      `SELECT e.namespace,a.binding FROM owner_assignments a JOIN event_deliveries d ON d.id=a.delivery_id JOIN events e ON e.id=d.event_id WHERE a.owner=$1 AND a.epoch=$2 AND a.assignment_key=$3 AND a.retired=FALSE AND e.owner_id=$1 AND e.namespace='space' AND e.id=a.binding->>'sourceEventId' AND e.metadata->>'actionId'=a.binding->>'actionId' AND e.metadata->>'actionRunId'=a.binding->>'executionId' AND d.consumer_id='registered:'||(a.binding->>'actionId') AND ((d.status='pending' AND d.attempts=0 AND d.lease_owner IS NULL AND d.lease_expires_at IS NULL AND d.available_at<=$4::timestamptz) OR (d.status='leased' AND d.lease_owner=a.binding->>'dispatchAttemptId' AND d.lease_expires_at IS NULL))`,
      [
        "owner",
        caller.ownerEpoch,
        ownerAssignmentKey("owner", {
          placement: "worker",
          sessionId: caller.sessionId,
          assignmentId: caller.assignmentId,
        }),
        time,
      ],
    );
    if (rows.rows.length !== 1) {
      errors.push(
        new Error(
          `source policy has no current claimable/live assignment: ${
            JSON.stringify({
              caller,
              rendered: state.rendered,
              mapped: state.mapped,
              childExecuted: state.childExecuted,
            })
          }`,
        ),
      );
    }
    assert.equal(
      rows.rows.length,
      1,
      "current exact original source assignment",
    );
    assert.equal(rows.rows[0].namespace, "space");
    for (
      const name of [
        "sessionId",
        "assignmentId",
        "workerAttemptId",
        "sessionGeneration",
        "parentOperationId",
        "deliveryId",
        "dispatchAttemptId",
        "sourceEventId",
        "actionId",
        "executionId",
      ] as const
    ) assert.equal(rows.rows[0].binding[name], caller[name]);
    assert.equal(rows.rows[0].binding.workerId, caller.principal.workerId);
  }
  const preparation = {
    records: {
      sources: { notes: { collectionAlias: "notes" } },
      async authorize(tx, context) {
        assert.equal(context.ownerId, "owner");
        assert.equal(context.request.source, "notes");
        assert.equal(context.request.recordId, state.recordId);
        await currentSource(tx, context.caller, context.commandTime);
        return { namespace: "space", audience: "context-reader" };
      },
      projectRecord(record) {
        state.projected++;
        return { title: record.title };
      },
      async authorizeReference(tx, context) {
        state.originalChecks++;
        await currentSource(tx, context.caller, context.commandTime);
        assert.equal(context.reference.source.recordId, state.recordId);
        assert.equal(context.reference.source.namespace, "space");
        assert.equal(context.reference.source.kind, "context_note");
        assert.equal(context.reference.audience, "context-reader");
        if (!state.originalAllowed) {
          throw new Error("original projection permission revoked");
        }
        return true as const;
      },
    },
    registrations: {
      "notes.context": {
        source: "notes",
        actionAlias: "child",
        shows: "context_note",
        modes: ["context", "brief"],
        mapInput(text) {
          state.mapped++;
          return text;
        },
      },
    },
    projectResource() {
      throw new Error("no resource registered");
    },
    authorizeResource() {
      throw new Error("no resource registered");
    },
  } satisfies NonNullable<OwnerStorageOptions["storage"]["preparation"]>;
  const session: SqlSession = {
    async query(sql, params) {
      if (scenario === "snapshot" && !state.replacedConfiguration) {
        await Promise.resolve();
        state.replacedConfiguration = true;
        preparation.records.sources.notes.collectionAlias = "replaced";
        preparation.records.authorize = () => {
          throw new Error("replacement source callback invoked");
        };
        preparation.records.authorizeReference = () => {
          throw new Error("replacement reference callback invoked");
        };
        preparation.records.projectRecord = () => {
          throw new Error("replacement projection callback invoked");
        };
        preparation.registrations["notes.context"].source = "replaced";
        preparation.registrations["notes.context"].mapInput = () => {
          throw new Error("replacement mapper invoked");
        };
      }
      return await db.query(sql, params);
    },
    transaction: db.transaction,
  };
  async function start(prior: number) {
    const local = {
      type: "in-process" as const,
      config: { topic: crypto.randomUUID() },
    };
    let transport: Hypervisor | undefined;
    const worker = (id: string, connection: unknown) => ({
      id,
      transport: connection,
      capacity: 1,
      hostCalls: { maxConcurrent: 8, timeoutMs: 10_000 },
      activate: () => ({
        workerId: id,
        attemptId: crypto.randomUUID(),
        epoch: 1,
      }),
      register: () => ({
        credential: { kind: "registration", capability: "fixture" },
        expiresAtMs: Date.now() + 60_000,
      }),
      reconnectDelay: false,
    });
    const options = {
      namespace: "space",
      plugins: [plugin],
      childWaitMs: 10_000,
      storage: {
        ownerId: "owner",
        holderId: `holder:${prior + 1}`,
        schema: "public",
        session,
        initialization: prior === 0
          ? "fresh"
          : { mode: "resume", expectedEpoch: prior },
        preparation,
        maxActive: scenario === "one-slot" ? 1 : 2,
        maxPending: 32,

        onError: (error) => errors.push(error),
        policy: {
          ingress: (_tx, { fence, route }) =>
            ["parent", "embedded"].includes(fence.identity.workerId) &&
              (route !== "action-result" || state.rootResultAllowed)
              ? {
                namespace: "space",
                principalKey: "api:context",
                principal: { actorId: "api:context" },
                route: { kind: "wrapper", id: "context-only" },
                allowedActions: ["parent"],
                actionMetadata: {},
                operationMetadata: { tenant: "space" },
                metadataConstraints: encodeOwnerMetadataConstraints({
                  actorId: "api:context",
                  tenant: "space",
                }),
                group: { key: "context", actorId: "api:context" },
              }
              : undefined,
          worker: (_tx, { fence }) =>
            ["parent", "embedded"].includes(fence.identity.workerId)
              ? {
                ctx: fence.identity.workerId !== "parent" || state.parentCtx,
                settlement: true,
              }
              : undefined,
          input(_tx, assignment) {
            assert.equal(assignment.namespace, "space");
            assert.ok(
              ["context.parent", "context.child"].includes(assignment.actionId),
            );
            if (
              (scenario === "input-revoked" || state.revokeChildInput) &&
              assignment.actionId === "context.child"
            ) state.originalAllowed = false;
          },
          collections(_tx, assignment) {
            assert.ok("actionId" in assignment);
            assert.equal(assignment.actionId, "context.parent");
            assert.equal(assignment.namespace, "space");
            return {};
          },
          child(_tx, parent, actionId) {
            assert.equal(parent.namespace, "space");
            assert.ok(parent.actionRunId);
            assert.equal(actionId, "context.child");
          },
          effectOutcome: () => false,
          effectNotStarted: () => false,
        },
        transport: {
          transports: mode === "websocket"
            ? [local, { type: "websocket", config: { path: "/workers" } }]
            : [local],
          admit: ({ identity, credential, workloads, capacity }) => ({
            definition: {
              workerId: identity.workerId,
              providerId: "fixture",
              workloads,
              capacity,
              providerConfig: {},
              labels: {},
            },
            sessionGeneration: 1,
            authenticatedWith: credential.kind,
            resume: {
              credential: { kind: "resume", capability: "fixture" },
              expiresAtMs: Date.now() + 60_000,
            },
          }),
          assign: ({ available }) =>
            available.find((fence) => fence.identity.workerId === "parent") ??
              available.find((fence) => fence.identity.workerId === "embedded"),
        },
        createTransport(options, lifecycle) {
          transport = createHypervisor(options, lifecycle);
          return transport!;
        },
      },
      worker: { connection: worker("embedded", local) as never, createWorker },
    } satisfies OwnerStorageOptions;
    const app = await createCopilotz(options);
    let listener: Awaited<ReturnType<typeof serve>> | undefined;
    const connect = (options: Omit<OwnerConnectionOptions, "plugins">) =>
      createCopilotz({ ...options, plugins: [plugin] });
    let remote: Awaited<ReturnType<typeof connect>> | undefined;
    try {
      await app.ready;
      if (mode === "websocket") {
        listener = await serve({ hypervisor: transport });
      }
      const url = listener ? new URL("/workers", listener.url) : undefined;
      if (url) url.protocol = "ws:";
      remote = await connect({
        namespace: "space",
        owner: { id: "owner" },
        childWaitMs: 10_000,
        worker: {
          connection: worker(
            "parent",
            url
              ? {
                type: "websocket",
                config: { url, allowInsecureLoopback: true },
              }
              : local,
          ) as never,
          createWorker,
        },
      });
      await remote.ready;
      let closed = false;
      return {
        app,
        remote,
        async close() {
          if (closed) return;
          closed = true;
          await remote?.close();
          await app.close();
          await listener?.shutdown();
        },
      };
    } catch (error) {
      await remote?.close();
      await app.close();
      await listener?.shutdown();
      throw error;
    }
  }
  let current: Awaited<ReturnType<typeof start>>;
  try {
    current = await start(0);
  } catch (error) {
    await db.close();
    throw error;
  }
  let closed = false;
  return {
    get app() {
      return current.app;
    },
    get remote() {
      return current.remote;
    },
    state,
    errors,
    query: db.query,
    async restart(prior: number) {
      await current.close();
      current = await start(prior);
    },
    async close() {
      if (closed) return;
      closed = true;
      await current.close();
      await db.close();
    },
  };
}
