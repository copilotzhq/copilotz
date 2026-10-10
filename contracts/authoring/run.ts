import {
  createCopilotz,
  defineAction,
  defineCollection,
} from "@copilotz/copilotz";
import { message } from "@copilotz/copilotz/core";
import support from "./dist/plugin.js";
const app = await createCopilotz({
  namespace: "convention-demo",
  database: { url: ":memory:" },
  plugins: [support],
  collections: {
    smokeNotes: defineCollection({
      name: "smoke_note",
      schema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      } as const,
    }),
  },
  actions: {
    smokeEcho: defineAction({
      id: "smoke.echo",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      } as const,
      execute: (input: { text: string }) => input,
    }),
  },
});
try {
  // Exercise result-only host calls alongside the streaming send surface.
  const echoed = await app.actions.smokeEcho({ text: "host smoke" }, {
    idempotencyKey: "smoke-action",
  });
  const stored = await app.collections.smokeNotes.create(echoed, {
    idempotencyKey: "smoke-create",
  });
  const retry = await app.collections.smokeNotes.create(echoed, {
    idempotencyKey: "smoke-create",
  });
  const read = await app.collections.smokeNotes.get({ id: stored.id });
  if (read?.text !== "host smoke" || retry.id !== stored.id) {
    throw new Error(
      "Host invocation, Collection read or mutation replay failed.",
    );
  }
  await (await app.send({ type: "example.started" })).done;
  const sent = await app.send(
    message({
      thread: "demo-thread",
      participant: "demo-user",
      recipientIds: ["demo-agent"],
      content: "Hello!",
    }),
  );
  let reply = "";
  for await (const output of sent.outputs) {
    if (output.type === "stream.output") {
      for await (const bytes of output.payload) {
        reply += new TextDecoder().decode(bytes);
      }
    }
  }
  await sent.done;
  if (!reply.includes("Hello from the generated support plugin.")) {
    throw new Error(`Missing agent reply: ${reply}`);
  }
  console.log(reply);
} finally {
  await app.close();
}
