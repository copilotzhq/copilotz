# Message Collection

## What it is

The canonical content-bearing Message record.

## Why it exists

Conversation history and revisions require durable, asset-aware records.

## How to use it

Access `message` by ID or query it by Thread and creation order.

Provision the chronological history index once per physical Core schema, after
the Event schema exists:

```ts
import { provisionCoreHistoryIndexes } from "@copilotz/copilotz/core";

await provisionCoreHistoryIndexes(sqlSession, databaseSchema);
```

For an existing PostgreSQL schema, use `{ concurrently: true }` outside a
transaction to allow writes during index construction. This explicit operation
also runs `ANALYZE`: expression statistics keep the planner from severely
underestimating a thread's history and sorting every Message before returning a
page. A failed or conflicting index definition is rejected. Normal history and
scope selection never provision indexes. Collection `indexes` declarations do
not currently install physical indexes automatically.

The index orders by namespace, Collection, `data ->> 'threadId'`, `created_at`
and `id`; timestamp ties retain their existing ID ordering. Its namespace and
Collection keys work with parameterized queries without relying on a partial
index's constant type predicate. Large pages can stop an ordered scan at their
limit; small bounded ranges may use a cheap bitmap scan and sort.

## How it works

The Collection adopts declared content, records routing fields, and validates
immutable revision metadata.

The `history` named query accepts `threadId`, `order`, `after` or `before`, and
`limit`. It selects the active revision branch unless `view: "all"` is supplied.
Trusted callers supply `viewerParticipantIds`; omitting that input retains the
internal caller's broader non-scoped history view. The HTTP facade supplies the
authenticated participant identity, not a client-provided viewer list.

Visibility and branch predicates run in the Collection database query before
pagination. Cursors must belong to that same visible selection. Public-status
Tool messages retain their status. Core removes content and execution metadata
unless the viewer can read the output.

Tool visibility is `{ kind: "tool", policy, requesterId, initiatorId? }`.
`requesterId` identifies the requesting Agent participant; `initiatorId`
identifies the original human participant, captured when a new plan is created
and retained across Agent-to-Agent work. New public tool-call Messages carry the
same identities with `policy: "public"`; Tool-result Messages retain the
configured policy, which defaults to `public_status`.

Output is readable when the policy is `public`, the viewer is the requester, or
the policy is `public_status` and the viewer is the initiator. `requester_only`
never grants the human initiator access. The same rule applies to live/progress
streams, retained stream assets, message assets, and operation results.

An unreadable result is still returned when its source Message advertises the
same invocation and is visible to the viewer, including `requester_only`
results. It keeps its original `visibility` and Message identity, with
`content: []` and only these metadata fields:

```json
{
  "toolStatus": "completed",
  "toolId": "lookup",
  "toolInvocation": { "id": "call-id", "tool": { "id": "lookup" } },
  "copilotzWorkflow": { "sourceMessageId": "call-message-id" },
  "copilotzToolAction": {
    "actionRunId": "run-id",
    "planMessageId": "call-message-id"
  }
}
```

`toolStatus` can also be `failed` or `cancelled`. Optional correlation fields
are omitted when absent. This uses the existing Tool-result Message and requires
no parallel status channel. No backfill is performed: retained Messages without
`initiatorId` do not gain initiator access.

Runtime callers can supply `content: true` or
`content: { fields: ["content"], byteLimit: 1048576 }` in the query input. This
uses the runtime Collection reader to resolve the selected page's declared
content into reference metadata plus `value`. Core first selects and redacts the
page, then re-reads only fully visible records with content enabled. That
bounded read repeats visibility constraints and checks `updatedAt`, so private
status-only bodies are never loaded and concurrent changes fail explicitly. The
byte budget applies to each batch of at most 512 records.

HTTP uses `overfetch: true` with the actual page limit. The query returns one
extra visible record for `hasMore`, but resolves content only inside the
requested page; the facade discards that lookahead record. Missing lookahead
assets cannot fail the returned page.

Default Collection reads still contain references. HTTP history opts into
resolved content; the Core browser client decodes binary values with the shared
media codec. The private Agent window keeps its separate visibility policy, now
compiled into database predicates before pagination. Core expands tool/ask
dependencies and projects the participant-specific transcript before resolving
the final selected messages. Attachment descriptors stay unloaded; only the
target Agent's own assistant turns include resolved reasoning. HTTP and device
collection reads apply the same projection; live observation projects Messages
and authorizes Tool stream ancestry before publishing output.

Both `content` and `metadata.llmReasoning` are declared content fields. New
writes adopt and track both paths; resolved reads can load reasoning from
existing records without rewriting them. Existing records gain the additional
graph references when their projections are rebuilt; changing the declaration
does not itself rewrite stored Events.
