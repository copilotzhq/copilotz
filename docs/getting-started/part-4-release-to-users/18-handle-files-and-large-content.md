---
title: "Chapter 18: Handle Files and Large Content"
description: "Store a file's bytes once as a scoped Asset referenced by a note, while ingress Events and Action lifecycle Events carry only small metadata and references."
section: Getting Started
order: 180
status: stable
---

# Chapter 18: Handle Files and Large Content

> Part 4 — Release to Users · Track: R · Requires: Chapter 5 · Recommended:
> Chapter 7 · Needs: Deno 2.9+ or Node 24+ (no credential), read access to one
> local file

## The pain

Notes so far hold one short `text` string. Users now want to attach the release
checklist itself, a file that can be far larger than a sentence and is not
always plain text.

The obvious idea is to put the file into the request. This hypothetical excerpt
shows the shape to avoid; it is not a step to run:

```ts
// Hypothetical, do not do this: the whole file becomes part of the stored
// input Event the moment it is admitted.
await app.send({
  type: "notes.capture.requested",
  payload: { text: "Release checklist", body: fileContents },
});
```

Today's Notes would not even save this note: `notes.save` declares
`additionalProperties: false`, so the extra `body` field fails validation. The
damage is already done before that check, though. Copilotz stores every admitted
input as a durable Event exactly as it was sent, so the file's bytes are now
part of history. If you then broadened the Action and Collection schemas to
accept raw bytes, the same bytes would also be copied into the Action's
lifecycle input and output and into the stored record. One upload would become
several stored copies, and every reader that prints or forwards those Events
would carry the file along.

## The problem

Durable Events are the history of the application. They should say _what
happened_ ("a file note was requested from the `release` source"), not hold
every body involved. Large or binary bodies need a different home:

- stored **once**, in the same tenant namespace as the record that owns them;
- referenced from that record by a small, stable pointer;
- written in the same transaction as the record, so a retried write never leaves
  an orphaned body or a record pointing at nothing.

Two tempting shortcuts do not give you that:

- **Declaring content later does not rewrite history.** Adding a content
  declaration to a Collection or an Action changes how _new_ writes are stored.
  An input Event already admitted with a large `payload` keeps that payload.
- **The caller should not choose a file path.** A request that names an
  arbitrary path lets anyone who can send Events read any file the host can.

The bytes must therefore be read where the host decides, _inside_ the operation,
and only after a small request has been admitted.

## The solution

Copilotz stores bodies as **Assets**: immutable, namespace-scoped content
identified by an Asset ID. A record holds a **content reference** to an Asset
(`assetId`, `kind`, `role`, `mediaType`, optional `name`) instead of the bytes.
Three pieces cooperate:

| Piece                                 | Job                                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------------------- |
| `content: { fields: ["body"] }`       | Declares that the Collection's `body` field holds content references.                 |
| `context.content.prepare(input, ...)` | Turns bytes into prepared content: references plus not-yet-stored Asset candidates.   |
| Collection `create`                   | Accepts prepared content, stores the record and adopts its Assets in one transaction. |

The request flow keeps every Event small:

1. The caller sends `notes.file.requested` with `{ text, source: "release" }`.
   `source` is a **logical name**, not a path.
2. A new Processor calls a new Action, `notes.save-file`, with that same small
   input. Its `notes.save-file.invoked` Event records only the text and the
   source name.
3. The Action asks a **host file adapter** to read the source. The adapter maps
   the fixed name `release` to one file, rejects anything else and enforces a
   size limit before returning bytes.
4. The Action prepares the bytes and creates the note. `note.created` and
   `notes.save-file.completed` carry the note with its `body` references, not
   the bytes.

The existing `notes.save` Action, the `notes.capture` Processor and every
text-only caller stay as they are. File notes are a separate, dependent plugin,
so callers that only send text never learn about files.

### Update `notes-plugin.ts`

The `note` Collection gains one optional field, `body`, and declares it as
content. A note without a body is still valid, so text-only records you already
stored, and every text-only caller and test from earlier chapters, keep working.
`NoteRecord` types `body` as a `ContentSequence`: the ordered list of content
references the Collection stores.

