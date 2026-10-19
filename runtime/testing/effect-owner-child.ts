/** Test-only owner process killed after durable effect begin. */
import { createTestDatabase } from "./ominipg.ts";
import { createOwnerEffectClient } from "../actions/effect-commands.ts";
import { localPostgresUrl } from "./effect-commit-proxy.ts";
const [url, schema] = Deno.args;
const db = await createTestDatabase({
  url: localPostgresUrl(url),
  pgPoolMax: 1,
});
const client = createOwnerEffectClient({
  session: db,
  schema,
  namespace: "space",
  actionRunId: "subprocess",
});
await client.begin("dispatch");
console.log("effect-begun");
await new Promise(() => setInterval(() => {}, 1000));
