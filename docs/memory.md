---
title: "Memory"
description: "Curated, provenance-aware long-term memory beside original conversation history: when consolidation starts, how it is bounded, who can read it and what it cannot promise."
section: Agent Harness
order: 60
status: stable
---

# Memory

## The pain

A support assistant has been talking with the same team for weeks. Every turn
replays the thread, so prompts keep growing, and the facts that matter, such as
"stand-ups are on Monday" or "keep notes under three lines", are buried among
small talk. Trimming old messages loses those facts. Summarizing them by hand
loses something else: nobody can tell which message a summary came from, who was
allowed to see it, or whether the summary replaced the original.

## The problem

Long conversations need a curated layer that is bounded, traceable and scoped,
and that never rewrites the original record:

- **When** does curation start, and how much history may one pass read without
  pushing the maintenance prompt itself past the model's input limit?
- **What** comes back into later prompts, and how much?
- **Who** may read a curated fact, given that its source messages had their own
  visibility?
- **Which** facts are trustworthy enough to replace raw history in a prompt?

Memory is also not the only layer beside history. Keep these apart:

| Layer      | Holds                                                                   |
| ---------- | ----------------------------------------------------------------------- |
| History    | Original messages with sender and visibility; never rewritten by Memory |
| **Memory** | Curated facts consolidated from a certified range of history            |
| Knowledge  | Indexed sources and embeddings for search ([Knowledge](knowledge.md))   |
| Spaces     | Owned content with explicit attachment rules ([Spaces](spaces.md))      |

## The solution

The **Memory plugin** (`memoryPlugin` from `@copilotz/copilotz/memory`) adds the
curated layer on top of Core. It contributes its own Collections (including
`long_term_memory` for checkpoints and immutable notes and memory spaces), the
Actions and Tools listed below, and the Processors that run consolidation. It
requires Core; runtime-only applications without Core and an agent cannot run
it.

### Compose it in the host

This is the Chapter 13 configuration of the harness host module `agent.ts`.
**Insert** the import after the existing `corePlugin` import:

```ts
// Curated long-term memory over Core conversations.
import { memoryPlugin } from "@copilotz/copilotz/memory";
```

**Append** `memoryPlugin` to the existing `agentPlugins` list (keep every plugin
already there), then **insert** this property into the `agentResources` object,
after `llmConnections`:

```ts
// Memory policy for every agent in this application.
memory: {
  config: {
    // On by default. false stops automatic maintenance and memory prompt
    // context; it does not revoke granted Memory tools.
    enabled: true,
    // Prepared ordinary history size (estimated tokens) that starts a
    // checkpoint. Library default.
    triggerEstimatedTokens: 20000,
    // Recent history kept raw outside the checkpoint. The library default is
    // 0; this application keeps about the latest exchange verbatim.
    retainRecentEstimatedTokens: 2000,
    // One shared allowance for continuity, own notes, peer notes and framing.
    maxContentEstimatedTokens: 12000,
    // Recent active candidates per own/peer group for prompt context.
    // search_memory has its own limit input.
    retrievalLimit: 20,
  },
},
```

Invalid or missing numbers fall back to the defaults, which are exported as
`DEFAULT_LONG_TERM_MEMORY_CONFIG`.

### Grant the tools in the agent definition

Installing the plugin grants nothing. In the pure `assistant.ts`, **append**
both aliases to the existing `capabilities.tools` list (after Chapter 9 the
result is shown here):

```ts
// Tools the assistant may call: Notes, the clock, and Memory.
tools: ["saveNote", "get_current_time", "search_memory", "consolidate_memory"],
```

This example grants both. `consolidate_memory` is required: it is how the
maintenance turn finishes, and without it no checkpoint becomes ready.
`search_memory` is optional; it only lets the agent retrieve stored memory.
Granting either alias without composing `memoryPlugin` fails composition because
the tool doesn't exist.

### When consolidation starts

