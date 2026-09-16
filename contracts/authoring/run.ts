import { createCopilotz } from "@copilotz/copilotz";
import { message } from "@copilotz/copilotz/core";
import support from "./dist/plugin.js";
const app = await createCopilotz({
  namespace: "convention-demo",
  database: { url: ":memory:" },
  plugins: [support],
});
try {
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
