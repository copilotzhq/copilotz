---
title: Runtime-native progressive streams
description: The Phase 10 boundary between progressive byte production, BodyStore, protected Assets, and plugin-owned semantic records.
---

# Runtime-native progressive streams

Phase 10 treats streams as runtime-native progressive content production. A
Stream is not a plugin resource, Collection, Action, semantic event family, or
application-domain record. It is the progressive write/follow mode of the
BodyStore.

The durable semantic result of a successful stream is the Asset adopted by a
semantic mutation, not the stream session itself.

## Boundary

The layers are distinct:

- **Body** — physical byte persistence and operational state.
- **Stream** — temporary progressive production of one Body.
- **Asset** — protected graph metadata for an immutable ready Body.
- **ContentRef** — the safe semantic pointer stored by plugin-owned Collection
  records.
- **Collection record** — plugin-owned business/domain state.

The lifecycle is:

```text
stream.open        -> progressive Body/session only
stream.append      -> Body parts only
stream.close       -> ready Body + invocation-local PreparedContent
semantic adoption  -> Asset node + ContentRef + owner edge + event manifest
```

Opening a stream creates no graph node, no Asset node, and no semantic event.
Appending chunks creates no graph node, no Asset node, and no semantic event.
Closing a stream seals and verifies the Body, but still creates no Asset node by
itself. It returns a protected prepared-content carrier that can be consumed by
the next semantic mutation in the same invocation root.

Only assetization creates protected Asset metadata:

- a Collection mutation whose declared `content.fields` consume prepared
  content; or
- standalone `scope.content.publish(...)`.

There is no staging Asset node for an open stream, and no Asset node for a
closed-but-unadopted stream. A ready Body that is never adopted remains
protected briefly as operational orphan state and is collected after the
protection/grace window.

## API shape

The final surface belongs under scoped content:

```ts
const writer = await context.content.stream.open({
  kind: "text",
  role: "assistant-output",
  name: "assistant response",
  metadata,
}, options?);

await writer.append({ bytes, appendId }, options?);

const prepared = await writer.close({
  assetId,
  origin,
  metadata,
}, options?);

await context.transaction(async (tx) => {
  await tx.collection(messageCollection).create({
    threadId,
    senderId,
    content: prepared,
  });
});
```

`writer.close()` returns `PreparedContent`; it does not publish an Asset. The
owning semantic mutation decides whether the ready Body becomes durable
application content.

Followers read operational bytes:

```ts
const body = await context.content.stream.follow({ id: writer.id, offset: 0 });
```

Following a live stream is an operational/runtime projection. It is not durable
semantic graph state. Attachments and transports may expose ephemeral
participant-labelled stream output, but they must not invent durable
`stream.created` or `stream.updated` facts.

## Runtime ownership

Runtime owns the domain-neutral mechanics:

- BodyStore reservation, append, follow, seal, abort, digest, and length checks;
- writer generation and fencing;
- writer lease/protection windows;
- ready-Body to prepared-content conversion;
- generic expired-writer recovery: fence the expired Body generation, then abort
  it without inspecting semantic graph records;
- generic orphan cleanup for unreferenced ready Bodies; and
- backpressured byte transport/projection.

Runtime does not know what a stream means. It does not branch on message, tool,
LLM, goal, memory, schedule, or any plugin-owned domain. It does not maintain a
Stream Collection, Stream Action, or Stream durable-event protocol.

## Plugin ownership

Plugins own meaning. A plugin may use runtime progressive content to produce
message content, tool output, LLM attempt output, audio recordings, exports, or
any other semantic record. The plugin persists meaning by writing its own
Collection records with declared content fields.

If semantic recovery is needed after a stream fails or is abandoned, that is
plugin policy. Runtime recovery only decides whether an operational progressive
Body can still be produced, sealed, aborted, or collected.

## Asset invariant

Protected Asset graph metadata exists only for immutable semantic content. Asset
nodes are created only by assetization, never by streaming itself.

Therefore:

- open stream: no Asset;
- appending stream: no Asset;
- sealed but unadopted stream Body: no Asset;
- adopted ready Body: exactly one protected Asset metadata node for that
  semantic Asset identity;
- deleted owner record: removes its owner edge; the Asset remains while any
  owner or protected liveness reference exists.

This keeps Body, Stream, Asset, and Collection records from collapsing into one
mutable object with mixed operational and semantic state.
