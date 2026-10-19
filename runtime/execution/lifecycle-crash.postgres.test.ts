import { assert, assertEquals } from "@std/assert";
import { createTestDatabase } from "../testing/ominipg.ts";
import { createCoreTableNames } from "../events/schema.ts";
async function until<T>(
  read: () => T | undefined | Promise<T | undefined>,
  label: string,
  timeout: number,
): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out: ${label}`);
}

const url = Deno.env.get("COPILOTZ_TEST_POSTGRES_URL");
function start(schema: string, cut: string, recovery = false) {
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "--config",
      new URL("../../deno.json", import.meta.url).pathname,
      new URL("../testing/fixtures/lifecycle-crash-worker.ts", import.meta.url)
        .pathname,
      url!,
      schema,
      cut,
      ...(recovery ? ["recover"] : []),
    ],
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const messages: string[] = [];
  let errors = "", exited = false;
  const status = child.status.then((value) => {
    exited = true;
    return value;
  });
  const stdout = (async () => {
    let pending = "";
    for await (
      const chunk of child.stdout.pipeThrough(new TextDecoderStream())
    ) {
      pending += chunk;
      while (pending.includes("\n")) {
        const index = pending.indexOf("\n");
        const line = pending.slice(0, index);
        pending = pending.slice(index + 1);
        if (line.startsWith("LIFECYCLE ")) messages.push(line.slice(10));
      }
    }
  })();
  const stderr = (async () => {
    for await (
      const chunk of child.stderr.pipeThrough(new TextDecoderStream())
    ) errors += chunk;
  })();
  return {
    messages,
    wait(message: string) {
      return until(
        () => {
          assert(!exited, `Child exited: ${errors}`);
          return messages.includes(message) || undefined;
        },
        message,
        120_000,
      );
    },
    async kill() {
      if (!exited) child.kill("SIGKILL");
      await status;
      await Promise.all([stdout, stderr]);
    },
  };
}

for (const cut of ["claim", "terminal", "stream-terminal"]) {
  Deno.test({
    name:
      `process death after ${cut} converges lifecycle, delivery, sequence, alarms and receipts`,
    ignore: !url,
    async fn() {
      const db = await createTestDatabase({ url: url!, pgPoolMax: 1 });
      const schema = `lifecycle_crash_${
        crypto.randomUUID().replaceAll("-", "")
      }`;
      const children: ReturnType<typeof start>[] = [];
      const tables = createCoreTableNames(schema);
      const state = async () => ({
        events: (await db.query(
          `SELECT type,seq::text,deduplication_id FROM ${tables.events} ORDER BY seq`,
        )).rows,
        deliveries: (await db.query(
          `SELECT status,attempts FROM ${tables.event_deliveries}`,
        )).rows,
        open: (await db.query(
          `SELECT state FROM ${tables.open_actions} WHERE state IN ('invoked','awaiting')`,
        )).rows,
        receipts: (await db.query(
          `SELECT kind,intent,result FROM ${tables.owner_receipts} ORDER BY key`,
        )).rows,
        deadlines: (await db.query(
          `SELECT source,key FROM ${tables.owner_deadlines} WHERE source='deliveries'`,
        )).rows,
        operations:
          (await db.query(`SELECT state FROM "${schema}".copilotz_operations`))
            .rows,
        alarms:
          (await db.query(`SELECT due_at FROM ${tables.owner_alarms}`)).rows,
        nextDeadline: (await db.query(
          `SELECT MIN(due_at) AS due_at FROM ${tables.owner_deadlines}`,
        )).rows[0].due_at,
        head: Number(
          (await db.query(`SELECT last_seq FROM ${tables.owner_epochs}`))
            .rows[0].last_seq,
        ),
      });
      try {
        const first = start(schema, cut);
        children.push(first);
        await first.wait(`cut:${cut}`);
        await first.kill();
        const interrupted = await state();
        assertEquals(interrupted.deliveries.map((d) => d.status), ["leased"]);
        assertEquals(
          interrupted.events.filter((e) =>
            e.type === "fixture.effect.completed"
          ).length,
          cut !== "claim" ? 1 : 0,
        );
        const second = start(schema, cut, true);
        children.push(second);
        await second.wait(cut === "stream-terminal" ? "ready" : "handled");
        await until(
          async () => {
            const current = await state();
            return current.deliveries.every((d) => d.status === "succeeded") &&
                current.deadlines.length === 0 &&
                current.operations.every((o) => o.state === "completed") &&
                current.alarms.every((a) =>
                  String(a.due_at) === String(current.nextDeadline)
                )
              ? current
              : undefined;
          },
          "recovered delivery",
          120_000,
        );
        const recovered = await state();
        assertEquals(
          recovered.events.filter((e) => e.type === "fixture.effect.invoked")
            .length,
          1,
        );
        assertEquals(
          recovered.events.filter((e) => e.type === "fixture.effect.completed")
            .length,
          1,
        );
        assertEquals(recovered.deliveries.map((d) => d.status), ["succeeded"]);
        assert(recovered.deliveries.every((d) => Number(d.attempts) <= 2));
        assertEquals(recovered.open, []);
        assertEquals(recovered.deadlines, []);
        assertEquals(
          recovered.alarms.map((a) => a.due_at),
          recovered.nextDeadline == null ? [] : [recovered.nextDeadline],
        );
        assertEquals(
          recovered.events.map((e) => Number(e.seq)),
          Array.from({ length: recovered.head }, (_, index) => index + 1),
        );
        assert(recovered.receipts.length > 0);
        for (const receipt of interrupted.receipts) {
          assert(
            recovered.receipts.some((r) =>
              JSON.stringify(r) === JSON.stringify(receipt)
            ),
          );
        }
        assertEquals(
          children.flatMap((c) => c.messages).filter((m) => m === "effect")
            .length,
          1,
        );
        await second.kill();
        const third = start(schema, cut, true);
        children.push(third);
        await third.wait("ready");
        const restarted = await state();
        assertEquals(restarted.events, recovered.events);
        assertEquals(restarted.receipts, recovered.receipts);
        assertEquals(restarted.deliveries, recovered.deliveries);
        assertEquals(restarted.open, []);
        assertEquals(restarted.deadlines, []);
        assertEquals(
          children.flatMap((c) => c.messages).filter((m) => m === "effect")
            .length,
          1,
        );
      } finally {
        for (const child of children) await child.kill();
        await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await db.close();
      }
    },
  });
}
