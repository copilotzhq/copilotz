---
title: "Content and Assets"
description: "Store large or binary bodies once as namespace-scoped Assets, keep records and Events small with content references, and read bodies back under authorization and byte budgets."
section: Runtime
order: 50
status: stable
---

# Content and Assets

## The pain

A note gains an attached checklist, an Action receives a long prompt, a Tool
returns a generated report. If those bodies travel as ordinary JSON, every copy
of the data carries them: the admitted Event, the Action's `invoked` and
`completed` Events, the stored record and each `note.*` Event. One upload turns
into several stored copies, and every log, replay or HTTP observer that forwards
those Events forwards the bytes too.

## The problem

Records and Events need to say _which_ body they mean without holding it. That
needs a contract with four parts:

- one immutable, tenant-scoped home for each body, with a verifiable digest;
- a small pointer that records, Events and Action values can carry;
- atomic placement: a record never commits pointing at a body that was not
  stored, and a retried write does not store the body twice;
- controlled reading: authorization, integrity checks and a byte budget whenever
  a body is loaded back.

Two limits stay true whatever you declare. Copilotz stores an admitted input
exactly as it was sent, so a large `app.send` payload is already history; adding
a content declaration later changes new writes only and never rewrites recorded
Events or records. And no declaration streams a body: bounded reads load whole
bodies into memory. Progressive bodies are a separate mechanism,
[Streams](streams.md).

## The solution

### Assets and content references

An **Asset** is one immutable body plus canonical metadata: `id`, `namespace`,
`mediaType`, `byteLength`, a `sha256:` `digest`, a lifecycle `state`, an
optional opaque `origin` and `metadata`. Its physical location is private to the
runtime.

Records hold a **content reference** (`ContentRef`) instead of the body:

| Field                                    | Meaning                                                              |
| ---------------------------------------- | -------------------------------------------------------------------- |
| `assetId`                                | The Asset in the caller's namespace.                                 |
| `kind`                                   | `text`, `json`, `image`, `audio`, `video` or `file`.                 |
| `role`                                   | Application meaning, such as `body` or `attachment`.                 |
| `mediaType`                              | Must match the Asset's canonical media type.                         |
| `name`, `alt`, `language`, `disposition` | Optional presentation hints. `disposition` is `inline`/`attachment`. |
| `metadata`                               | Optional JSON-safe extra facts.                                      |

References let many records share one Asset, and a retried write with the same
key reuses its Asset. Separate writes under different keys are not guaranteed to
deduplicate identical bytes.

A field holding content stores a `ContentSequence`: an ordered array of
references. Validate it with the exported `contentSequenceSchema`; use
`isContentRef` to check one value at run time.

### Prepare, then adopt in the owning write

Inside an Action, `context.content.prepare(input, { operationKey })` turns
source content into `PreparedContent`: the references plus not-yet-stored Asset
candidates with their digests. Accepted inputs are a plain string (one text
entry), `{ type: "text", text }`, `{ type: "json", value }` or
`{ type: "image" | "audio" | "video" | "file", bytes, mediaType }`, alone or as
an array.

Passing prepared content to a Collection field declared with
`content: { fields: [...] }` stores the record and adopts its Assets in the same
transaction as the record's Event. If validation or the database write fails, no
record or reference commits that points at a partial body. With an object store,
body bytes may be written before that transaction; a rollback can leave unowned
bytes behind for garbage collection, never a dangling reference. Collection
fields also accept existing references and source content directly; the
Collection prepares those before its SQL transaction.

Keys follow the usual scopes. Inside an Action, `prepare` keys are prefixed with
the invocation automatically; direct Collection writes are scoped to the
delivery, so prefix them with `context.operationKey`, as
[Chapter 18](getting-started/part-4-release-to-users/18-handle-files-and-large-content.md)
does. An Action that only needs a standalone output Asset can call
`context.content.publish({ body, mediaType }, { operationKey })` and return a
reference to it.

### Declared Action input content

An Action may declare which input paths hold content:
`content: { input: ["body"], byteLimit }`. Paths are dotted, with `[]` to
traverse arrays; up to 32 are allowed.

- **Shorthand normalization.** At such a path, a plain string becomes one text
  entry, and an entry carrying `value` without `assetId` is published as an
  Asset keyed by media type and content hash. An entry with an existing
  `assetId` is reused after authorization, readiness and media type checks.
- **Reference-only persistence.** The `invoked` Event and retries record
  references only.
- **Hydrated execution.** The handler receives each entry with its metadata,
  `assetId` and a `value`: a string for text, parsed JSON for JSON, a fresh
  `Uint8Array` otherwise. `inputSchema` validates this hydrated shape, so
  declare the field as an array of entries, not as a string.
