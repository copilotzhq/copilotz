import { assertEquals, assertExists } from "@std/assert";
import {
  type ActionCallers,
  type ActionContext,
  type ApplicationOutput,
  createCopilotz,
  defineAction,
  defineCollection,
  definePlugin,
  defineProcessor,
  isStreamOutput,
  type ProcessorContext,
} from "../../index.ts";
import { corePlugin, defineTool } from "../../plugins/core/index.ts";

const note = defineCollection({
  name: "note",
  schema: {
    type: "object",
    properties: {
      id: { type: "string", readOnly: true },
      text: { type: "string" },
    },
    required: ["text"],
  } as const,
});

const saveNote = defineAction({
  id: "notes.save",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string", minLength: 1 } },
    required: ["text"],
    additionalProperties: false,
  } as const,
  execute(input: Readonly<{ text: string }>, context: ActionContext) {
    return context.collections.note.create(
      { text: input.text },
      { operationKey: "save-note" },
    );
  },
});

const saveNoteTool = defineTool("saveNote", saveNote, {
  name: "Save note",
  description: "Save a note for later reference.",
});

type NotesProcessorContext = ProcessorContext<
  ProcessorContext["resources"],
  ProcessorContext["adapters"],
  ActionCallers<{ saveNote: typeof saveNote }>
>;

let savedNote: Readonly<Record<string, unknown>> | undefined;
const saveNoteOnRequest = defineProcessor<NotesProcessorContext>({
  id: "notes.save-on-request",
  on: [{ eventType: "notes.save.requested" }],
  async handle(event, context) {
    savedNote = await context.actions.saveNote(
      event.payload as Readonly<{ text: string }>,
      { operationKey: "save-note-request" },
    ) as Readonly<Record<string, unknown>>;
  },
});

const notesPlugin = definePlugin({
  id: "contract.notes",
  version: "1.0.0",
  collections: { note },
  actions: { saveNote },
  processors: { saveNoteOnRequest },
  resources: { tools: { saveNote: saveNoteTool } },
});

Deno.test("runtime root and core authoring imports compose a reusable plugin", async () => {
  assertEquals(notesPlugin.id, "contract.notes");
  assertEquals(notesPlugin.actions.saveNote.id, "notes.save");
  assertEquals(
    (notesPlugin.resources.tools.saveNote as { action: string }).action,
    "saveNote",
  );
  const toolActionAlias =
    (notesPlugin.resources.tools.saveNote as { action: string })
      .action as keyof typeof notesPlugin.actions;
  assertEquals(notesPlugin.actions[toolActionAlias].id, saveNote.id);
  assertEquals(
    isStreamOutput({ type: "not-a-stream" } as unknown as ApplicationOutput),
    false,
  );

  const app = await createCopilotz({
    namespace: "runtime-entrypoint-contract",
    plugins: [corePlugin, notesPlugin],
  });
  try {
    const send = await app.send({
      type: "notes.save.requested",
      payload: { text: "Keep this note." },
    });
    await send.done;
    assertExists(savedNote);
    assertEquals(savedNote.text, "Keep this note.");
    assertEquals(typeof savedNote.id, "string");
  } finally {
    await app.close();
  }
});