This step makes three changes to `notes-plugin.ts`:

1. It imports `contentSequenceSchema`, the public JSON Schema for a list of
   content references, and the `ContentSequence` type.
2. It adds the optional `body` property, validated by `contentSequenceSchema`,
   and the `content` declaration to `note`.
3. It replaces the `NoteRecord` type so `body` is typed as `ContentSequence`.
   This is a TypeScript type only; the schema is what validates stored values.

`saveNote`, `captureNote` and `notesPlugin` are unchanged, including their IDs,
schemas and operation keys. The complete updated file:

```ts
// Helpers that declare a Collection, an Action, a Processor and the Plugin
// that packages them, plus the shared schema for content references. All of
// them come from the portable runtime package.
import {
  contentSequenceSchema,
  defineAction,
  defineCollection,
  definePlugin,
  defineProcessor,
} from "@copilotz/copilotz";
// Types of the contexts that the Action and the Processor receive, of the
// Action callers that the Processor expects, and of stored content references.
import type {
  ActionCallers,
  ActionContext,
  ContentSequence,
  ProcessorContext,
} from "@copilotz/copilotz";

// Application state for captured notes. Every record is checked against this
// schema before it is stored, and every change appends a `note.*` Event.
export const note = defineCollection({
  // Stable name. It prefixes the Event types this Collection appends, such as
  // `note.created`, so keep it once records are stored.
  name: "note",
  // JSON Schema for one stored record. `as const` lets the record types be
  // derived from it.
  schema: {
    type: "object",
    properties: {
      // Record identity. The runtime assigns it when the writer omits it.
      id: { type: "string", readOnly: true },
      // The note itself, as the user captured it.
      text: { type: "string" },
      // Optional attached body, stored as validated content references to
      // Assets rather than as bytes. Text-only notes simply omit it.
      body: contentSequenceSchema,
    },
    // A note without text is rejected before it is stored.
    required: ["text"],
  } as const,
  // Fields that hold content. A write may pass prepared content here; the
  // Collection stores its references and adopts the Assets with the record.
  content: { fields: ["body"] },
});

// Shape of one stored note for TypeScript. `body`, when present, is the
// ordered list of content references, never the bytes themselves.
export type NoteRecord =
  & Omit<typeof note.$inferSelect, "body">
  & { body?: ContentSequence };

// Input that callers pass to `notes.save`. TypeScript checks calls against this
// type; the Action's `inputSchema` enforces the same shape at run time.
export type SaveNoteInput = { text: string };

// Reusable, validated operation that stores one note. It runs only when a
// caller invokes it, and each call records its own lifecycle Events.
export const saveNote = defineAction({
  // Stable identity. Lifecycle Event types are built from it, such as
  // `notes.save.invoked` and `notes.save.completed`, so keep it once Events are
  // stored.
  id: "notes.save",
  // Checked against every call's input before this Action's lifecycle Events
  // or `execute` start. Events recorded earlier stay recorded.
  inputSchema: {
    type: "object",
    properties: {
      // At least one character, so an empty note never reaches the Collection.
      text: { type: "string", minLength: 1 },
    },
    // A call without text is rejected before the Action starts.
    required: ["text"],
    // Reject unexpected fields instead of silently storing or dropping them.
    additionalProperties: false,
  } as const,
  // Runs once the input is accepted. Its return value is the caller's result
  // and the `output` of the `notes.save.completed` Event.
  execute(input: SaveNoteInput, context: ActionContext) {
    // Store the validated note. The Collection appends `note.created` to the
    // caller's operation before this call completes.
    return context.collections.note.create(
      // Only the note's own field. The runtime fills in `id`, `namespace` and
      // the timestamps.
      { text: input.text },
      // Collection keys are scoped to the running delivery, not to this call,
      // so prefix the write with this call's stable identity. Two calls in one
      // delivery make two writes; a retried call resolves to its stored note.
      { operationKey: `${context.operationKey}:save-note` },
    );
  },
});

// The context `captureNote` expects. The third type parameter declares the
// Action callers it uses, so TypeScript checks their input and output. The
// runtime still passes the complete context; this type grants or hides nothing.
type CaptureContext = ProcessorContext<
  // Keep the default resource and adapter types.
  ProcessorContext["resources"],
  ProcessorContext["adapters"],
  // `context.actions.saveNote` calls the `notes.save` Action.
  ActionCallers<{ saveNote: typeof saveNote }>
>;

// Decides when a note is saved: once for every capture request, whoever sent
// it. The `notes.save` Action owns how a note is validated and stored.
export const captureNote = defineProcessor<CaptureContext>({
  // Stable identity recorded on each delivery. Keep it once Events are stored.
  id: "notes.capture",
  // Match every Event of this type, in any namespace this application admits.
  on: [{ eventType: "notes.capture.requested" }],
  // Runs for the delivery the runtime selected for a matching Event, and may
  // run again for the same delivery on retry. Its default `inherit` settlement
  // makes the operation wait for this handler and for the Action it calls.
  async handle(event, context) {
    // Save notes only for stored requests, so every note traces back to a
    // recorded Event and its delivery.
    if (!event.durable) return;
    // Pass the request's resolved payload to the Action unchanged. The cast is
    // for TypeScript only: `notes.save` validates the data against its input
    // schema before it runs. The call resolves to the stored note, which this
    // Processor does not need.
    await context.actions.saveNote(
      event.data as SaveNoteInput,
      // Names this one call within the current delivery. A retried delivery
      // reuses the key and gets the recorded result instead of a second note.
      { operationKey: "save-request" },
    );
  },
});

// The Notes package: everything an application needs to capture and store
// notes, with no namespace, database or entrypoint of its own.
export const notesPlugin = definePlugin({
  // Identifies this package within one composed application. Another plugin
  // object with the same ID is rejected rather than merged.
  id: "@team-notes/notes",
  // Records which release of the package this is.
  version: "1.0.0",
  // Keyed by the alias that Actions and Processors use in
  // `context.collections`. The stored identity is the Collection's `name`.
  collections: { note },
  // Keyed by the alias that callers use in `context.actions`. Lifecycle Events
  // identify the Action by its `id`, `notes.save`.
  actions: { saveNote },
  // Keyed by a local name. Deliveries identify the Processor by its `id`,
  // `notes.capture`.
  processors: { captureNote },
});
```

