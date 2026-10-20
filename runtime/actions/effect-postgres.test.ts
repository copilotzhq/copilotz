import { assertEquals, assertRejects } from "@std/assert";
import { createTestDatabase } from "../testing/ominipg.ts";
import { provisionCopilotzSchema } from "../events/schema.ts";
import {
  bounded,
  commitProxy,
  localPostgresUrl,
} from "../testing/effect-commit-proxy.ts";
import { createOwnerEffectClient } from "./effect-commands.ts";
const url = Deno.env.get("COPILOTZ_TEST_POSTGRES_URL");

Deno.test({
  name:
    "PostgreSQL lost COMMIT acknowledgement never grants effect dispatch on recovery",
  ignore: !url,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const schema = `effect_commit_${crypto.randomUUID().replaceAll("-", "")}`;
    const db = await createTestDatabase({
      url: localPostgresUrl(url!),
      pgPoolMax: 1,
    });
    const proxy = await commitProxy(url!);
    const proxied = await createTestDatabase({ url: proxy.url, pgPoolMax: 1 });
    try {
      await provisionCopilotzSchema(db, schema);
      const client = createOwnerEffectClient({
        session: proxied,
        schema,
        namespace: "space",
        actionRunId: "commit-loss",
      });
      await client.inspect("dispatch");
      proxy.arm();
      const begun = client.begin("dispatch");
      const rejected = assertRejects(() => begun);
      await bounded(proxy.forwarded, "COMMIT forwarded");
      assertEquals(await bounded(proxy.resolved, "server COMMIT"), "COMMIT");
      proxy.cutClient();
      const error = await bounded(rejected, "owner rejected uncertain commit");
      assertEquals((error as { code?: string }).code, "owner_commit_unknown");
      const next = createOwnerEffectClient({
        session: db,
        schema,
        namespace: "space",
        actionRunId: "commit-loss",
      });
      assertEquals(await next.begin("dispatch"), { status: "indeterminate" });
      assertEquals(proxy.evidence.includes("server COMMIT"), true);
      assertEquals(proxy.errors, []);
    } finally {
      await proxied.close();
      await proxy.close();
      await db.close();
    }
  },
});

Deno.test({
  name:
    "PostgreSQL owner subprocess death after begin retains no-blind-replay evidence",
  ignore: !url,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const schema = `effect_kill_${crypto.randomUUID().replaceAll("-", "")}`;
    const db = await createTestDatabase({
      url: localPostgresUrl(url!),
      pgPoolMax: 1,
    });
    let child: Deno.ChildProcess | undefined;
    try {
      await provisionCopilotzSchema(db, schema);
      child = new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "-A",
          new URL("../testing/effect-owner-child.ts", import.meta.url).pathname,
          url!,
          schema,
        ],
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      const reader = child.stdout.pipeThrough(new TextDecoderStream())
        .getReader();
      let output = "";
      await bounded(
        (async () => {
          while (!output.includes("effect-begun")) {
            const chunk = await reader.read();
            if (chunk.done) {
              throw new Error("child stopped before effect begin");
            }
            output += chunk.value;
          }
        })(),
        "child begin",
      );
      child.kill("SIGKILL");
      await child.status;
      await reader.cancel();
      const next = createOwnerEffectClient({
        session: db,
        schema,
        namespace: "space",
        actionRunId: "subprocess",
      });
      assertEquals(await next.begin("dispatch"), { status: "indeterminate" });
    } finally {
      try {
        child?.kill("SIGKILL");
      } catch { /* already exited */ }
      await child?.status;
      await db.close();
    }
  },
});
