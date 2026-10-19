import { assert, assertEquals, assertExists, assertRejects } from "@std/assert";
import {
  createCoreTableNames,
  provisionCopilotzSchema,
} from "../events/index.ts";
import type { SqlExecutor } from "../events/session.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import {
  bounded,
  commitProxy,
  localPostgresUrl,
  until,
} from "../testing/effect-commit-proxy.ts";
import {
  commitFixtureOwner,
  type FixtureNotice,
  fixtureRequest,
} from "../testing/fixtures/owner-commit-worker.ts";

const url = Deno.env.get("COPILOTZ_TEST_POSTGRES_URL");

function startOwner(url: string, schema: string) {
  const config = Deno.env.get("COPILOTZ_TEST_DENO_CONFIG") ??
    new URL("../../deno.json", import.meta.url).pathname;
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "--config",
      config,
      new URL("../testing/fixtures/owner-commit-worker.ts", import.meta.url)
        .pathname,
      url,
      schema,
    ],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const messages: FixtureNotice[] = [];
  let stderr = "";
  const stderrDone = (async () => {
    for await (
      const chunk of child.stderr.pipeThrough(new TextDecoderStream())
    ) stderr += chunk;
  })();
  const stdoutDone = (async () => {
    let pending = "";
    for await (
      const chunk of child.stdout.pipeThrough(new TextDecoderStream())
    ) {
      pending += chunk;
      while (pending.includes("\n")) {
        const end = pending.indexOf("\n");
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        if (line.startsWith("OWNER_COMMIT ")) {
          messages.push(
            JSON.parse(line.slice(13)),
          );
        }
      }
    }
  })();
  const writer = child.stdin.getWriter();
  let exited = false;
  const status = child.status.then((result) => {
    exited = true;
    return result;
  });
  return {
    child,
    messages,
    status,
    send(command: string) {
      return writer.write(new TextEncoder().encode(command + "\n"));
    },
    wait(type: string) {
      return until(() => {
        const found = messages.find((message) => message.type === type);
        if (found) return found;
        assert(!exited, `Owner exited before ${type}: ${stderr}`);
        return undefined;
      }, `owner ${type}`);
    },
    async close() {
      if (!exited) {
        try {
          child.kill("SIGKILL");
        } catch { /* already exited */ }
      }
      await bounded(status, "owner child exit");
      await Promise.all([stdoutDone, stderrDone]);
      try {
        await writer.close();
      } catch { /* lost child pipe */ }
      writer.releaseLock();
    },
  };
}

async function snapshot(db: SqlExecutor, schema: string) {
  const t = createCoreTableNames(schema);
  const read = async (table: string, select: string, order: string) =>
    (await db.query(`SELECT ${select} FROM ${table} ORDER BY ${order}`)).rows;
  return {
    nodes: await read(t.nodes, "id,data", "id"),
    receipts: await read(
      t.owner_receipts,
      "domain,key,principal,kind,intent,result,readers",
      "key",
    ),
    events: await read(t.events, "id,seq::text,subject_id", "seq::bigint"),
    bodies: await read(t.event_bodies, "event_body_id,body", "event_body_id"),
    deliveries: await read(
      t.event_deliveries,
      "id,event_id,consumer_id,status,attempts",
      "event_id",
    ),
    deadlines: await read(
      t.owner_deadlines,
      "source,key,namespace,due_at,payload,revision",
      "source,key",
    ),
    sequence: String(
      (await db.query(`SELECT last_seq FROM ${t.owner_epochs}`)).rows[0]
        .last_seq,
    ),
  };
}

function assertGraph(
  value: Awaited<ReturnType<typeof snapshot>>,
  ids: string[],
) {
  const sorted = [...ids].sort();
  assertEquals(value.nodes, sorted.map((id) => ({ id, data: { value: id } })));
  assertEquals(
    value.receipts,
    sorted.map((id) => ({
      domain: "logical",
      key: id,
      principal: "fixture-worker",
      kind: "write",
      intent: { id, fail: false },
      result: { id },
      readers: ["fixture-worker"],
    })),
  );
  assertEquals(
    value.events,
    ids.map((id, index) => ({
      id: `event:${id}`,
      seq: String(index + 1),
      subject_id: id,
    })),
  );
  assertEquals(
    value.bodies.map((row) => row.event_body_id),
    sorted.map((id) => `body:${id}`),
  );
  assertEquals(
    value.deliveries.map(({ id: _id, ...row }) => row),
    sorted.map((id) => ({
      event_id: `event:${id}`,
      consumer_id: "processor:fixture",
      status: "pending",
      attempts: 0,
    })),
  );
  assertEquals(
    value.deadlines.filter((row) => row.source === "fixture").map((row) =>
      row.key
    ),
    sorted,
  );
  assertEquals(
    value.deadlines.filter((row) => row.source === "deliveries").map((row) =>
      row.key
    ).sort(),
    value.deliveries.map((row) => row.id).sort(),
  );
  assertEquals(value.deadlines.length, ids.length * 2);
  assertEquals(value.sequence, String(ids.length));
}

