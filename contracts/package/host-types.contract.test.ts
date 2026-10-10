import { assertEquals } from "@std/assert";
import {
  contribution,
  createCopilotz,
  type CreateCopilotzOptions,
  defineAction,
  defineCollection,
  definePlugin,
} from "../../index.ts";
import { serverPlugin } from "../../server/index.ts";

const saveNote = defineAction({
  id: "typed.save",
  execute: (input: { text: string }) => ({ saved: input.text }),
});
const note = defineCollection({
  name: "typed_note",
  schema: {
    type: "object",
    properties: {
      text: { type: "string" },
      body: { type: "array", items: { type: "string" } },
    },
    required: ["text", "body"],
    additionalProperties: false,
  } as const,
});
const dependency = definePlugin({
  id: "typed.dependency",
  version: "1",
  actions: { saveNote },
  collections: { note },
});
const plugin = definePlugin({
  id: "typed.parent",
  version: "1",
  plugins: [dependency],
});
const contributed = {
  [contribution]() {
    return {
      value: {},
      plugins: [] as const,
      actions: {
        contributed: defineAction({
          id: "typed.contributed",
          execute: (input: number) => input + 1,
        }),
      },
    };
  },
};

// Compile-time contract; invalid calls are never executed.
async function hostTypes() {
  const app = await createCopilotz({
    plugins: [plugin, serverPlugin],
    actions: {
      direct: defineAction({
        id: "typed.direct",
        execute: (input: boolean) => !input,
      }),
    },
    resources: { test: { contributed } },
  });
  const saved: string = (await app.actions.saveNote({ text: "typed" })).saved;
  const direct: boolean = await app.actions.direct(true);
  const count: number = await app.actions.contributed(1);
  const created = await app.collections.note.create({ text: saved, body: [] });
  const id: string = created.id;
  const text: string = created.text;
  const read: string | undefined = (await app.collections.note.get({ id }))
    ?.text;
  const listed: string = (await app.collections.note.list())[0].text;
  const body: readonly string[] =
    (await app.collections.note.get({ id }))!.body;
  const resolved = await app.collections.note.get({ id }, {
    namespace: "other",
    content: { fields: ["body"] },
  });
  const resolvedBody: readonly { assetId: string }[] = resolved!.body;
  // @ts-expect-error Action output stays typed.
  const wrongOutput: number = (await app.actions.saveNote({ text })).saved;
  // @ts-expect-error Action input stays typed through plugin dependencies.
  await app.actions.saveNote({ text: 1 });
  // @ts-expect-error Direct Action input stays typed.
  await app.actions.direct("wrong");
  // @ts-expect-error Contribution Action input stays typed.
  await app.actions.contributed("wrong");
  // @ts-expect-error Unknown aliases are not added to a static composition.
  await app.actions.absent({});
  // @ts-expect-error Internal aliases stay out of the host surface.
  await app.actions.serverInvoke({});
  // @ts-expect-error Unknown Collection aliases are not added.
  await app.collections.absent.list();
  // @ts-expect-error Collection insert input stays typed.
  await app.collections.note.create({ text: 1, body: [] });
  // @ts-expect-error Required Collection fields stay required.
  await app.collections.note.create({ text });
  // @ts-expect-error Collection updates preserve field types.
  await app.collections.note.update({ id, set: { text: 1 } });
  await app.collections.note.create({ text, body: [] }, {
    // @ts-expect-error Host mutations use idempotencyKey.
    operationKey: "wrong",
  });
  // @ts-expect-error Host Action calls use idempotencyKey.
  await app.actions.saveNote({ text }, { operationKey: "wrong" });
  // @ts-expect-error Read calls do not admit operations.
  await app.collections.note.list({}, { idempotencyKey: "wrong" });
  const gateway = await createCopilotz({ role: "gateway", plugins: [plugin] });
  const remote: string = (await gateway.actions.saveNote({ text })).saved;
  const remoteText: string = (await gateway.collections.note.list())[0].text;
  const worker = await createCopilotz({
    role: "worker",
    plugins: [plugin],
    id: "typed-worker",
    transport: { type: "in-process", config: { topic: "typed" } },
  });
  // @ts-expect-error Workers have no Action ingress.
  worker.actions;
  // @ts-expect-error Workers have no Collection API.
  worker.collections;
  const empty = await createCopilotz();
  // @ts-expect-error Empty compositions have no caller aliases.
  empty.actions.saveNote;
  const options: CreateCopilotzOptions = { plugins: [plugin] };
  const dynamic = await createCopilotz(options);
  await dynamic.collections.anyAlias.create({ dynamic: true });
  await dynamic.actions.anyAlias({ dynamic: true });
  return {
    direct,
    count,
    read,
    listed,
    body,
    resolvedBody,
    wrongOutput,
    remote,
    remoteText,
  };
}

Deno.test("host composition type contracts compile", () => {
  assertEquals(typeof hostTypes, "function");
});