**If you persist notes (Chapter 7).** Adding an optional field leaves the
text-only notes you already stored valid, and an application with this updated
plugin opens the same database and namespace as before. Nothing rewrites
existing records: they simply have no `body`. Other changes need more care.
Before you make a field required, change other stored schemas or rename a stable
ID, plan and test how existing records and recorded Events will still be read
and replayed; see [Upgrading](../../upgrading.md). The `files.ts` entrypoint
below uses the private in-memory database, so it leaves your Chapter 7 data
alone. If you want a separate persistent experiment, give it its own new
database path.

### Create `notes-files.ts`

`notes-files.ts` is a **definition module**: a pure plugin that depends on
`notesPlugin` and adds file notes. It reads no file and no environment. It
declares only the _shape_ of the file adapter it needs, `NoteFileReader`; the
host supplies the implementation.

The Action splits its two writes by key:

- `context.content.prepare` inside an Action is keyed per call automatically, so
  the plain `"file-body"` key is enough.
- A direct Collection write is keyed per delivery, so the `create` key is
  prefixed with `context.operationKey`, exactly as `notes.save` does.

```ts
// Helpers that declare an Action, a Processor and the Plugin that packages
// them, from the portable runtime package.
import {
  defineAction,
  definePlugin,
  defineProcessor,
} from "@copilotz/copilotz";
// Types of the contexts the Action and Processor receive, and of the Action
// callers the Processor expects.
import type {
  ActionCallers,
  ActionContext,
  ProcessorContext,
} from "@copilotz/copilotz";
// The Notes package this plugin builds on, and the stored note type.
import { notesPlugin } from "./notes-plugin.ts";
import type { NoteRecord } from "./notes-plugin.ts";

// What a host file adapter returns for one logical source: bounded bytes and
// the metadata stored with the Asset.
export type NoteFile = {
  bytes: Uint8Array;
  mediaType: string;
  name: string;
};

// The adapter contract. The host decides which logical sources exist, where
// their bytes come from and how large they may be; unknown sources must throw.
export type NoteFileReader = {
  read(source: string): Promise<NoteFile>;
};

// Small input recorded on `notes.save-file.invoked`: the note text and a
// logical source name. Never a path, never the bytes.
export type SaveFileNoteInput = { text: string; source: string };

// The adapter namespace this Action reads: `context.adapters.notesFiles.reader`.
type FileNoteAdapters = { notesFiles: { reader: NoteFileReader } };

// Stores one note whose body is a file read by the host inside this call.
export const saveFileNote = defineAction({
  // Stable identity for lifecycle Events such as `notes.save-file.completed`.
  id: "notes.save-file",
  inputSchema: {
    type: "object",
    properties: {
      // Same rule as `notes.save`: no empty notes.
      text: { type: "string", minLength: 1 },
      // A short logical name. The host adapter decides whether it exists.
      source: { type: "string", minLength: 1, maxLength: 64 },
    },
    required: ["text", "source"],
    additionalProperties: false,
  } as const,
  async execute(
    input: SaveFileNoteInput,
    context: ActionContext<ActionContext["resources"], FileNoteAdapters>,
  ): Promise<NoteRecord> {
    // Read the bytes now, inside the operation. An unknown source or an
    // oversized file throws here, before anything is prepared or written.
    const file = await context.adapters.notesFiles.reader.read(input.source);
    // Turn the bytes into prepared content: references plus an Asset candidate
    // in this namespace. Inside an Action this key is prefixed per call.
    const body = await context.content.prepare(
      {
        type: "file",
        bytes: file.bytes,
        mediaType: file.mediaType,
        name: file.name,
      },
      { operationKey: "file-body" },
    );
    // Store the note and adopt its Asset in one transaction. The record keeps
    // only the references. Direct Collection keys are per delivery, so prefix
    // this one with the call's identity.
    return await context.collections.note.create(
      { text: input.text, body },
      { operationKey: `${context.operationKey}:save-file-note` },
    ) as NoteRecord;
  },
});

// The context `captureFileNote` expects, with the typed `saveFileNote` caller.
type CaptureFileContext = ProcessorContext<
  ProcessorContext["resources"],
  ProcessorContext["adapters"],
  ActionCallers<{ saveFileNote: typeof saveFileNote }>
>;

// Saves one file note for every stored `notes.file.requested` Event.
export const captureFileNote = defineProcessor<CaptureFileContext>({
  // Stable identity recorded on each delivery.
  id: "notes.capture-file",
  on: [{ eventType: "notes.file.requested" }],
  async handle(event, context) {
    // Only stored requests, so every file note traces back to a recorded Event.
    if (!event.durable) return;
    // Forward the small request unchanged; `notes.save-file` validates it.
    await context.actions.saveFileNote(
      event.data as SaveFileNoteInput,
      // Names this call within the delivery, so a retry reuses its result.
      { operationKey: "save-file-request" },
    );
  },
});

// File notes as a separate package. Depending on `notesPlugin` shares the
// same `note` Collection instead of declaring a second one.
export const notesFilesPlugin = definePlugin({
  id: "@team-notes/notes-files",
  version: "1.0.0",
  plugins: [notesPlugin],
  actions: { saveFileNote },
  processors: { captureFileNote },
});
```

