# Message Collection

## What it is

The canonical content-bearing Message record.

## Why it exists

Conversation history and revisions require durable, asset-aware records.

## How to use it

Access `message` by ID or query it by Thread and creation order.

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
