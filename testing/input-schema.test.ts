import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { inputSchemas, schemasFromTypes } from "../cli/input-schema.ts";
import { validator } from "../runtime/mod.ts";
import { productSchema } from "./fixtures/input-schema/contracts.ts";
import { runtime, tempDir, test } from "./mod.ts";

const fixture = (name: string) =>
  fileURLToPath(new URL(`./fixtures/input-schema/${name}.ts`, import.meta.url));
const order = fixture("order.place");
const product = fixture("product.edit");

type Results = Awaited<ReturnType<typeof inputSchemas>>;
function generated(results: Results, file: string) {
  const result = results.get(file);
  assert.ok(result?.schema && typeof result.schema === "object", result?.error);
  return result.schema;
}

test("one program reads the Actions, their imports, descriptions and constraints in a stable order", async () => {
  const explicit = fixture("explicit");
  const empty = fixture("no-parameter");
  const files = [order, product, explicit, empty];
  let programs = 0;
  const results = await inputSchemas(files, {
    ts: {
      ...ts,
      createProgram: new Proxy(ts.createProgram, {
        apply(target, receiver, args) {
          programs++;
          return Reflect.apply(target, receiver, args);
        },
      }),
    },
  });
  assert.equal(programs, 1);
  for (const skipped of [explicit, empty]) {
    assert.ok(results.has(skipped));
    assert.equal(results.get(skipped), undefined);
  }
  // Resolve TypeScript from the app on the second pass, with a different file order.
  const again = await inputSchemas(files.toReversed());
  for (const file of files) {
    assert.equal(JSON.stringify(results.get(file)), JSON.stringify(again.get(file)));
  }

  const schema = generated(results, order);
  assert.equal(schema.description, "An order placed for a customer.");
  assert.deepEqual(schema.required, [
    "approved",
    "customerId",
    "delivery",
    "discount",
    "lines",
    "priority",
  ]);
  assert.equal(schema.additionalProperties, false);
  const fields = schema.properties!;
  assert.deepEqual(Object.keys(fields), Object.keys(fields).sort());
  assert.deepEqual(fields.customerId, {
    type: "string",
    description: "Who placed the order.",
    minLength: 2,
    maxLength: 6,
    pattern: "^[A-Z]+$",
    examples: ["AC", "WEST"],
  });
  assert.deepEqual(fields.lines, {
    type: "array",
    description: "Each product once.",
    minItems: 1,
    maxItems: 3,
    uniqueItems: true,
    items: {
      type: "object",
      additionalProperties: false,
      required: ["quantity", "sku"],
      properties: {
        name: { type: "string" },
        sku: { ...fields.customerId as object, description: "The customer's account code." },
        quantity: {
          type: "integer",
          description: "Units on this line.",
          minimum: 1,
          maximum: 20,
          default: 1,
        },
      },
    },
  });
  assert.deepEqual(fields.ratio, { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 1 });
  assert.deepEqual(fields.cents, { type: "integer" });
  assert.deepEqual(fields.receipt, { type: "string", format: "email" });
  assert.deepEqual(fields.priority, { enum: [1, 2, 3] });
  assert.deepEqual(fields.prepaid, { const: true });
  assert.deepEqual(fields.status, { enum: ["draft", "sent"] });
  assert.deepEqual(fields.canceled, { type: "null" });
  assert.deepEqual(fields.weights, {
    type: "object",
    properties: {},
    additionalProperties: { type: "number" },
  });

  const p = generated(results, product).properties!;
  assert.deepEqual(p.original, productSchema);
  assert.deepEqual(p.key, {
    ...productSchema,
    properties: { code: productSchema.properties.code },
    required: ["code"],
  });
  const { required: _, ...base } = productSchema;
  assert.deepEqual(p.patch, {
    ...base,
    properties: { price: productSchema.properties.price, note: productSchema.properties.note },
  });
});