There is no message-created Processor counting messages. On an **ordinary agent
turn**, Core prepares the history it is about to send and hands that prepared
history to Memory. Memory compares its estimated size with the agent's
`triggerEstimatedTokens`. Peer agent, human and tool messages in that prepared
history all count. Below the threshold the check does no extra database work. At
or above it, Memory can reserve a **pending** checkpoint when a bounded eligible
range is available; the ordinary turn continues. If that agent already has a
pending checkpoint in the thread, Memory reuses it instead of reserving another;
different agents or threads own separate work.

The configured trigger measures history only. The source of one checkpoint is
bounded separately against the model's total input:

1. For each model candidate, Core measures the full prompt prefix (instructions,
   context, tool schemas) and subtracts the candidate's output allowance (1000
   estimated tokens when the model doesn't configure one) from its input limit.
2. Using the largest remaining candidate budget, Memory subtracts its own
   maintenance instruction and source manifest, and selects a contiguous source
   range within what remains.
3. The most recent `retainRecentEstimatedTokens` stay raw. Eligible history that
   doesn't fit one bounded range remains raw tail for a later checkpoint.

These are estimates, not provider tokens. The trigger is not a hard context
limit: a low value doesn't guarantee the whole prompt fits, and a high one
doesn't stop Core from compacting a call that is about to be too large.

### How the scoped maintenance turn runs

Reserving a checkpoint records a `long_term_memory.created` Event. Memory's
Processor reacts by sending the owning agent an internal, scoped task. Its
immutable private root stores the bounded, authorized source snapshot **once**
(Message and Asset references, message snapshots and frozen context). Later LLM
and tool continuations, including restarts, carry only a small root Message ID
and digest rather than the snapshot again. Core prepares that source through its
ordinary history pipeline, so the maintenance turn shares the agent's
instructions, model selection, credentials, tool catalog and common prompt
prefix. A provider may cache that prefix; no cache hit is guaranteed.
Consolidation is a model turn on your connection and can incur model cost.

The agent finishes by calling `consolidate_memory`. That alias runs the Action
`copilotz.memory.consolidation.commit` (exported as
`CONSOLIDATE_MEMORY_ACTION_ID`), which validates the proposal: shape, permitted
source handles, active replacement/retirement targets, write permission, and
that the source range is still certified. Immutable notes, retirements,
continuity and the **ready** checkpoint commit together. Conflicts return
bounded feedback through the ordinary tool continuation so the agent can repair
the proposal. A failed proposal never advances the saved history boundary. If
the maintenance call fails or is cancelled, the checkpoint becomes `failed` or
`cancelled`. If source messages were edited or deleted after reservation,
certification fails and that maintenance doesn't apply. Source messages are
never modified.

A granted agent may also call `consolidate_memory` during an **ordinary** turn.
Memory then derives an on-demand checkpoint from Core's trusted tool provenance,
and the model continues after the tool result. This works even when `enabled` is
`false`. It is still not a host write API: a plain `app.send` or your own
Processor calling the Action lacks that provenance and produces no memory.

### Certified coverage and later prompts

Later turns of the owning agent receive the certified checkpoint's `continuity`
summary as context. It belongs to that agent in that thread, like saved
conversation messages: losing access to a peer's memory does not discard the
summary or restart history consolidation. It can retain peer information already
incorporated while access was granted. Future semantic-memory reads use current
permissions instead of a cached copy of peer records in the checkpoint.

Only certified coverage lets Core trim raw history. Certification requires
coverage that matches the agent, visibility scope, active branch and source
range, with a nonempty continuity summary. Uncertified checkpoints do not supply
a cutoff or cached semantic context. The first certified range starts at the
beginning of eligible history; later ranges continue after the previous
boundary. Certification proves source, visibility and provenance, not that the
model's claims are true.

`maxContentEstimatedTokens` is one allowance for continuity, own notes, peer
notes and framing. Continuity comes first. The plugin selects recent active
notes (own scope before peers), then renders the selection chronologically with
stable IDs. Notes that do not fit are omitted whole, with a disclosure and
`search_memory` available to retrieve them. It never clips a procedure or note.
An oversized continuity proposal must be repaired before it can commit. If the
configured allowance is reduced below an already saved summary, its continuity
is kept intact and no extra notes are added. The model's overall input budget
still applies; the new allowance governs future checkpoint writes.

