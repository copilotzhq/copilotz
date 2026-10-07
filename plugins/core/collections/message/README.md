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
Tool messages retain their status but have private content and execution
metadata removed by Core's projection.

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
target Agent's own assistant turns include resolved reasoning. The live
observation coordinator is unchanged.

Both `content` and `metadata.llmReasoning` are declared content fields. New
writes adopt and track both paths; resolved reads can load reasoning from
existing records without rewriting them. Existing records gain the additional
graph references when their projections are rebuilt; changing the declaration
does not itself rewrite stored Events.