test("the runtime's Action input check accepts and refuses the generated shapes", async () => {
  const schema = generated(await inputSchemas([order]), order);
  const check = validator(schema, 'action "order.place" input');
  const line = { sku: "AB", quantity: 1 };
  const sample = {
    customerId: "AC",
    lines: [line],
    delivery: { kind: "collect", location: "west" },
    priority: 2,
    approved: false,
    discount: null,
  };
  check(sample);
  check({
    ...sample,
    discount: 0.5,
    delivery: { kind: "ship", postalCode: "12345" },
    counts: ["red", 1, 2],
    window: ["2026-11-24T12:00:00Z"],
    marker: [],
    reason: "requested",
    weights: { box: 2 },
  });
  for (
    const changes of [
      { extra: true },
      { customerId: "lowercase" },
      { lines: [] },
      { lines: [line, line] },
      { lines: [{ ...line, quantity: 1.5 }] },
      { lines: [{ ...line, quantity: 0 }] },
      { lines: [{ ...line, quantity: 21 }] },
      { lines: [{ ...line, discontinued: true }] },
      { approved: 0 },
      { delivery: { kind: "ship", location: "west" } },
      { delivery: { kind: "collect" } },
      { priority: 5 },
      { weights: { box: "large" } },
      { cents: 2.3 },
      { ratio: 1 },
      { window: [] },
      { window: ["yesterday"] },
      { counts: ["red", "two"] },
      { window: Array(3).fill("2026-11-24T12:00:00Z") },
      { marker: [1] },
      { prepaid: false },
    ]
  ) {
    assert.throws(
      () => check({ ...sample, ...changes }),
      { code: "invalid" },
      JSON.stringify(changes),
    );
  }
  const { customerId: _, ...missing } = sample;
  assert.throws(() => check(missing), { code: "invalid" });
});

test("a type the generator cannot represent names its Action, property and reason", async () => {
  const dir = tempDir();
  const cases = [
    ["() => void", "functions"],
    ["symbol", "symbol"],
    ["bigint", "bigint"],
    ["T", "generic"],
    ["Partial<T>", "generic"],
    ["{ [K in keyof T]: number }", "generic"],
    ["any", "any"],
    ["unknown", "unknown"],
    ["Product<number>", "class instance"],
    ["Date", "class instance"],
    ["Recursive", "recursive"],
    ["never", "never"],
    ["undefined", "undefined"],
    ["Record<number, string>", "index signatures"],
  ];
  const files = cases.map(([type], i) => {
    const path = join(dir, `action-${i}.ts`);
    writeFileSync(
      path,
      `class Product<T> { code!: T; } class Date {} interface Recursive { next: Recursive }
      export default {run<T>(_ctx: unknown, _input: {lines: {field: ${type}}[]}) {}};`,
    );
    return path;
  });
  const results = await inputSchemas(files, { ts });
  for (const [i, file] of files.entries()) {
    const message = results.get(file)?.error ?? "";
    for (
      const part of [
        file,
        "input.lines[].field",
        cases[i][1],
        "write `input` by hand for this Action",
      ]
    ) {
      assert.ok(message.includes(part), message);
    }
  }
});

test("Date names the JSON string annotation for Action inputs and collection fields", async () => {
  const dir = tempDir();
  const action = join(dir, "order.place.ts");
  const collection = join(dir, "order.ts");
  writeFileSync(action, "export default { run(_ctx: unknown, input: { at: Date }) {} }");
  writeFileSync(
    collection,
    "interface Order { at: Date }; export default defineCollection<Order>({})",
  );
  const results = await schemasFromTypes([{ file: action, kind: "actions" }, {
    file: collection,
    kind: "collections",
  }], { ts });
  for (const [file, path] of [[action, "input.at"], [collection, "schema.at"]]) {
    const error = results.get(file)?.error ?? "";
    assert.ok(error.includes(file) && error.includes(path), error);
    assert.ok(error.includes("use `string` with `/** @format date-time */`"), error);
  }
});

test("collections keep nested ids, omit the runtime id, and respect explicit declarations", async () => {
  const dir = tempDir();
  const collection = join(dir, "order.ts");
  const explicit = join(dir, "product.ts");
  const action = join(dir, "order.place.ts");
  writeFileSync(
    collection,
    `type Order = { _id: string; line: { _id: number } };
    export default defineCollection<Order>({});`,
  );
  writeFileSync(
    explicit,
    "export default defineCollection<{ at: Date }>({ schema: { type: 'object' } })",
  );
  writeFileSync(
    action,
    "export default { input: {type: 'object'}, run(_ctx: unknown, date: Date) {} }",
  );
  const results = await schemasFromTypes([{ file: collection, kind: "collections" }, {
    file: explicit,
    kind: "collections",
  }, { file: action, kind: "actions" }], { ts });
  const schema = generated(results, collection);
  assert.deepEqual(schema.required, ["line"]);
  assert.deepEqual(Object.keys(schema.properties!), ["line"]);
  assert.deepEqual(schema.properties!.line, {
    type: "object",
    properties: { _id: { type: "number" } },
    required: ["_id"],
    additionalProperties: false,
  });
  assert.equal(results.get(explicit), undefined);
  assert.equal(results.get(action), undefined);
});

