/** Test-only sole-runtime owner; never imported by production. */
import {
  type CommandContext,
  createOwnerCommands,
} from "../../engine/commands.ts";
import { writeOwnerDeadline } from "../../engine/alarms.ts";
import { createCoreTableNames, createEventStore } from "../../events/index.ts";
import type { SqlSession } from "../../events/session.ts";
import { createTestDatabase } from "../ominipg.ts";
import { bounded, localPostgresUrl } from "../effect-commit-proxy.ts";

export type FixtureInput = { id: string; fail?: boolean };
export type FixtureNotice = {
  type: string;
  id?: string;
  [key: string]: unknown;
};
export const fixtureRequest = (id: string, fail = false) => ({
  input: { id, fail },
  receipt: {
    identity: { domain: "logical" as const, key: id },
    intent: { id, fail },
  },
});

export function commitFixtureOwner(
  session: SqlSession,
  schema: string,
  holder: string,
  notice: (message: FixtureNotice) => void,
  maxGroupCount = 4,
) {
  const tables = createCoreTableNames(schema);
  return createOwnerCommands({
    session,
    schema,
    holderId: holder,
    maxGroupCount,
    handlers: {
      write: {
        authorize() {},
        async execute(input: FixtureInput, context: CommandContext) {
          notice({ type: "handler", id: input.id });
          const store = createEventStore({
            session: context.transaction as SqlSession,
            schema,
          });
          await store.commitMutation({
            eventId: `event:${input.id}`,
            draft: {
              type: "fixture.committed",
              namespace: "space",
              subject: { type: "fixture", id: input.id },
              correlationId: input.id,
              deduplicationId: input.id,
              payload: {
                dataRef: {
                  eventBodyId: `body:${input.id}`,
                  schemaVersion: 1,
                  mediaType: "application/json",
                },
              },
            },
            body: { id: `body:${input.id}`, json: { id: input.id } },
            consumers: [{
              consumerId: "processor:fixture",
              settlement: "inherit",
            }],
            async mutate({ transaction }) {
              await transaction.query(
                `INSERT INTO ${tables.nodes}(id,namespace,type,name,data) VALUES($1,'space','fixture',$1,$2::jsonb)`,
                [input.id, JSON.stringify({ value: input.id })],
              );
            },
          });
          await writeOwnerDeadline(context.transaction, schema, {
            source: "fixture",
            key: input.id,
            namespace: "space",
            dueAt: "2100-01-01T00:00:00Z",
            payload: { id: input.id },
          });
          context.afterCommit(() =>
            notice({ type: "published", id: input.id })
          );
          context.afterCommit(() =>
            notice({ type: "dispatch-callback", id: input.id })
          );
          if (input.fail) throw new Error("deliberate command rejection");
          return { id: input.id };
        },
      },
    },
  });
}

if (import.meta.main) {
  const [url, schema, mode] = Deno.args;
  const db = await createTestDatabase({
    url: localPostgresUrl(url, `${schema}_old`),
    pgPoolMax: 1,
  });
  const seedPublished = Promise.withResolvers<void>();
  const send = (message: FixtureNotice) => {
    console.log(`OWNER_COMMIT ${JSON.stringify(message)}`);
    if (message.type === "dispatch-callback" && message.id === "existing") {
      seedPublished.resolve();
    }
  };
  const owner = commitFixtureOwner(
    db,
    schema,
    "predecessor",
    send,
    mode === "group" ? 4 : 1,
  );
  try {
    const caller = {
      principal: "fixture-worker",
      epoch: await owner.acquire(0),
    };
    await owner.execute("write", caller, fixtureRequest("existing"));
    await bounded(seedPublished.promise, "seed publications");
    try {
      await owner.execute("write", caller, fixtureRequest("failed", true));
      throw new Error("Failed command unexpectedly succeeded");
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !== "deliberate command rejection"
      ) throw error;
    }
    send({ type: "ready", epoch: owner.epoch });
    let pending = "";
    for await (
      const chunk of Deno.stdin.readable.pipeThrough(new TextDecoderStream())
    ) {
      pending += chunk;
      while (pending.includes("\n")) {
        const end = pending.indexOf("\n");
        const command = pending.slice(0, end);
        pending = pending.slice(end + 1);
        if (command === "stop") {
          owner.stop();
          await db.close();
          Deno.exit(0);
        }
        if (command !== "commit" && command !== "group") {
          throw new Error(`Unexpected fixture command ${command}`);
        }
        const requests = command === "group"
          ? [
            fixtureRequest("existing"),
            {
              ...fixtureRequest("existing"),
              receipt: {
                ...fixtureRequest("existing").receipt,
                intent: { changed: true },
              },
            },
            fixtureRequest("new"),
            fixtureRequest("failed", true),
            fixtureRequest("queued"),
          ]
          : [fixtureRequest("new"), fixtureRequest("queued")];
        const results = await Promise.allSettled(
          requests.map(async (request) => {
            const id = request.input.id;
            try {
              const result = await owner.execute(
                "write",
                caller,
                request,
              );
              send({ type: "result", id, status: "fulfilled", result });
              return result;
            } catch (error) {
              send({
                type: "result",
                id,
                status: "rejected",
                code: (error as { code?: string }).code,
              });
              throw error;
            }
          }),
        );
        send({
          type: "settled",
          state: owner.state,
          statuses: results.map((result) => result.status),
        });
      }
    }
  } finally {
    owner.stop();
    await db.close();
  }
}
