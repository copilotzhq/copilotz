---
title: "Streams"
description: "Publish progressive bytes from an Action with context.streams, read stream.output payloads alongside operation settlement, and interpret terminal status, replay and retention."
section: Runtime
order: 60
status: stable
---

# Streams

## The pain

An Action drafts a long piece of text. Users wait for the whole result before
they see anything, so the work feels slow. Put each partial chunk in an Event
instead, and the Event log fills with fragments that are not facts. Either way,
a reconnecting client has no reliable way to tell "the bytes stopped because the
work finished" from "the bytes stopped because the producer crashed".

## The problem

Progressive output needs a contract of its own, separate from Events:

- bytes reach live observers as they are written, without becoming durable
  Events;
- each observer reads independently and can reconnect from where it stopped;
- the end of the bytes is reported separately from what that end _means_:
  completed, failed, cancelled, superseded or abandoned;
- a retried producer never splices new bytes onto an old attempt.

## The solution

An Action or Processor opens a **stream** with `context.streams.open(...)`. The
runtime publishes one serializable descriptor, then delivers a `stream.output`
item to every observer of the operation: `app.send(...)` handles,
`app.attach(...)` handles and HTTP operation observers. Each observer gets its
own byte reader; subscribers never share one `ReadableStream`.

The example below needs only `@copilotz/copilotz@^0.86.3` on Deno 2.9+ or Node
24+. It needs no credential and no agent harness. Save it as `stream-draft.ts`:

```ts
// Runtime factory, the Action and Processor helpers, and the guard that
// separates byte streams from Events.
import {
  createCopilotz,
  defineAction,
  defineProcessor,
  isStreamOutput,
} from "@copilotz/copilotz";
// Types for the Action and Processor contexts, Action callers and output items.
import type {
  ActionCallers,
  ActionContext,
  ApplicationOutput,
  ProcessorContext,
  StreamOutput,
} from "@copilotz/copilotz";
// The topic comes from the command line; chunks are written to stdout as they
// arrive. Both work on Deno and Node.
import { argv, stdout } from "node:process";

// Input the drafting Action accepts.
type DraftInput = { topic: string };

// Writes a short draft progressively and returns the full text as its output.
const writeDraft = defineAction({
  // Stable identity; lifecycle Events are `drafts.write.invoked`/`.completed`.
  id: "drafts.write",
  inputSchema: {
    type: "object",
    properties: { topic: { type: "string", minLength: 1 } },
    required: ["topic"],
    additionalProperties: false,
  } as const,
  async execute(input: DraftInput, context: ActionContext) {
    // Open one published lane. The runtime does not prefix stream IDs, so
    // derive the ID from this call's stable identity; each execution attempt
    // still gets its own physical Body.
    const writer = await context.streams.open({
      id: `${context.operationKey}:draft`,
      mediaType: "text/plain; charset=utf-8",
      kind: "text",
      // Plugin-owned role; the runtime does not interpret it.
      role: "draft.text",
    }, { signal: context.signal });
    const parts = [`Draft about ${input.topic}: `, "first point. ", "done."];
    try {
      for (const [index, part] of parts.entries()) {
        // `appendId` makes a repeated append of the same chunk idempotent.
        await writer.append({
          bytes: new TextEncoder().encode(part),
          appendId: `part-${index}`,
        }, { signal: context.signal });
      }
      // Seal the Body as complete. The result is prepared content, not an Asset.
      await writer.close({ assetId: `${context.operationKey}:draft` });
      // Nothing adopts these bytes, so keep them only for operation replay.
      await writer.retain({ retention: "observation" });
    } catch (error) {
      // Record why production ended without storing raw error text; the
      // written prefix stays readable.
      await writer.abort({
        outcome: context.signal.aborted ? "cancelled" : "failed",
        reason: "Draft production stopped.",
      }).catch(() => undefined);
      throw error;
    }
    // Small teaching sample: the short text is returned in the completed Event.
    // Large results should adopt prepared content and return references.
    return { text: parts.join("") };
  },
});

// Context type that lets the Processor call `writeDraft` with checked input.
type DraftContext = ProcessorContext<
  ProcessorContext["resources"],
  ProcessorContext["adapters"],
  ActionCallers<{ writeDraft: typeof writeDraft }>
>;

// Calls the Action once for each stored draft request.
const requestDraft = defineProcessor<DraftContext>({
  id: "drafts.request",
  on: [{ eventType: "drafts.requested" }],
  async handle(event, context) {
    if (!event.durable) return;
    await context.actions.writeDraft(event.data as DraftInput, {
      // Names this one call within the delivery, so a retry reuses its result.
      operationKey: "write-draft",
    });
  },
});

// Wait for stdout to finish each write before reading another chunk, so a
// slow terminal does not create an unbounded output buffer.
function writeText(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stdout.write(text, (error) => error ? reject(error) : resolve());
  });
}

// Prints each chunk as it arrives, then reports what EOF meant. Only one chunk
// is held at a time; the whole body is never buffered.
async function readStream(output: StreamOutput): Promise<void> {
  // `stream: true` keeps a multi-byte character split across chunks intact.
  const decoder = new TextDecoder();
  await writeText(`stream ${output.role}: `);
  for await (const chunk of output.payload) {
    await writeText(decoder.decode(chunk, { stream: true }));
  }
  // Flush any bytes the decoder still holds.
  await writeText(`${decoder.decode()}\n`);
  // EOF only means no more bytes; the terminal status says how it ended.
  const status = await output.terminal;
  console.log(
    `terminal outcome=${status.outcome} capture=${status.capture}`,
    `availability=${status.availability} offset=${status.offset}`,
  );
}

// Drains outputs, starting a separate reader for each stream so a slow
// payload never blocks the next output item.
async function drain(outputs: ReadableStream<ApplicationOutput>) {
  const readers: Promise<void>[] = [];
  const errors: unknown[] = [];
  try {
    for await (const output of outputs) {
      if (isStreamOutput(output)) {
        // Capture a reader failure immediately so it is never unhandled.
        readers.push(
          readStream(output).catch((error) => {
            errors.push(error);
          }),
        );
      } else console.log(`event ${output.type}`);
    }
  } finally {
    // Let every started reader finish, even if output iteration failed.
    await Promise.all(readers);
  }
  if (errors.length > 0) throw errors[0];
}

const app = await createCopilotz({
  namespace: "team-notes",
  actions: { writeDraft },
  processors: { requestDraft },
});

try {
  const handle = await app.send({
    type: "drafts.requested",
    payload: { topic: argv[2] ?? "streams" },
  });
  // Drain outputs and wait for settlement, letting both finish before
  // reporting the first failure.
  const results = await Promise.allSettled([
    drain(handle.outputs),
    handle.done,
  ]);
  for (const result of results) {
    if (result.status === "rejected") throw result.reason;
  }
} finally {
  // Release the runtime and its private in-memory database.
  await app.close();
}
```

