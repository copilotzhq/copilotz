/** Subprocess used only by boundary.postgres.test.ts. */
import process from "node:process";
import { createInterface } from "node:readline";
import {
  caller,
  command,
  mixedCommands,
  ownerFixture,
  until,
} from "./owner-postgres-fixture.ts";

const [url, schema] = process.argv.slice(2);
const messages: Record<string, unknown>[] = [];
function send(message: Record<string, unknown>) {
  messages.push(message);
  process.stdout.write(`OWNER_FIXTURE ${JSON.stringify(message)}\n`);
}
const fixture = await ownerFixture(url, schema, "old", send, true);
await fixture.owner.acquire(0);
await fixture.owner.execute(caller(1), command("existing"));
await until(
  () => messages.some((m) => m.type === "dispatched") ? true : undefined,
  "seed publication",
);
send({ type: "ready", epoch: fixture.owner.epoch });
const input = createInterface({ input: process.stdin });
for await (const line of input) {
  if (line === "group") {
    void Promise.all(
      mixedCommands().map(async (item, index) => {
        try {
          const result = await fixture.owner.execute(caller(1), item);
          send({ type: "result", index, status: result.status });
        } catch (error) {
          send({
            type: "result",
            index,
            status: "rejected",
            code: (error as { code?: string }).code,
          });
        }
      }),
    ).then(() => send({ type: "settled", state: fixture.owner.state }));
  } else if (line === "status") {
    send({ type: "status", state: fixture.owner.state });
  } else if (line === "probe") {
    try {
      await fixture.owner.execute(caller(1), command("stale"));
      send({ type: "probe", accepted: true });
    } catch (error) {
      send({
        type: "probe",
        accepted: false,
        code: (error as { code?: string }).code,
      });
    }
  } else if (line === "stop") {
    await fixture.close();
    input.close();
    break;
  }
}