test("a supplied tsconfig resolves app path aliases and preserves nullable types", async () => {
  const dir = tempDir();
  const config = join(dir, "tsconfig.app.json");
  writeFileSync(
    config,
    JSON.stringify({ compilerOptions: { paths: { "app/*": ["./*"] }, strictNullChecks: false } }),
  );
  writeFileSync(join(dir, "customer.ts"), "export interface Customer { name: string | null }");
  const file = join(dir, "order.ts");
  writeFileSync(
    file,
    'import type { Customer } from "app/customer"; export default {run(_ctx: unknown, input: Customer) {}}',
  );
  const schema = generated(await inputSchemas([file], { ts, tsconfig: config }), file);
  const check = validator(schema, "customer");
  check({ name: null });
  check({ name: "Ana" });
  assert.throws(() => check({ name: 2 }), { code: "invalid" });
});

test("an app missing TypeScript gets its installation instruction", async () => {
  const file = join(tempDir(), "order.ts");
  await assert.rejects(inputSchemas([file]), /typescript as a devDependency of the app/);
});

test({
  name: "Deno resolves the app's compiler from its import map without node_modules",
  ignore: runtime !== "deno",
  async fn() {
    const dir = tempDir();
    writeFileSync(
      join(dir, "deno.jsonc"),
      JSON.stringify({
        imports: {
          typescript: `npm:typescript@${ts.version}`,
          schemaTypes: "npm:@cfworker/json-schema@4.1.1",
        },
        lock: false,
      }),
    );
    const file = join(dir, "order.ts");
    writeFileSync(
      file,
      'import type {SchemaDraft} from "schemaTypes"; export default {run(_ctx: unknown, draft: SchemaDraft) {}}',
    );
    assert.deepEqual(generated(await inputSchemas([file]), file), {
      enum: ["2019-09", "2020-12", "4", "7"],
    });
  },
});

test("an embedded Infer keeps local references rooted at its own schema", async () => {
  const file = join(tempDir(), "mail.ts");
  const define = fileURLToPath(new URL("../runtime/define.ts", import.meta.url)).replaceAll(
    "\\",
    "/",
  );
  writeFileSync(
    file,
    `import type { Infer } from ${JSON.stringify(define)};
    const schema = {
      type: "object",
      properties: { text: { $ref: "#/$defs/text" } },
      required: ["text"],
      $defs: { text: { type: "string", minLength: 2 } },
    } as const;
    type Body = Infer<typeof schema>;
    export default { run(_: unknown, input: { body: Body; copies: Body[] }) {} }`,
  );
  const schema = generated(await inputSchemas([file], { ts }), file);
  const check = validator(schema, "mail");
  check({ body: { text: "ok" }, copies: [{ text: "also ok" }] });
  assert.throws(() => check({ body: { text: "x" }, copies: [] }), { code: "invalid" });
  assert.throws(() => check({ body: { text: "ok" }, copies: [{ text: "x" }] }), {
    code: "invalid",
  });
});

test("Deno import-map aliases resolve relative to the map and name missing imports at their site", async () => {
  const dir = tempDir();
  writeFileSync(join(dir, "deno.jsonc"), '{ /* app */ "importMap": "./imports.json" }');
  writeFileSync(
    join(dir, "imports.json"),
    JSON.stringify({ imports: { "app/": "./", "contract": "./customer.ts" } }),
  );
  writeFileSync(join(dir, "customer.ts"), "export type Customer = {name:string}");
  const file = join(dir, "order.ts");
  for (const specifier of ["contract", "app/customer.ts", "app/missing.ts"]) {
    writeFileSync(
      file,
      `import type { Customer } from "${specifier}";\nexport default {run(_: unknown, input: Customer) {}}`,
    );
    const result = await inputSchemas([file], { ts });
    if (specifier.includes("missing")) {
      assert.match(result.get(file)?.error ?? "", /order\.ts:1:\d+.*app\/missing\.ts/);
    } else {
      assert.deepEqual(generated(result, file).properties, { name: { type: "string" } });
    }
  }
  writeFileSync(
    join(dir, "customer.ts"),
    'import type { Name } from "app/missing.ts"; export type Customer = {name: Name};',
  );
  writeFileSync(
    file,
    'import type { Customer } from "contract"; export default {run(_: unknown, input: Customer) {}}',
  );
  assert.match(
    (await inputSchemas([file], { ts })).get(file)?.error ?? "",
    /customer\.ts:1:\d+.*app\/missing\.ts/,
  );
});
