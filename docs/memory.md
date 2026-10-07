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
`long_term_memory` for checkpoints and memory records/spaces), the Actions and
Tools listed below, and the Processors that run consolidation. It requires Core;
runtime-only applications without Core and an agent cannot run it.

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
    // Bound for rendered semantic memory records in a context block (not the
    // whole prompt or the continuity summary). Library default.
    maxContentEstimatedTokens: 12000,
    // Candidate records retrieved per proposed fact during consolidation.
    // Library default; search_memory has its own limit input.
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
memory kinds, each fact's provenance and scope, and that the source range is
still certified. Valid facts, relations and the **ready** checkpoint commit
together. If the maintenance call fails or is cancelled, the checkpoint becomes
`failed` or `cancelled`. If source messages were edited or deleted after
reservation, certification fails and that maintenance doesn't apply. Source
messages are never modified.

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

`maxContentEstimatedTokens` bounds the rendered semantic records in each memory
context block. Writable memory and read-only peer memory (below) are rendered
separately from currently readable records and relations, each with its own
bound. The continuity summary is a separate contribution, so the setting is not
a cap on total memory text or on the prompt.

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
- **Search:** `search_memory` returns records from every memory space the caller
  can read, including spaces shared through explicit access and
  [Spaces](spaces.md) attachments. A stored fact is not necessarily private to
  one agent.
- **Shared peer memory:** when an explicit Space attachment gives a thread read
  access to a peer thread's memory space, its active records are added to
  prompts automatically as a read-only "shared space memory" block.
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
| `search_memory`         | Search readable memory records                                              |
| `consolidate_memory`    | Finish a maintenance turn, or consolidate on demand during an ordinary turn |
| `inspect_memory`        | Inspect a memory record and its relations                                   |
| `set_memory_status`     | Change a record's lifecycle status                                          |
| `list_knowledge_spaces` | List memory spaces the caller can read                                      |

Every alias must be granted explicitly in `capabilities.tools`. `search_memory`
has a separate `limit` input: it defaults to 20 and accepts up to 100 results.
`retrievalLimit` below configures consolidation candidate matching, not that
search limit.

| `resources.memory.config`     | Default | Meaning                                                                   |
| ----------------------------- | ------- | ------------------------------------------------------------------------- |
| `enabled`                     | `true`  | Automatic maintenance and memory prompt context; granted tools still work |
| `triggerEstimatedTokens`      | 20000   | Prepared history size that reserves a checkpoint                          |
| `retainRecentEstimatedTokens` | 0       | Recent history kept raw                                                   |
| `maxContentEstimatedTokens`   | 12000   | Bound on rendered semantic records per memory context block               |
| `retrievalLimit`              | 20      | Candidate records per proposed fact during consolidation                  |

Records use the forms `entity`, `assertion`, `occurrence`, `intent`, `inquiry`
and `procedure`. Custom kinds use `defineMemoryKind` and compose under
`resources.memory.kinds`.

**Vector retrieval (optional).** Supply an embedding function as
`adapters.memoryEmbedding.default` and declare
`resources.memory.embeddingProfile` with `model`, `revision`, `dimensions` and
`metric` (`cosine`, `l2` or `innerProduct`); the profile must describe the
vectors the adapter actually returns. The host provisions vector storage
explicitly with `provisionVectorStorage` from `@copilotz/copilotz/persistence`
after the base schema; PostgreSQL needs pgvector, and PGlite needs the `vector`
extension. Search uses exact distance ordering (no HNSW index), and profiles
never mix. Without an embedder, search uses a bounded lexical path; a configured
embedder that fails raises an error rather than falling back to lexical search.
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
