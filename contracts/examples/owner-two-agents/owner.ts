/** Owner-only composition. It stores/authorizes/dispatches, and executes no plugin work. */
import {
  ActionError,
  createCopilotz,
  isStreamOutput,
} from "@copilotz/copilotz";
import { message } from "@copilotz/copilotz/core";
import { defineServerFacade } from "@copilotz/copilotz/server";
import type { CollectionPolicy } from "@copilotz/copilotz/collections";
import { demoPlugin } from "./composition.ts";
export async function createOwner(
  options: { databaseUrl: string; databaseSchema: string; capability: string },
) {
  const { databaseSchema, capability } = options;
  const denied = () =>
    new ActionError("Local demo authorization required.", {
      code: "forbidden",
      status: 403,
    });
  const policy: CollectionPolicy = {
    authorize(intent, context) {
      if (context.invocation.kind === "viewer") {
        if (
          context.invocation.actor.id === "local-demo-viewer" &&
          ["get", "list"].includes(intent.method)
        ) return;
        throw denied();
      }
      if (
        context.invocation.kind === "action" &&
        intent.collection.alias === "plan"
      ) {
        const methods: Readonly<Record<string, readonly string[]>> = {
          "demo.plan.saveDraft": ["get", "create"],
          "demo.plan.read": ["get"],
          "demo.plan.review": ["get", "update"],
          "demo.plan.publish": ["get", "update"],
        };
        if (methods[context.invocation.id]?.includes(intent.method)) return;
      }
      if (
        context.invocation.kind === "processor" &&
        context.invocation.id === "demo.recordEvidence" &&
        intent.collection.alias === "evidence" && intent.method === "create"
      ) return;
      throw denied();
    },
  };
  let generation = 0;
  const app = await createCopilotz({
    role: "gateway",
    database: { url: options.databaseUrl },
    namespace: "owner-demo",
    databaseSchema,
    plugins: [demoPlugin],
    collectionPolicies: { plan: policy, evidence: policy },
    transports: [{ type: "websocket", config: { path: "/workers" } }],
    target: { workerId: "demo-worker" },
    admit(context) {
      if (
        context.credential.capability !== capability ||
        context.identity.workerId !== "demo-worker"
      ) throw denied();
      return {
        definition: {
          workerId: "demo-worker",
          providerId: "local-browser",
          workloads: [...context.workloads],
          capacity: context.capacity,
          providerConfig: {},
          labels: {},
        },
        sessionGeneration: ++generation,
        authenticatedWith: context.credential.kind,
        resume: {
          credential: { kind: "resume", capability },
          expiresAtMs: Date.now() + 3600000,
        },
      };
    },
    resources: {
      server: {
        default: defineServerFacade({
          expose: {
            actions: false,
            channels: false,
            collections: {
              include: ["demo_plan", "demo_evidence"],
              operations: { include: ["get", "list", "observe"] },
            },
          },
          authenticate(request) {
            if (
              request.headers.get("authorization") !== `Bearer ${capability}`
            ) throw denied();
            return {
              namespace: "owner-demo",
              databaseSchema,
              actor: { id: "local-demo-viewer" },
              context: {
                viewer: {
                  kind: "session",
                  subject: "local-demo-viewer",
                  expiresAt: Math.floor(Date.now() / 1000) + 3600,
                },
              },
            };
          },
          authorize() {
            return {};
          },
        }),
      },
    },
  });
  async function send(runId: string, phase: "ENROLL" | "START") {
    const handle = await app.send(message({
      thread: { externalId: `demo-${runId}` },
      participant: { externalId: "demo-user", participantType: "human" },
      recipientIds: phase === "ENROLL"
        ? ["coordinator", "reviewer"]
        : ["coordinator"],
      deduplicationId: `demo-${runId}-${phase}`,
      correlationId: `demo-run:${runId}`,
      content: `${phase}_DEMO runId=${runId}. ${
        phase === "ENROLL"
          ? "Introduce your role."
          : "Create a release plan, consult the reviewer, and publish the reviewed plan."
      }`,
    }));
    const replies: string[] = [], facts: string[] = [], failures: string[] = [];
    const drain = (async () => {
      for await (const output of handle.outputs) {
        if (!isStreamOutput(output)) {
          if (output.durable) {
            facts.push(output.type);
            if (output.type.endsWith(".failed")) failures.push(output.type);
          }
          continue;
        }
        if (output.role === "content" && output.mediaType.startsWith("text/")) {
          const decoder = new TextDecoder();
          let text = "";
          for await (const bytes of output.payload) {
            text += decoder.decode(bytes, { stream: true });
          }
          text += decoder.decode();
          replies.push(text);
          const terminal = await output.terminal;
          if (terminal.outcome !== "completed") {
            failures.push(`stream:${terminal.outcome}`);
          }
        } else await output.payload.cancel();
      }
    })();
    const results = await Promise.allSettled([drain, handle.done]);
    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
    }
    if (failures.length) {
      throw new Error(`Scenario recorded failures: ${failures.join(", ")}`);
    }
    return {
      operationId: handle.operationId,
      correlationId: handle.correlationId,
      replies,
      facts,
    };
  }
  return {
    app,
    async run(runId: string) {
      if (!/^[a-zA-Z0-9-]{1,80}$/.test(runId)) {
        throw new TypeError(
          "Invalid runId.",
        );
      }
      const enrolled = await send(runId, "ENROLL");
      const completed = await send(runId, "START");
      return { runId, enrolled, completed };
    },
  };
}