### Plain notes and explicit corrections

The agent-facing write contract has three fields:

```json
{
  "continuity": "Release v2 is deployed. Next: verify invoice exports; Ana has not confirmed the VAT fix.",
  "remember": [
    {
      "text": "Ana requested VAT-inclusive invoice exports on 2026-10-04. Verification is still pending.",
      "replaces": ["old-note-id"],
      "sources": ["message:source-message-id"]
    }
  ],
  "retire": [
    { "id": "obsolete-note-id", "reason": "This assumption was disproved." }
  ]
}
```

`continuity` replaces the whole previously compacted prefix, including its
earlier summary. `remember` and `retire` are optional; `{continuity}` alone is
valid. Notes can contain prose, dates, uncertainty, attribution or multiline
procedures. The plugin does not infer typed entities, tasks, kinds, validity
windows or graph relations. Put structured business objects in application
collections.

Text and identity are immutable. To correct a note, create a new one with
`replaces`; the prior note is retired with a replacement link. Retirement hides
it from ordinary context and retains its audit. It is not physical erasure.
Completion usually warrants a replacement recording the result.

Exact text reuse applies only to active notes in the same writable space, with
no whitespace normalization, semantic deduplication or cross-space merging.
Optional validated sources are appended. A retired note is never reactivated.
The plugin chooses the checkpoint's default writable space; the model cannot
select another destination. Peer notes cannot be replaced or retired.

### Sources and audiences

Optional source handles come from the visible prepared history, frozen
application evidence, or a successful tool result received in the owning turn. A
tool result can be cited as `tool:["plan-id","call-id"]`, using the exact
`tool_plan_id` and `tool_call_id` from its result. Unknown or ambiguous handles
are rejected. Reasoning is not evidence. A note without sources has checkpoint
lineage, which is not proof of its claim.

A note is agent-authored output published to readers of its writable space.
Validating an authorized source pointer does not establish that it supports the
note, or prevent a model from paraphrasing private inputs. Configure Space
sharing accordingly; source access and write access are enforced independently.
Inspecting another originating agent/thread's note withholds source pointers
(`sourcesWithheld: true`) while retaining note text and lineage. A pointer never
grants access to the source body; its originating reader must enforce access.
Exact-text reuse across authors does not append the new author's private source
pointers to the original note.

Existing `long_term_memory` checkpoints, continuity, source references and saved
history boundaries stay in place. Newly written notes use `memory_note`. Old
`memory_record` graph rows remain stored but are not converted or returned by
the new note APIs. No memory data migration or re-embedding is performed.

### Background work, waits and errors

- The dispatch Processor is **detached**. A normal turn's `handle.done` settles
  without waiting for consolidation, and `app.close()` doesn't drain detached
  work. Completed consolidation needs a long-lived application or Worker that
  composes Core, `memoryPlugin` and the agent resources. Recovery after a
  restart additionally needs persistent storage and the same database, schema
  and namespace.
- Concurrent reservations for the same agent and thread compete for one
  checkpoint ID derived from the allocation head captured before preparation.
  The losing reservation joins the winner, even if their input budgets differ.
  An existing pending automatic checkpoint is reused; an on-demand semantic
  write does not block history maintenance. The boundary advances only when an
  automatic checkpoint becomes ready and certified.
- **Foreground compaction** is the exception: when a turn's formatted input
  would exceed the model's limit, Core may wait for certified progress and
  rebuild the request. The wait is cancellable. If another turn has already
  consumed the pending range, Memory refreshes the reservation for the remaining
  tail. Advancement follows message chronology, not opaque message IDs. A failed
  checkpoint, unavailable compaction, repeated reservations without progress or
  an indivisible oversized input end in an input-limit failure instead of
  silently dropping history.
- The checkpoint state update (a `long_term_memory.updated` Event with
  `data.record.status` `ready`) can be observed before
  `copilotz.memory.consolidation.commit.completed`, so neither Event alone shows
  the whole maintenance task has finished.

### Scope and sharing

