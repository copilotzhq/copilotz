import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import process from "node:process";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCoreSchemaStatements } from "../events/schema.ts";
import type { SqlExecutor } from "../events/session.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import { provisionOwnerCommandSchema } from "./schema.ts";
import {
  bounded,
  caller,
  command,
  commitProxy,
  deferred,
  localPostgresUrl,
  mixedCommands,
  ownerFixture,
  until,
} from "../testing/owner-postgres-fixture.ts";

const url = process.env.COPILOTZ_TEST_POSTGRES_URL?.trim();
const code = (expected: string) => (error: unknown) =>
  (error as { code?: string })?.code === expected;

test("PostgreSQL savepoint rollback retains the pinned outer transaction", {
  skip: !url,
}, async () => {
  const db = await createTestDatabase({
    url: localPostgresUrl(url!),
    pgPoolMax: 1,
  });
  try {
    await db.transaction(async (tx) => {
      const before = (await tx.query(
        "SELECT pg_backend_pid() AS pid, pg_current_xact_id()::text AS xid",
      )).rows[0];
      await tx.query("SAVEPOINT command_failure");
      await tx.query("ROLLBACK TO SAVEPOINT command_failure");
      await tx.query("RELEASE SAVEPOINT command_failure");
      const after = (await tx.query(
        "SELECT pg_backend_pid() AS pid, pg_current_xact_id()::text AS xid",
      )).rows[0];
      assert.deepEqual(after, before);
    });
  } finally {
    await db.close();
  }
});

async function snapshot(db: SqlExecutor, schema: string) {
  const rows = async (table: string, selection: string, order: string) =>
    (await db.query(
      `SELECT ${selection} FROM "${schema}".${table} ORDER BY ${order}`,
    )).rows;
  return {
    nodes: await rows("nodes", "id,data->>'title' AS title", "id"),
    receipts: await rows("owner_receipts", "key", "key"),
    alarms: await rows("owner_alarms", "name", "name"),
    events: await rows("events", "subject_id,seq::text", "seq"),
    bodies:
      (await rows("event_bodies", "event_body_id", "event_body_id")).length,
    deliveries: (await rows("event_deliveries", "id", "id")).length,
    head: String(
      (await db.query(`SELECT last_seq FROM "${schema}".owner_epochs`)).rows[0]
        .last_seq,
    ),
  };
}

function expectedSnapshot(ids: string[]) {
  return {
    nodes: [...ids].sort().map((id) => ({ id, title: id })),
    receipts: [...ids].sort().map((key) => ({ key })),
    alarms: [...ids].sort().map((name) => ({ name })),
    events: ids.map((subject_id, index) => ({
      subject_id,
      seq: String(index + 1),
    })),
    bodies: ids.length,
    deliveries: ids.length,
    head: String(ids.length),
  };
}

function startOwner(url: string, schema: string) {
  const path = fileURLToPath(
    new URL("../testing/owner-postgres-child.ts", import.meta.url),
  );
  // Explicit fixture source maps must also apply in the owner subprocess.
  const config = process.env.COPILOTZ_TEST_DENO_CONFIG ??
    fileURLToPath(new URL("../../deno.json", import.meta.url));
  const args = process.versions.deno
    ? ["run", "--allow-all", "--config", config, path, url, schema]
    : [...process.execArgv, path, url, schema];
  const child = spawn(process.execPath, args, {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const messages: Record<string, unknown>[] = [];
  let stderr = "";
  child.stderr.on("data", (data) => stderr += data.toString());
  const input = createInterface({ input: child.stdout });
  input.on("line", (line) => {
    if (line.startsWith("OWNER_FIXTURE ")) {
      messages.push(JSON.parse(line.slice(14)));
    }
  });
  const exit = new Promise<{ code: number | null; signal: string | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    },
  );
  return {
    child,
    messages,
    exit,
    send(message: string) {
      child.stdin.write(`${message}\n`);
    },
    async wait(type: string) {
      return await until(() => {
        const found = messages.find((message) => message.type === type);
        if (found) return found;
        assert.equal(
          child.exitCode,
          null,
          `Owner exited before ${type}: ${stderr}`,
        );
        return undefined;
      }, `owner ${type}: ${stderr}`);
    },
    async close() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await bounded(exit, "owner process exit");
      input.close();
    },
  };
}

