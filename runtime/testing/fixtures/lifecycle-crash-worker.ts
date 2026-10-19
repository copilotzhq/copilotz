/** Real process-loss fixture for Action claim and post-execution settlement. */
import { createCopilotzApplication } from "../../application/application.ts";
import {
  type ActionCallers,
  type ActionContext,
  defineAction,
} from "../../actions/index.ts";
import {
  definePlugin,
  defineProcessor,
  type ProcessorContext,
} from "../../plugins/index.ts";
import { createTestDatabase } from "../ominipg.ts";
import type { SqlSession } from "../../events/session.ts";

const [url, schema, cut, recovery] = Deno.args;
const db = await createTestDatabase({ url, pgPoolMax: 4 });
const pause = async (point: string) => {
  if (!recovery && point === cut) {
    console.log(`LIFECYCLE cut:${point}`);
    await new Promise<void>(() => setInterval(() => {}, 60_000));
  }
};
const database: SqlSession & { close(): Promise<void> } = {
  ...db,
  async transaction(run) {
    let terminal = false;
    const result = await db.transaction((tx) =>
      run({
        query(sql, params) {
          terminal ||= params?.includes("fixture.effect.completed") ?? false;
          return tx.query(sql, params);
        },
      })
    );
    // COMMIT really completed, but the workload has not received its result.
    if (terminal) await pause("stream-terminal");
    return result;
  },
};
const send = defineAction({
  id: "fixture.effect",
  async execute(_input: unknown, context: ActionContext) {
    const permit = await context.effect.begin("send");
    if (permit.status === "replay") return permit.outcome;
    if (permit.status !== "proceed") {
      throw new Error("Effect cannot be repeated");
    }
    console.log("LIFECYCLE effect");
    await context.effect.confirm("send", { accepted: true });
    if (cut === "stream-terminal") {
      const stream = await context.streams.open({
        id: "output",
        mediaType: "text/plain",
        role: "output",
      });
      await stream.append({
        appendId: "one",
        bytes: new TextEncoder().encode("accepted"),
      });
      await stream.close({ assetId: "stream-output" });
    }
    return { accepted: true };
  },
});
type Context = ProcessorContext<
  ProcessorContext["resources"],
  ProcessorContext["adapters"],
  ActionCallers<{ send: typeof send }>,
  ProcessorContext["collections"]
>;
const plugin = definePlugin({
  id: "fixture.lifecycle-crash",
  version: "1.0.0",
  actions: { send },
  processors: {
    invoke: defineProcessor<Context>({
      id: "fixture.invoke",
      on: [{ eventType: "fixture.trigger" }],
      async handle(_event, context) {
        await pause("claim");
        await context.actions.send({}, { operationKey: "send" });
        await pause("terminal");
        console.log("LIFECYCLE handled");
      },
    }),
  },
});
const app = await createCopilotzApplication({
  database,
  databaseSchema: schema,
  namespace: "scope",
  plugins: [plugin],
  engine: { retryBaseMs: 0, random: () => 0 },
});
console.log("LIFECYCLE ready");
if (!recovery) {
  if (cut === "stream-terminal") {
    await app.host.actions.send({}, { idempotencyKey: "root" });
  } else {
    const run = await app.send({
      type: "fixture.trigger",
      deduplicationId: "trigger",
    });
    await run.done;
  }
}
// Parent owns process lifetime, including the recovery observation window.
await new Promise<void>(() => setInterval(() => {}, 60_000));