### Create `release.txt`

The demo reads one small local file. Create it next to the other modules:

```text
Release checklist
- Run the test suite on Deno and Node.
- Tag the release from the verified commit.
- Announce the release to the team.
```

### Create `files.ts`

`files.ts` is an **entrypoint**, and it is the only module that touches the file
system. It needs read access to `release.txt`: Deno's `-A` grants it, and Node
reads local files by default. Browsers and edge Workers have no local file
system, so a host there would supply a different `NoteFileReader`, for example
one that reads an uploaded `Blob` it has already bounded.

The adapter is plain data: an object with a `read` method. It maps the single
logical source `release` to `release.txt` beside this module and refuses every
other name. It opens the file once and reads into a fixed buffer of
`maxBytes + 1` bytes, so memory stays bounded even if the file grows while it is
being read. Filling that buffer means the file is too large. This is one bounded
read, not a general streaming mechanism. `node:fs/promises` file handles work
the same on Deno and Node.

The entrypoint uses its own private in-memory application, so it does not touch
the database you chose in Chapter 7. It sends only `{ text, source }`, and it
prints chosen metadata rather than whole Event data. The text and source can
still be private user data, and resolved content reads can hydrate bodies, so
log only the fields you mean to.

```ts
// Runtime factory and the guard that separates byte streams from Events.
import { createCopilotz, isStreamOutput } from "@copilotz/copilotz";
// Types of each output item and of Collection and Action Event data.
import type {
  ActionCompletedData,
  ApplicationOutput,
  CollectionCreated,
} from "@copilotz/copilotz";
// The file notes package and the adapter contract it expects.
import { notesFilesPlugin } from "./notes-files.ts";
import type { NoteFileReader, SaveFileNoteInput } from "./notes-files.ts";
import type { NoteRecord } from "./notes-plugin.ts";
// Host file access and the note text from the command line.
import { open } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { argv } from "node:process";

// Largest file this demo accepts: 1 MiB.
const maxBytes = 1024 * 1024;

// The only sources a request may name, each fixed to one file next to this
// module. Requests never supply paths.
const sources: Record<string, { url: URL; mediaType: string }> = {
  release: {
    url: new URL("./release.txt", import.meta.url),
    mediaType: "text/plain",
  },
};

// Bounded host adapter: unknown names and oversized files fail before any
// content is prepared, and no read ever holds more than maxBytes + 1 bytes.
const reader: NoteFileReader = {
  async read(source) {
    const entry = Object.hasOwn(sources, source) ? sources[source] : undefined;
    if (!entry) throw new Error(`Unknown file source: ${source}`);
    const tooLarge = () =>
      new RangeError(`File source ${source} exceeds ${maxBytes} bytes`);
    const file = await open(fileURLToPath(entry.url), "r");
    try {
      // Cheap early refusal based on the opened file's current size.
      if ((await file.stat()).size > maxBytes) throw tooLarge();
      // One extra byte detects a file that grew after the size check.
      const buffer = new Uint8Array(maxBytes + 1);
      let length = 0;
      while (length < buffer.byteLength) {
        const { bytesRead } = await file.read(
          buffer,
          length,
          buffer.byteLength - length,
          null,
        );
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > maxBytes) throw tooLarge();
      // Return only the populated part of the buffer.
      return {
        bytes: buffer.subarray(0, length),
        mediaType: entry.mediaType,
        name: "release.txt",
      };
    } finally {
      // Release the file handle on success and on every failure.
      await file.close();
    }
  },
};

// Summarises a note's body without printing it.
function describeBody(record: NoteRecord): string {
  const refs = record.body ?? [];
  return `refs=${refs.length} asset=${refs[0]?.assetId ?? "none"}`;
}

// Prints Event types and safe facts in arrival order.
async function printOutputs(
  outputs: ReadableStream<ApplicationOutput>,
): Promise<void> {
  for await (const output of outputs) {
    if (isStreamOutput(output)) continue;
    if (!output.durable) continue;
    if (output.type === "note.created") {
      const { record } = output.data as CollectionCreated<NoteRecord>;
      console.log(
        `event note.created note=${record.id} ${describeBody(record)}`,
      );
    } else if (output.type === "notes.save-file.invoked") {
      // The recorded Action input: only the text and the logical source.
      const { input } = output.data as { input: SaveFileNoteInput };
      console.log(
        `event notes.save-file.invoked input=${JSON.stringify(input)}`,
      );
    } else if (output.type === "notes.save-file.completed") {
      const { output: saved } = output.data as ActionCompletedData<
        SaveFileNoteInput,
        NoteRecord
      >;
      console.log(
        `event notes.save-file.completed note=${saved.id} ${
          describeBody(saved)
        }`,
      );
    } else {
      console.log(`event ${output.type}`);
    }
  }
}

const app = await createCopilotz({
  // Same tenant namespace as the other Notes entrypoints.
  namespace: "team-notes",
  // File notes, which bring Notes along as a dependency.
  plugins: [notesFilesPlugin],
  // The host implementation behind `context.adapters.notesFiles.reader`.
  adapters: { notesFiles: { reader } },
});

try {
  // Admit a small request: text plus a logical source name, never the bytes.
  const handle = await app.send({
    type: "notes.file.requested",
    payload: {
      text: argv[2] ?? "Release checklist",
      source: argv[3] ?? "release",
    },
  });
  // Drain outputs while waiting for settlement; either failure rejects.
  await Promise.all([printOutputs(handle.outputs), handle.done]);
  const status = await app.operationStatus({
    operationId: handle.operationId,
  });
  console.log(`settled operation: ${status?.state ?? "unknown"}`);
} finally {
  // Release the runtime and its in-memory database, also after a failure.
  await app.close();
}
```