/** The test-only deferred constraint trigger pauses PostgreSQL *inside COMMIT*,
 * after all command savepoints were released. The client path is broken before
 * the gate resolves, while the proxy retains its PostgreSQL socket. Nothing
 * injects an exception after a known commit. Both server outcomes are witnessed.
 * Acquisition gating is covered here; full host readiness/reconciliation is not. */
for (const loss of ["connection loss", "owner process death"] as const) {
  for (const committed of [true, false]) {
    test(
      `PostgreSQL ${loss} during mixed-group COMMIT: ${
        committed ? "committed" : "aborted"
      } receipt recovery`,
      { skip: !url },
      async () => {
        const schema = `owner_commit_${
          crypto.randomUUID().replaceAll("-", "")
        }`;
        const direct = localPostgresUrl(url!);
        const db = await createTestDatabase({ url: direct, pgPoolMax: 1 });
        const control = await createTestDatabase({ url: direct, pgPoolMax: 1 });
        const proxy = await commitProxy(direct);
        const release = deferred();
        let gate: Promise<void> | undefined;
        let child: ReturnType<typeof startOwner> | undefined;
        let successor: Awaited<ReturnType<typeof ownerFixture>> | undefined;
        let acquisition: Promise<number> | undefined;
        const outputs: Record<string, unknown>[] = [];
        try {
          for (const sql of createCoreSchemaStatements(schema)) {
            await db.query(sql);
          }
          await provisionOwnerCommandSchema(db, schema);
          child = startOwner(proxy.url, schema);
          await child.wait("ready");
          assert.deepEqual(
            await snapshot(db, schema),
            expectedSnapshot(["existing"]),
          );

          // Confined to this disposable schema. No runtime schema/source changes.
          await db.query(
            `CREATE FUNCTION "${schema}".pause_commit() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN PERFORM pg_advisory_xact_lock(hashtext(TG_TABLE_SCHEMA), 57219); RETURN NEW; END $$`,
          );
          await db.query(
            `CREATE CONSTRAINT TRIGGER test_commit_gate AFTER INSERT ON "${schema}".owner_receipts
          DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "${schema}".pause_commit()`,
          );
          const locked = deferred<number>();
          gate = control.transaction(async (tx) => {
            await tx.query(
              "SELECT pg_advisory_xact_lock(hashtext($1), 57219)",
              [schema],
            );
            const pid = Number(
              (await tx.query("SELECT pg_backend_pid() AS pid")).rows[0].pid,
            );
            locked.resolve(pid);
            await release.promise;
          });
          const gatePid = await bounded(
            locked.promise,
            "COMMIT gate acquisition",
          );
          const seedMessages = child.messages.length;
          proxy.arm();
          child.send("group");
          const oldPid = await bounded(
            proxy.forwarded,
            "actual frontend COMMIT forwarding",
          );
          const oldActivity = async () =>
            (await db.query<{
              pid: number;
              xid: string;
              query: string;
              wait_event_type: string;
              wait_event: string;
              blockers: number[];
            }>(
              `SELECT pid,backend_xid::text AS xid,query,wait_event_type,wait_event,pg_blocking_pids(pid) AS blockers
           FROM pg_stat_activity WHERE pid=$1`,
              [oldPid],
            )).rows[0];
          const committing = await until(async () => {
            const row = await oldActivity();
            return row && /^COMMIT\b/i.test(row.query) &&
                row.wait_event_type === "Lock" &&
                row.wait_event === "advisory" && row.blockers.includes(gatePid)
              ? row
              : undefined;
          }, "server executing COMMIT, blocked in deferred trigger");
          assert.ok(committing.xid, "The old transaction must still exist");

          successor = await ownerFixture(
            direct,
            schema,
            "successor",
            (event) => outputs.push(event),
          );
          let acquired = false;
          acquisition = successor.owner.acquire(1).then((epoch) => {
            acquired = true;
            return epoch;
          });
          // Acquisition may wait at its initial INSERT conflict probe before the
          // epoch UPDATE. Both must wait on the exact old transaction, not a timer.
          let observedWait = "";
          const waiting = await until(
            async () => {
              const rows = (await db.query<
                { pid: number; blockers: number[]; query: string }
              >(
                `SELECT pid,query,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity
             WHERE application_name=$1 AND wait_event_type='Lock'`,
                [`${schema}_successor`],
              )).rows;
              const currentWait = JSON.stringify(rows);
              if (rows.length && currentWait !== observedWait) {
                observedWait = currentWait;
                console.log(
                  JSON.stringify({
                    phase: "successor-fence-wait",
                    oldPid,
                    oldXid: committing.xid,
                    rows,
                  }),
                );
              }
              return rows.find((row) =>
                (row.query.startsWith(
                      `INSERT INTO "${schema}"."owner_epochs"`,
                    ) &&
                    row.query.includes("ON CONFLICT(owner) DO NOTHING") ||
                  row.query.startsWith(
                    `UPDATE "${schema}"."owner_epochs" SET epoch=epoch+1`,
                  )) &&
                row.blockers.includes(oldPid)
              );
            },
            "successor owner acquisition blocked behind uncertain owner transaction",
          );
          const locks = (await db.query<{ xid: string }>(
            "SELECT transactionid::text AS xid FROM pg_locks WHERE pid=$1 AND NOT granted AND locktype='transactionid'",
            [waiting.pid],
          )).rows;
          assert.ok(locks.some((lock) => lock.xid === committing.xid));
          assert.equal(acquired, false);
          assert.equal(successor.owner.state, "unacquired");
          assert.deepEqual(
            await snapshot(db, schema),
            expectedSnapshot(["existing"]),
          );
          assert.deepEqual(
            child.messages.slice(seedMessages).filter((m) =>
              ["result", "published", "dispatched"].includes(String(m.type))
            ),
            [],
          );
          assert.deepEqual(
            child.messages.slice(seedMessages).filter((m) =>
              m.type === "handler"
            ).map((m) => m.key),
            ["new", "failed"],
          );

          if (loss === "connection loss") {
            proxy.cutClient();
            const settled = await child.wait("settled");
            assert.equal(settled.state, "stopped");
            const results = child.messages.filter((m) => m.type === "result");
            assert.equal(results.length, 4);
            assert.ok(
              results.every((m) =>
                m.status === "rejected" &&
                ["owner_commit_unknown", "persistence_indeterminate"].includes(
                  String(m.code),
                )
              ),
            );
          } else {
            assert.equal(child.child.kill("SIGKILL"), true);
            assert.equal(
              (await bounded(
                child.exit,
                "actual owner process death during COMMIT",
              )).signal,
              "SIGKILL",
            );
            await until(
              () =>
                proxy.evidence.includes("client transport closed")
                  ? true
                  : undefined,
              "dead owner transport closure",
            );
          }
          // Recheck after the actual transport loss/process death: outcome still unresolved.
          const afterLoss = await oldActivity();
          assert.equal(afterLoss.xid, committing.xid);
          assert.match(afterLoss.query, /^COMMIT\b/i);
          assert.equal(afterLoss.wait_event, "advisory");
          assert.ok(afterLoss.blockers.includes(gatePid));
          assert.equal(acquired, false);
          assert.deepEqual(
            await snapshot(db, schema),
            expectedSnapshot(["existing"]),
          );
          assert.equal(
            child.messages.filter((m) => m.type === "published").length,
            1,
          );
          assert.equal(
            child.messages.filter((m) => m.type === "dispatched").length,
            1,
          );

          if (committed) {
            release.resolve();
            await gate;
            assert.equal(
              await bounded(
                proxy.resolved,
                "server COMMIT resolution after client loss",
              ),
              "COMMIT",
            );
          } else {
            // This backend is still *inside COMMIT*, as witnessed immediately above.
            const killed = await db.query(
              "SELECT pg_terminate_backend($1) AS killed",
              [oldPid],
            );
            assert.equal(killed.rows[0].killed, true);
            await bounded(
              proxy.resolved,
              "server abort after termination inside COMMIT",
            );
            release.resolve();
            await gate;
          }
          assert.equal(
            await bounded(
              acquisition,
              "successor acquisition after outcome resolution",
            ),
            2,
          );
          assert.equal(successor.owner.state, "acquired");
          assert.deepEqual(
            await snapshot(db, schema),
            expectedSnapshot(committed ? ["existing", "new"] : ["existing"]),
          );
          assert.equal(outputs.length, 0);
          const read = (key: string) =>
            successor!.owner.readReceipt(caller(1), { domain: "logical", key });
          assert.ok(
            await read("existing"),
            "Authenticated old-epoch receipt reads survive takeover",
          );
          const newReceipt = await read("new");
          assert.equal(!!newReceipt, committed);
          assert.equal(await read("failed"), undefined);
          const commands = mixedCommands();
          assert.equal(
            (await successor.owner.execute(caller(2), commands[0])).status,
            "duplicate",
          );
          await assert.rejects(
            successor.owner.execute(caller(2), commands[1]),
            code("owner_intent_conflict"),
          );
          const recovered = await successor.owner.execute(
            caller(2),
            commands[2],
          );
          assert.equal(recovered.status, committed ? "duplicate" : "committed");
          if (newReceipt) assert.deepEqual(recovered.result, newReceipt.result);
          assert.equal(
            (await successor.owner.execute(caller(2), commands[3])).status,
            "committed",
          );
          for (const item of [commands[0], commands[2], commands[3]]) {
            assert.equal(
              (await successor.owner.execute(caller(2), item)).status,
              "duplicate",
            );
          }
          await until(
            () =>
              outputs.filter((m) => m.type === "dispatched").length ===
                  (committed ? 1 : 2)
                ? true
                : undefined,
            "only replayed commands publish",
          );
          assert.deepEqual(
            outputs.filter((m) => m.type === "handler").map((m) => m.key),
            committed ? ["failed"] : ["new", "failed"],
          );
          assert.equal(
            outputs.filter((m) => m.type === "published").length,
            committed ? 1 : 2,
          );
          assert.deepEqual(
            await snapshot(db, schema),
            expectedSnapshot(["existing", "new", "failed"]),
          );
          await assert.rejects(
            successor.owner.execute(caller(1), command("stale")),
            code("ActionOwnershipLost"),
          );
          if (loss === "connection loss") {
            child.send("probe");
            assert.equal((await child.wait("probe")).accepted, false);
            assert.equal(
              child.messages.filter((m) => m.type === "published").length,
              1,
            );
          }
          assert.deepEqual(proxy.errors, []);
          console.log(
            JSON.stringify({
              fault: loss,
              outcome: committed ? "committed" : "aborted",
              oldPid,
              oldXid: committing.xid,
              successorPid: waiting.pid,
              fenceWaitProved: true,
              protocol: proxy.evidence,
            }),
          );
        } finally {
          release.resolve();
          await child?.close();
          await proxy.close();
          await gate?.catch(() => {});
          await acquisition?.catch(() => {});
          await successor?.close();
          await control.close();
          await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
          await db.close();
        }
      },
    );
  }
}
