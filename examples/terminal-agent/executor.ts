/**
 * A remote executor for the terminal agent: runs its plugins' code in this
 * process and reaches the owner only over Oxian's WebSocket transport.
 *
 *   deno task chat --listen=8787 --executors=0   the owner, in one terminal
 *   deno task executor --port=8787      one or more executors, in others
 *
 * The owner keeps its executor key in .data/executor.key; executors on this
 * machine read it from there (or from COPILOTZ_EXECUTOR_KEY). Start them in any order.
 */
import { parseArgs } from "jsr:@std/cli@1.0.24/parse-args";
import { createExecutor } from "../../runtime/mod.ts";
import { EXECUTORS, KEY_FILE, plugins } from "./app.ts";

const args = parseArgs(Deno.args, { string: ["port", "id"] });
const url = `ws://127.0.0.1:${args.port ?? 8787}${EXECUTORS}`;
/** Waits for the owner to create its key file, if the executor started first. */
async function ownerKey() {
  for (let waiting = false;; waiting = true) {
    try {
      return (await Deno.readTextFile(KEY_FILE)).trim();
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      if (!waiting) console.log(`waiting for the owner to create ${KEY_FILE}…`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

const executor = createExecutor({
  id: args.id,
  plugins,
  transport: { type: "websocket", config: { url, allowInsecureLoopback: true } },
  key: Deno.env.get("COPILOTZ_EXECUTOR_KEY") ?? await ownerKey(),
});
try {
  await executor.ready;
  console.log(`executor connected to ${url}`);
} catch (error) {
  const refused = String(error).includes("authentication_failed");
  console.error(
    refused
      ? `The owner refused this executor's key. Restart the executor, or check COPILOTZ_EXECUTOR_KEY.`
      : `Could not connect to ${url}: ${error instanceof Error ? error.message : error}`,
  );
  Deno.exit(1);
}