## Check it works

From the directory holding `notes-plugin.ts`, `notes-files.ts`, `release.txt`
and `files.ts`, run either runtime:

```sh
# Deno: -A grants the runtime's permissions and read access to release.txt.
deno run -A files.ts "Release checklist"
# Node 24+: reads local files by default.
node files.ts "Release checklist"
```

IDs change every run; the shape looks like this:

```text
event notes.file.requested
event notes.save-file.invoked input={"text":"Release checklist","source":"release"}
event note.created note=5b91… refs=1 asset=a7c3…
event notes.save-file.completed note=5b91… refs=1 asset=a7c3…
settled operation: completed
```

Check these facts rather than exact IDs or line order:

- The `notes.save-file.invoked` input is exactly the text and
  `"source":"release"` — no file contents.
- Exactly one `note.created` line appears, with `refs=1`.
- The `note=` and `asset=` values on `note.created` and
  `notes.save-file.completed` are equal: one note, one Asset, referenced twice.
- The last line reports `completed`.

Now name a source the host does not allow:

```sh
# Deno: an unknown logical source fails inside the Action.
deno run -A files.ts "Release checklist" "../secrets"
# Node 24+: the same check.
node files.ts "Release checklist" "../secrets"
```

The `notes.file.requested` input is recorded, but no `note.created` or
`notes.save-file.completed` line appears and no `settled` line is printed. The
process exits with a non-zero status after closing the application, and
`Unknown file source` appears in the error.