Run it with `deno run -A stream-draft.ts "release notes"` or
`node stream-draft.ts "release notes"`. Expect the `drafts.*` lifecycle Events,
a `stream draft.text:` line built up chunk by chunk to
`Draft about release notes: first point. done.`, and
`terminal outcome=completed capture=complete availability=retained offset=45`.
Event lines can interleave with the stream text.

The reader decodes one chunk at a time and waits for each stdout write before
reading the next, rather than accumulating the whole body. Writing straight to
stdout suits this single-lane sample; an application with several lanes renders
each one into its own view.

The returned text is a small teaching sample. For large results, adopt the
prepared content from `close(...)` and return references, as
[Content and Assets](content-assets.md) shows, rather than copying the body into
the completed Event.

### What the consumer must do

- **Drain outputs while awaiting `done`.** Run both concurrently, as above.
  Cancelling a stream's `payload` stops only that subscriber's reader; it does
  not cancel the producer or the operation.
- **Treat EOF as "no more bytes", never as success.** A failed lane is a
  readable, finite prefix, so its reader reaches EOF too. Only
  `await output.terminal` says how production ended.
- **Treat the stream as display, not as the result.** Stream bytes and their
  framing are never durable Events. The Action's completed Event carries its
  durable output, which for large content is a reference to an adopted Asset.

## Reference

### `StreamOutput`

A `stream.output` item carries a serializable descriptor plus two live parts:

| Field                                    | Meaning                                                                                                   |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `streamId`                               | Physical lane ID, unique per execution attempt.                                                           |
| `namespace`                              | Namespace of the producing work.                                                                          |
| `mediaType`, `kind`, `role`              | Byte format, content kind and plugin-owned role.                                                          |
| `name`, `alt`, `language`, `disposition` | Optional presentation hints.                                                                              |
| `causationId`, `correlationId`           | Optional causal identities.                                                                               |
| `metadata`                               | Opaque JSON hints; streams opened in an Action also carry runtime-owned keys such as `sourceActionRunId`. |
| `payload`                                | This subscriber's own `ReadableStream<Uint8Array>`.                                                       |
| `terminal`                               | `Promise<StreamTerminalStatus>` for the lane's settlement.                                                |