- **`resolve: false`.** An entry written as `{ ...ref, resolve: false }` stays a
  descriptor: no body read, no `value`. The reference is still authorized;
  leaving bytes unloaded never grants access to them.

`byteLimit` (default 32 MiB) bounds the bodies one invocation publishes or
loads. Content declarations cannot be combined with secret input or output
schemas. Outputs are not covered; return references, not bodies.

### Reading bodies back

Collection reads leave references untouched unless asked. The second argument of
`get`, `list` and `search` takes `content`:

- `true` resolves every declared field;
- `{ fields, exclude, byteLimit }` selects declared paths, leaves entries that
  match an `exclude` clause (`kind`, `role`, `mediaType`, `disposition`) as
  `resolve: false` descriptors, and sets the budget.

Resolved entries keep their reference metadata and add `value`, typed as
`ResolvedCollectionContentEntry`. Resolution runs after filtering and
pagination, reads each unique Asset body once per call, and checks the byte
budget (default 32 MiB of unique bodies) against metadata before any body is
fetched. Missing, unauthorized or corrupt content rejects the whole read.
Undeclared paths are rejected. Excluded entries are still authorized as
references; exclusion only skips loading. The budget bounds stored body bytes,
not every decoded copy in memory.

`context.content.resolveMany(refs)` and `context.content.open(ref)` give
lower-level access with the same authorization and integrity checks. Processors
receive `event.data` with text and JSON references carrying `value` and other
kinds left as metadata only.

Apply visibility rules before resolving bodies another user should not see.
Authorization of content is enforced per reference, but loading a body is not a
substitute for application access checks.

### Where bodies live

By default, body bytes live in the application's database, next to their Asset
metadata. A reference does not imply cloud storage. Filesystem, S3-compatible
and Google Cloud Storage body stores are explicit host choices, covered in
[Runtime adapters](runtime-adapters.md); credentials and physical keys never
appear in a `ContentRef`.

Assets stay alive while something owns them. Records with declared content
fields own their Assets, and Action invocations with declared input own theirs
for durable replay. There is no automatic expiry of those owners.

### Example: measure a note's body under a byte budget

This builds on the files from
[Chapter 18](getting-started/part-4-release-to-users/18-handle-files-and-large-content.md):
`notes-plugin.ts` with its declared `body` field, and `notes-files.ts` with
`notesFilesPlugin` and the `NoteFileReader` contract. It needs Deno 2.9+ or Node
24+ and `@copilotz/copilotz@^0.86.3`; no credential or file access.

Create `body-report.ts`, a pure definition module. Whenever a note with a body
is created, an Action reads that body back with a bounded Collection read and
returns only sizes. The report counts text and binary bytes only; JSON entries
are counted as entries but not measured, and this example has none:

```ts
// Helpers that declare an Action, a Processor and their Plugin.
import {
  defineAction,
  definePlugin,
  defineProcessor,
} from "@copilotz/copilotz";
// Context types, typed Action callers, Collection Event data and resolved
// content entries.
import type {
  ActionCallers,
  ActionContext,
  CollectionCreated,
  CollectionRecord,
  ProcessorContext,
  ResolvedCollectionContentEntry,
} from "@copilotz/copilotz";
// File notes bring the `note` Collection with its declared `body` field.
import { notesFilesPlugin } from "./notes-files.ts";
import type { NoteRecord } from "./notes-plugin.ts";

// Largest total body this Action is willing to load: 256 KiB.
const maxBodyBytes = 256 * 1024;

// Facts returned to the caller and recorded on the completed Event: sizes, never
// the bytes themselves.
export type BodyReport = { id: string; entries: number; bytes: number };

// Reads one note's body back under a byte budget and measures it.
export const measureBody = defineAction({
  id: "notes.measure-body",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string", minLength: 1 } },
    required: ["id"],
    additionalProperties: false,
  } as const,
  async execute(
    input: { id: string },
    context: ActionContext,
  ): Promise<BodyReport> {
    // Resolve only the declared `body` field. The budget is checked against
    // Asset metadata before any body is fetched; exceeding it rejects the read.
    const note = await context.collections.note.get(
      { id: input.id },
      { content: { fields: ["body"], byteLimit: maxBodyBytes } },
    ) as { body?: readonly ResolvedCollectionContentEntry[] } | null;
    if (!note) throw new Error(`Note not found: ${input.id}`);
    const entries = note.body ?? [];
    let bytes = 0;
    for (const entry of entries) {
      // Text arrives as a string, binary kinds as bytes; JSON is not counted.
      if (typeof entry.value === "string") {
        bytes += new TextEncoder().encode(entry.value).byteLength;
      } else if (entry.value instanceof Uint8Array) {
        bytes += entry.value.byteLength;
      }
    }
    return { id: input.id, entries: entries.length, bytes };
  },
});

// The context `reportBodies` expects, with the typed `measureBody` caller.
type ReportContext = ProcessorContext<
  ProcessorContext["resources"],
  ProcessorContext["adapters"],
  ActionCallers<{ measureBody: typeof measureBody }>
>;

// Measures every stored note that carries a body.
export const reportBodies = defineProcessor<ReportContext>({
  id: "notes.report-body",
  on: [{ eventType: "note.created" }],
  async handle(event, context) {
    // Only stored Events, so each report traces back to a recorded note.
    if (!event.durable) return;
    // Stored records always carry the runtime's `id`, `namespace` and
    // timestamps; `CollectionRecord` types them as strings.
    const { record } = event.data as CollectionCreated<
      NoteRecord & CollectionRecord
    >;
    // Text-only notes have nothing to measure.
    if (!record.body?.length) return;
    await context.actions.measureBody(
      { id: record.id },
      // Names this call within the delivery, so a retry reuses its result.
      { operationKey: "measure-body" },
    );
  },
});

// Body reports as a separate package on top of file notes.
export const bodyReportPlugin = definePlugin({
  id: "@team-notes/body-report",
  version: "1.0.0",
  plugins: [notesFilesPlugin],
  actions: { measureBody },
  processors: { reportBodies },
});
```