Finally, rerun Chapter 5's `app.ts` unchanged. Text-only notes still save,
because `body` is optional and `notes.save` never sees it. For automated
regression checks,
[Chapter 6](../part-2-verify-and-recover/06-test-and-inspect.md) creates the
scenario files; after that validation step, its tests run unchanged against this
optional field.

## What this unlocks

Notes can now carry bodies of any type without bloating history. You can:

- accept files, images or generated documents while the ingress Event and the
  Action input stay small, and the declared `body` field stores references
  instead of bytes;
- keep the choice of _which_ files exist and how large they may be in the host,
  where a test, a server or a Worker can each supply its own `NoteFileReader`;
- reuse the same Asset references from later records instead of copying bytes.

This chapter keeps one bounded local file in memory on purpose. It does not
stream, and splitting a body into references does not by itself move it out of
the database: the default body store keeps small bodies in the database. Body
storage backends, size limits, range reads and streamed bodies are host choices
covered in [Content and Assets](../../content-assets.md) and
[Streams](../../streams.md). A file Asset stores one body exactly; agent Memory
and Knowledge instead decide what an agent recalls or searches.

## Next steps

- Next:
  [Chapter 19: Schedule Recurring Work](../part-5-operate-and-scale/19-schedule-recurring-work.md)
  adds recurring Notes work on a schedule. It requires the persistence from
  Chapter 7.
- Reference: [Content and Assets](../../content-assets.md) covers content
  references, `prepare`, Collection content fields, reads with byte limits and
  body storage backends.
- Reference: [Streams](../../streams.md) covers incremental bodies that are
  produced or consumed over time.