The descriptor has no thread, participant, channel, visibility, model or
provider field. Semantic plugins put such hints in `metadata`.

### `StreamTerminalStatus`

Three independent fields describe how a lane ended:

- `outcome`: `completed`, `failed`, `cancelled`, `superseded` or `abandoned`;
- `capture`: `complete` or `truncated`; `completed` always means `complete`, but
  another outcome may also have complete capture;
- `availability`: `retained`, `purge_pending`, `purged` or `missing`.

`offset` is the exact immutable length of the frozen Body, including an append
that became visible just before the producer lost ownership. `terminalAt` is the
settlement time.

### Writer operations

`context.streams.open(...)` returns a writer:

- `append({ bytes, appendId })` is idempotent by `appendId` and follows Body
  backpressure.
- `close({ assetId })` seals a `ready` Body and returns `PreparedContent`. It
  creates no Asset; an Action or Collection adopts the content in its own
  durable write.
- `retain(...)` must follow `close`. Choose
  `{ retention: "canonical", assetId }` when the content is adopted as an Asset,
  or `{ retention: "observation" }` to keep it only for operation replay.
- `abort({ outcome?, capture?, reason? })` ends a published lane without
  deleting it. The default outcome is `failed`; pass `{ outcome: "cancelled" }`
  when handling cancellation. The prefix becomes an immutable `incomplete` Body
  that is readable but never adoptable.
- Disposing a leaked writer (`Symbol.asyncDispose`, or execution teardown)
  records `abandoned` rather than guessing a semantic outcome.

Before its descriptor is published, a failed open discards staging. After
publication, the lane is a replay obligation and always reaches a terminal
status. Active writers renew their storage lease independently of byte traffic;
a lost lease fences further appends, and maintenance freezes an expired open
lane as `incomplete`.

### Replay and retention

`app.attach(...)` and reconnecting HTTP observers read the existing Body from
its committed offset; raw chunks are never copied into another journal. A lane
still being written replays its prefix and then follows live bytes; a settled
lane replays up to its terminal offset and then reports its terminal status.
Within one runtime, viewers of the same operations share live Event and Body
readers; historical replay is still per viewer. Each subscriber gets its own
payload stream, fed through a bounded queue.

Observation Bodies and their replay metadata become eligible for expiry 24 hours
after the operation settles. Expiry happens when maintenance runs:
`app.maintenance(...)` accepts `operationRetentionMs` to change that grace, and
`null` disables it. Canonical adoption keeps the Body under Asset ownership even
after replay metadata expires.

Over HTTP, a non-completed or unavailable lane ends with an in-band
`stream.error` frame (stream ID, offset, outcome, capture, availability and a
code such as `stream_failed`); a completed, available lane ends with
`stream.end`. HTTP observations are renewed every 5 minutes by default. The
published client reconnects on a planned renewal itself; custom clients must
apply frames before advancing their checkpoint, handle repeated frames
idempotently, and must not treat EOF or a closing multipart boundary as
operation completion. Cursors from an older generation are rejected with
`invalid_replay_cursor`; see
[Events, Deliveries, and Recovery](events-deliveries-recovery.md) for the
offline catalog upgrade.

### Who can see stream bytes

Operation observation is not a visibility filter. A raw `app.send(...)`,
`app.attach(...)` or HTTP operation observation delivers every stream in the
operation, including private agent answers. Hiding bytes in client code does not
stop them reaching the client. Treat raw observers as trusted diagnostic
clients, and give end users filtered history, or deny them raw observation, when
they must not see private data.

## What this unlocks

- Show progress as it happens while the durable result stays in one Event.
- Reconnect a viewer mid-stream from its applied checkpoint while replay data is
  retained.
- Report a truncated or cancelled answer honestly instead of as success.
- Keep streamed content as an Asset when it becomes part of your state.

## Next steps

- [Content and Assets](content-assets.md) explains prepared content, adoption
  and BodyStores.
- [Events, Deliveries, and Recovery](events-deliveries-recovery.md) covers
  operations, replay cursors and the catalog upgrade.
- [Observation performance](observation-performance.md) covers renewal and
  viewer capacity.
- [Server](server.md) exposes operation observation over HTTP.