- **Prompt context:** later turns of the same agent in the same thread use that
  agent's certified continuity for the active branch and visibility scope. Other
  agents in the thread don't receive it as their own checkpoint. Current memory
  grants control live semantic records, not ownership of this continuity.
- **Search:** `search_memory` returns notes from every memory space the caller
  can read, including spaces shared through explicit access and
  [Spaces](spaces.md) attachments. A stored fact is not necessarily private to
  one agent.
- **Shared peer memory:** when an explicit Space attachment gives a thread read
  access to a peer thread's memory space, its active notes join the same bounded
  memory contribution as read-only peer notes.
- **Access removal:** detaching, moving, archiving or removing a Space stops
  future peer-memory reads. Already incorporated conversation continuity stays
  available, including any peer information it summarized. This is retention of
  existing conversation context, not a grant to read new peer records.
- Beyond such explicit access, nothing is shared across all threads, tenants or
  namespaces.

Raw in-process observation (`app.observe`, operation streams) is trusted host
diagnostics and may include internal maintenance traffic; it is not a
participant view.

## Reference

| Tool alias              | Purpose                                                                     |
| ----------------------- | --------------------------------------------------------------------------- |
| `search_memory`         | Search readable active notes (or include retired audit)                     |
| `consolidate_memory`    | Finish a maintenance turn, or consolidate on demand during an ordinary turn |
| `inspect_memory`        | Inspect notes by ID with lineage and permitted source pointers              |
| `list_knowledge_spaces` | List memory spaces the caller can read                                      |

Every alias must be granted explicitly in `capabilities.tools`. `search_memory`
has a separate `limit` input: it defaults to 20 and accepts up to 100 results.
`retrievalLimit` below bounds prompt candidates per own/peer group, not the
search limit. `inspect_memory({ids})` accepts up to 100 IDs; inaccessible and
missing IDs both appear in `unavailableIds`. `invalidate_memory` and
`set_memory_status` are removed; use explicit retirement or replacement.

| `resources.memory.config`     | Default | Meaning                                                                   |
| ----------------------------- | ------- | ------------------------------------------------------------------------- |
| `enabled`                     | `true`  | Automatic maintenance and memory prompt context; granted tools still work |
| `triggerEstimatedTokens`      | 20000   | Prepared history size that reserves a checkpoint                          |
| `retainRecentEstimatedTokens` | 0       | Recent history kept raw                                                   |
| `maxContentEstimatedTokens`   | 12000   | Shared continuity, notes and framing allowance                            |
| `retrievalLimit`              | 20      | Recent active prompt candidates per own/peer group                        |

**Vector retrieval (optional).** Supply an embedding function as
`adapters.memoryEmbedding.default` and declare
`resources.memory.embeddingProfile` with `model`, `revision`, `dimensions` and
`metric` (`cosine`, `l2` or `innerProduct`); the profile must describe the
vectors the adapter actually returns. The host provisions vector storage
explicitly with `provisionVectorStorage` from `@copilotz/copilotz/persistence`
after the base schema; PostgreSQL needs pgvector, and PGlite needs the `vector`
extension. New notes are embedded in one batch only when an embedder is
configured. Exact reuse and retirements do not request embeddings. Search uses
exact distance ordering (no HNSW index), and profiles never mix. Without an
embedder, search uses a bounded lexical path; a configured embedder that fails
raises an error rather than falling back to lexical search.
[Knowledge](knowledge.md) has a separate embedding and retrieval implementation;
its adapter and storage configuration are not interchangeable with Memory's.

## What this unlocks

- Long threads whose prompts carry curated memory instead of an ever-growing
  replay, with source messages kept intact.
- Facts you can trace to a certified source range, stored in spaces with
  explicit access.
- One visible policy for when curation starts, how much it reads and how much
  returns to prompts.

## Next steps

- Tutorial:
  [Chapter 13: Remember Across Conversations](getting-started/part-3-add-agent-behavior/13-remember-across-conversations.md)
- [Agent capabilities](agent-capabilities.md) for grants.
- [Spaces](spaces.md) and [Knowledge](knowledge.md) for shared content and
  indexed sources.
- [Testing and inspection](testing-and-inspection.md) for scripted checks.
