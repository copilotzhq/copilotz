import { assertEquals } from "@std/assert";
import {
  createCopilotz,
  defineCollection,
  defineProcessor,
} from "../../index.ts";
import { matchesCollectionFilter } from "./predicate.ts";

Deno.test("Collection where binds scalar text consistently with in-memory matching", async () => {
  const item = defineCollection({
    name: "scalar_item",
    schema: {
      type: "object",
      properties: { id: { type: "string" }, value: {} },
      required: ["id"],
    } as const,
  });
  const rows = [
    { id: "true", value: true },
    { id: "false", value: false },
    { id: "number", value: 10 },
    { id: "string", value: "10" },
    { id: "null", value: null },
    { id: "missing" },
  ];
  const cases = [
    [true, ["true"]],
    [false, ["false"]],
    [10, ["number", "string"]],
    ["10", ["number", "string"]],
    [null, []],
  ] as const;
  const verify = defineProcessor({
    id: "scalar.verify",
    on: [{ eventType: "scalar.verify.requested" }],
    async handle(event, context) {
      if (!event.durable) return;
      for (const row of rows) {
        await context.collections.item.create(row, { operationKey: row.id });
      }
      await context.readSnapshot(async ({ collections }) => {
        for (const [value, expected] of cases) {
          const where = { value };
          assertEquals(
            rows.filter((row) => matchesCollectionFilter({ where }, row))
              .map((row) => row.id).sort(),
            [...expected],
          );
          assertEquals(
            (await collections.item.list({ where })).map((row) => row.id)
              .sort(),
            [...expected],
          );
          assertEquals(
            (await collections.item.list({ all: [{ where }] })).map((row) =>
              row.id
            ).sort(),
            [...expected],
          );
        }
      });
    },
  });
  const app = await createCopilotz({
    namespace: "scalar-test",
    collections: { item },
    processors: { verify },
  });
  try {
    const handle = await app.send({ type: "scalar.verify.requested" });
    await handle.outputs.cancel();
    await handle.done;
  } finally {
    await app.close();
  }
});