for (const loss of ["connection loss", "owner process death"] as const) {
  for (const committed of [true, false]) {
    Deno.test({
      name: `PostgreSQL ${loss} during unresolved sole-command COMMIT: ${
        committed ? "committed" : "aborted"
      } exact-fence receipt recovery`,
      ignore: !url,
      sanitizeResources: false,
      sanitizeOps: false,
      async fn() {
        const schema = `uncertain_${crypto.randomUUID().replaceAll("-", "")}`;
        const direct = localPostgresUrl(url!);
        const db = await createTestDatabase({ url: direct, pgPoolMax: 2 });
        const control = await createTestDatabase({ url: direct, pgPoolMax: 1 });
        const successorDb = await createTestDatabase({
          url: localPostgresUrl(direct, `${schema}_successor`),
          pgPoolMax: 1,
        });
        const proxy = await commitProxy(direct);
        const release = Promise.withResolvers<void>();
        let gate: Promise<void> | undefined;
        let child: ReturnType<typeof startOwner> | undefined;
        let successor: ReturnType<typeof commitFixtureOwner> | undefined;
        let acquisition: Promise<number> | undefined;
        const notices: FixtureNotice[] = [];
        try {
          await provisionCopilotzSchema(db, schema);
          child = startOwner(proxy.url, schema);
          await child.wait("ready");
          const seed = await snapshot(db, schema);
          assertGraph(seed, ["existing"]);
          await db.query(
            `CREATE FUNCTION "${schema}".pause_commit() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN PERFORM pg_advisory_xact_lock(hashtext(TG_TABLE_SCHEMA), 57219); RETURN NEW; END $$`,
          );
          await db.query(
            `CREATE CONSTRAINT TRIGGER test_commit_gate AFTER INSERT ON "${schema}".owner_receipts
            DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "${schema}".pause_commit()`,
          );
          const locked = Promise.withResolvers<number>();
          gate = control.transaction(async (tx) => {
            await tx.query("SELECT pg_advisory_xact_lock(hashtext($1),57219)", [
              schema,
            ]);
            locked.resolve(
              Number(
                (await tx.query("SELECT pg_backend_pid() AS pid")).rows[0].pid,
              ),
            );
            await release.promise;
          });
          const gatePid = await bounded(locked.promise, "deferred COMMIT gate");
          const beforeMessages = child.messages.length;
          proxy.arm();
          await child.send("commit");
          const oldPid = await bounded(
            proxy.forwarded,
            "actual COMMIT forwarding",
          );
          const activity = async () =>
            (await db.query<
              {
                pid: number;
                xid: string;
                query: string;
                wait_event_type: string;
                wait_event: string;
                blockers: number[];
              }
            >(
              "SELECT pid,backend_xid::text AS xid,query,wait_event_type,wait_event,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE pid=$1",
              [oldPid],
            )).rows[0];
          const committing = await until(async () => {
            const row = await activity();
            return row && /^COMMIT\b/i.test(row.query) &&
                row.wait_event_type === "Lock" &&
                row.wait_event === "advisory" && row.blockers.includes(gatePid)
              ? row
              : undefined;
          }, "actual backend inside unresolved COMMIT");
          assert(committing.xid);
          successor = commitFixtureOwner(
            successorDb,
            schema,
            "successor",
            (notice) => notices.push(notice),
          );
          let acquired = false;
          acquisition = successor.acquire(1).then((epoch) => {
            acquired = true;
            return epoch;
          });
          void acquisition.catch(() => undefined);
          const waiting = await until(async () => {
            const rows = (await db.query<
              { pid: number; query: string; blockers: number[] }
            >(
              "SELECT pid,query,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'",
              [`${schema}_successor`],
            )).rows;
            return rows.find((row) =>
              row.query.includes("owner_epochs") &&
              /^(?:INSERT|UPDATE|SELECT)/.test(row.query) &&
              row.blockers.includes(oldPid)
            );
          }, "successor blocked on exact predecessor PID");
          const locks = (await db.query<{ xid: string }>(
            "SELECT transactionid::text AS xid FROM pg_locks WHERE pid=$1 AND NOT granted AND locktype='transactionid'",
            [waiting.pid],
          )).rows;
          assert(
            locks.some((row) => row.xid === committing.xid),
            "successor must wait on exact predecessor xid",
          );
          console.log(
            JSON.stringify({
              phase: "unresolved-commit-fence",
              loss,
              committed,
              oldPid,
              oldXid: committing.xid,
              gatePid,
              successorPid: waiting.pid,
              waitingXids: locks.map((row) => row.xid),
            }),
          );
          assertEquals(acquired, false);
          assertEquals(successor.state, "acquiring");
          assertEquals(await snapshot(db, schema), seed);
          assertEquals(
            child.messages.slice(beforeMessages).filter((row) =>
              ["result", "published", "dispatch-callback"].includes(row.type)
            ),
            [],
          );
          assertEquals(
            child.messages.slice(beforeMessages).filter((row) =>
              row.type === "handler"
            ).map((row) => row.id),
            ["new"],
          );
          if (loss === "connection loss") {
            proxy.cutClient();
            const settled = await child.wait("settled");
            assertEquals(settled.state, "stopped");
            assertEquals(settled.statuses, ["rejected", "rejected"]);
            const results = child.messages.slice(beforeMessages).filter((row) =>
              row.type === "result"
            );
            assertEquals(results.length, 2);
            assert(
              results.every((row) =>
                row.status === "rejected" &&
                ["owner_commit_unknown", "persistence_indeterminate"].includes(
                  String(row.code),
                )
              ),
            );
          } else {
            child.child.kill("SIGKILL");
            assertEquals(
              (await bounded(child.status, "SIGKILL owner exit")).signal,
              "SIGKILL",
            );
            await until(
              () =>
                proxy.evidence.includes("client transport closed")
                  ? true
                  : undefined,
              "dead owner transport loss",
            );
          }
          const afterLoss = await activity();
          assertEquals(afterLoss.xid, committing.xid);
          assert(/^COMMIT\b/i.test(afterLoss.query));
          assertEquals(afterLoss.wait_event, "advisory");
          assert(afterLoss.blockers.includes(gatePid));
          assertEquals(acquired, false);
          assertEquals(await snapshot(db, schema), seed);
          assertEquals(
            child.messages.slice(beforeMessages).filter((row) =>
              ["published", "dispatch-callback"].includes(row.type)
            ),
            [],
          );
          if (committed) {
            release.resolve();
            await gate;
            assertEquals(
              await bounded(proxy.resolved, "actual committed resolution"),
              "COMMIT",
            );
          } else {
            assertEquals(
              (await db.query("SELECT pg_terminate_backend($1) AS killed", [
                oldPid,
              ])).rows[0].killed,
              true,
            );
            assertEquals(
              await bounded(proxy.resolved, "actual aborted resolution"),
              "server connection closed",
            );
            release.resolve();
            await gate;
          }
          assertEquals(
            await bounded(acquisition, "successor after physical resolution"),
            2,
          );
          assertEquals(successor.state, "acquired");
          assertGraph(
            await snapshot(db, schema),
            committed ? ["existing", "new"] : ["existing"],
          );
          assertEquals(notices, []);
          const oldCaller = { principal: "fixture-worker", epoch: 1 };
          assertExists(
            await successor.readReceipt(oldCaller, {
              domain: "logical",
              key: "existing",
            }),
          );
          assertEquals(
            Boolean(
              await successor.readReceipt(oldCaller, {
                domain: "logical",
                key: "new",
              }),
            ),
            committed,
          );
          assertEquals(
            await successor.readReceipt(oldCaller, {
              domain: "logical",
              key: "failed",
            }),
            undefined,
          );
          assertEquals(
            await successor.readReceipt(oldCaller, {
              domain: "logical",
              key: "queued",
            }),
            undefined,
          );
          assertEquals(
            await successor.readReceipt(
              { principal: "other-worker", epoch: 2 },
              { domain: "logical", key: "existing" },
            ),
            undefined,
          );
          const caller = { principal: "fixture-worker", epoch: 2 };
          assertEquals(
            await successor.execute(
              "write",
              caller,
              fixtureRequest("existing"),
            ),
            { id: "existing" },
          );
          assertEquals(notices, []);
          assertEquals(
            await successor.execute("write", caller, fixtureRequest("new")),
            { id: "new" },
          );
          if (!committed) {
            await until(
              () =>
                notices.some((row) => row.type === "dispatch-callback")
                  ? true
                  : undefined,
              "recovered publication",
            );
          }
          assertEquals(
            notices.filter((row) => row.type === "handler").map((row) =>
              row.id
            ),
            committed ? [] : ["new"],
          );
          const recovered = await snapshot(db, schema);
          assertGraph(recovered, ["existing", "new"]);
          const noticesBeforeReplay = structuredClone(notices);
          await successor.execute("write", caller, fixtureRequest("new"));
          assertEquals(await snapshot(db, schema), recovered);
          assertEquals(notices, noticesBeforeReplay);
          await assertRejects(
            () =>
              successor!.execute("write", caller, {
                ...fixtureRequest("new"),
                receipt: {
                  identity: { domain: "logical", key: "new" },
                  intent: { id: "changed", fail: false },
                },
              }),
            Error,
            "intent",
          );
          assertEquals(await snapshot(db, schema), recovered);
          assertEquals(proxy.errors, []);
        } finally {
          release.resolve();
          await gate?.catch(() => undefined);
          await proxy.close();
          await child?.close();
          await acquisition?.catch(() => undefined);
          successor?.stop();
          await successorDb.close();
          await control.close();
          await db.query(`DROP SCHEMA "${schema}" CASCADE`);
          await db.close();
        }
      },
    });
  }
}