Create `body-check.ts`, the entrypoint. Its reader serves one fixed in-memory
body, so the run touches neither the file system nor your persistent database:

```ts
// Runtime factory and the guard that separates byte streams from Events.
import { createCopilotz, isStreamOutput } from "@copilotz/copilotz";
import type {
  ActionCompletedData,
  ApplicationOutput,
} from "@copilotz/copilotz";
// The body report package and the file reader contract it inherits.
import { bodyReportPlugin } from "./body-report.ts";
import type { BodyReport } from "./body-report.ts";
import type { NoteFileReader } from "./notes-files.ts";

// One logical source with a small fixed body; unknown names are refused.
const reader: NoteFileReader = {
  read(source) {
    if (source !== "release") {
      return Promise.reject(new Error(`Unknown file source: ${source}`));
    }
    return Promise.resolve({
      bytes: new TextEncoder().encode(
        "Release checklist\n- Tag the release.\n",
      ),
      mediaType: "text/plain",
      name: "release.txt",
    });
  },
};

// Prints the body report and the type of every other durable Event.
async function printOutputs(
  outputs: ReadableStream<ApplicationOutput>,
): Promise<void> {
  for await (const output of outputs) {
    if (isStreamOutput(output) || !output.durable) continue;
    if (output.type === "notes.measure-body.completed") {
      const { output: report } = output.data as ActionCompletedData<
        { id: string },
        BodyReport
      >;
      console.log(`report entries=${report.entries} bytes=${report.bytes}`);
    } else {
      console.log(`event ${output.type}`);
    }
  }
}

// Private in-memory application with the host file adapter.
const app = await createCopilotz({
  namespace: "team-notes",
  plugins: [bodyReportPlugin],
  adapters: { notesFiles: { reader } },
});

try {
  // A small request: text and a logical source name, never the bytes.
  const handle = await app.send({
    type: "notes.file.requested",
    payload: { text: "Release checklist", source: "release" },
  });
  // Drain outputs and wait for settlement, letting both finish before
  // reporting the first failure.
  const results = await Promise.allSettled([
    printOutputs(handle.outputs),
    handle.done,
  ]);
  for (const result of results) {
    if (result.status === "rejected") throw result.reason;
  }
} finally {
  // Release the runtime, also after a failure.
  await app.close();
}
```

Run `deno run -A body-check.ts` or `node body-check.ts`. Among the Event lines,
expect `report entries=1 bytes=37`, and no body text in any printed Event. Lower
`maxBodyBytes` below 37 and the read, and therefore the operation, fails before
the body is fetched.

## What this unlocks

- Records, Events and Action values stay small while bodies of any type are
  stored as Assets, verified by digest and scoped to their namespace.
- Actions can accept text or binary input without recording it in their
  lifecycle Events, and work with hydrated values directly.
- Readers choose exactly which bodies to load and how many bytes they may cost,
  leaving the rest as descriptors.
- Body storage can move from the database to an object store as a host decision,
  without changing references or application code.

## Next steps

- [Chapter 18: Handle Files and Large Content](getting-started/part-4-release-to-users/18-handle-files-and-large-content.md)
  walks through bounded host file reads end to end.
- [Collections](collections.md) covers declared fields, read options, query
  predicates and transactions.
- [Actions](actions.md) covers invocation keys, validation and lifecycle Events.
- [Streams](streams.md) covers bodies produced or consumed progressively.
- [Runtime adapters](runtime-adapters.md) covers body store backends.
