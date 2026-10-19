import { assertEquals, assertNotStrictEquals } from "@std/assert";
import { createTestDatabase } from "../testing/ominipg.ts";
import { provisionCopilotzSchema } from "../events/schema.ts";
import { createOwnerCommands, createSchemaCommandRunner } from "./commands.ts";
import {
  isOwnerAuthorizationRefusal,
  markOwnerAuthorizationRefusal,
} from "./authorization-refusal.ts";

Deno.test("commands isolate queued input, policy views, result guards, callbacks and receipt replay", async () => {
  const db = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") ?? ":memory:",
  });
  const schema = `isolation_${crypto.randomUUID().replaceAll("-", "")}`;
  await provisionCopilotzSchema(db, schema);
  const published = Promise.withResolvers<void>();
  const source = { nested: { value: "admitted" } };
  const result = { nested: { value: "returned" } };
  let executions = 0;
  const owner = createOwnerCommands<
    { write: { input: typeof source; output: typeof result } }
  >({
    session: db,
    schema,
    handlers: {
      write: {
        authorize(input: typeof source) {
          assertEquals(input, { nested: { value: "admitted" } });
          assertNotStrictEquals(input, source);
          input.nested.value = "policy mutation";
        },
        execute(input: typeof source, context) {
          executions++;
          assertEquals(input, { nested: { value: "admitted" } });
          input.nested.value = "execution mutation";
          context.afterCommit(() => {
            result.nested.value = "callback mutation";
            published.resolve();
          });
          return result;
        },
        authorizeResult(input: typeof source) {
          assertEquals(input, { nested: { value: "admitted" } });
          result.nested.value = "result guard mutation";
        },
      },
    },
  });
  try {
    const epoch = await owner.acquire(0);
    const caller = { principal: "worker", epoch };
    for (const durable of [false, true]) {
      source.nested.value = "admitted";
      result.nested.value = "returned";
      const receipt = durable
        ? {
          identity: { domain: "logical" as const, key: "same" },
          intent: source,
        }
        : undefined;
      const pending = owner.execute("write", caller, {
        input: source,
        receipt,
      });
      source.nested.value = "queued caller mutation";
      const output = await pending;
      await published.promise;
      assertEquals(output, { nested: { value: "returned" } });
      assertNotStrictEquals(output, result);
      output.nested.value = "caller result mutation";
      assertEquals(result.nested.value, "callback mutation");
      if (receipt) {
        source.nested.value = "admitted";
        assertEquals(
          await owner.execute("write", caller, { input: source, receipt }),
          {
            nested: { value: "returned" },
          },
        );
      }
    }
    assertEquals(executions, 2);
    source.nested.value = "before acquisition";
    const run = createSchemaCommandRunner(
      db,
      schema,
      () => Promise.resolve(owner),
    );
    const acquired = run(
      "test.captureBeforeAcquisition",
      source,
      (input) => input,
    );
    source.nested.value = "after submission";
    assertEquals(await acquired, { nested: { value: "before acquisition" } });
    for (const trusted of [false, true]) {
      const original = Object.assign(new Error("refused"), {
        name: "ActionAuthorizationRefused",
        code: "action_authorization_refused",
      });
      if (trusted) markOwnerAuthorizationRefusal(original);
      const detached = await run(
        "test.capturePrivateError",
        {},
        () => original,
      );
      assertNotStrictEquals(detached, original);
      assertEquals(isOwnerAuthorizationRefusal(detached), trusted);
      original.message = "mutated after capture";
      assertEquals(detached.message, "refused");
    }
  } finally {
    owner.stop();
    await db.query(`DROP SCHEMA "${schema}" CASCADE`);
    await db.close();
  }
});
