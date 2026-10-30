# Memory and chat history

Built 2026-10-27/28. Two references: the last Copilotz's memory plugin (checkpoints with a
"continuity" summary, notes with scopes, `remember`/`search`), and Taelin's optchat ("the chat
itself is the memory": a binary tree of one-line summaries, a view, `zoom`). They answer different
questions, so Copilotz has both:

|            | Chat history (`history` plugin)                          | Memory (`memory` plugin)                                                       |
| ---------- | -------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Question   | What happened in this conversation?                      | What do we know, across conversations?                                         |
| Kept as    | Every message, whole; summary lines over them            | Statements about a person, the agent, a thread, everyone                       |
| Found by   | The outline in the prompt, then `zoom` (exact, lossless) | Core ones always in mind; relevant ones each turn; `recall` (semantic + words) |
| Written by | A cheap summarizer, in the background                    | Agents (`remember`), and an extractor every few messages                       |

## Chat history

After optchat, adapted to many threads, many agents and forks:

- **Tree.** Each shared message gets a line (`summary`, level 0) of at most 512 bytes: the message
  itself when short, else written by the summarizer with the lines before it as context. Each pair
  it completes merges into its parent (joined when short, else written). Optchat's compaction
  prompt, ruler, "too long" retry and final cut.
- **Outline.** Per thread: which lines are shown, and where whole messages start. The tail of whole
  messages grows to 48 KB, then its oldest become lines down to 16 KB; the lines grow to 128 KB,
  then the most due pairs merge down to 64 KB (due = how long ago a pair ended, in its own size:
  optchat's rule, which matches Taelin's rollback push). Batches keep the prompt's prefix stable
  between them.
- **Views.** The `history` View sends the lines (`summary` View: `id+n|text`) as one block, then the
  whole messages; the newest message is always whole. Agents' private tool steps older than the tail
  aren't summarized: the block's header tells agents to say what they learned in their replies.
- **`zoom(id, n)`** opens a line into the two it was made from, or a message whole.
- **Cost.** Off unless configured. A thread is marked `outlined` the first time, so no other thread
  ever reads an outline: an agent exchange stays at 6 statements on Postgres.
- **Later.** A fork with summaries of its own drops its parent's part; forks could share the
  parent's nodes that end before the fork point.

## Memory

- **A memory** is one self-contained sentence `about` a person (`person:ana`), the agent itself
  (`agent:lead`), one thread, or `everyone`; `core` marks what to always have in mind. It has an
  `embedding` vector field (the runtime's vectors: pgvector on Postgres), so `nearest` finds similar
  ones; without an embedder, recall matches words.
- **Who can read what.** An agent in a thread reads memories about the people in it, itself, the
  thread, and everyone. A memory about Bob never reaches a conversation without Bob.
- **In every prompt:**
  - in the system text (stable, cached): how to use memory, then the core memories about who's here;
  - after the conversation, each turn: the other memories most relevant to what was last said to the
    agent (embedded once, by a query, while the prompt renders).
- **Tools, offered to every agent** (or `agents`): `remember` (one statement; a near-duplicate about
  the same subject, similarity ≥ 0.9, is updated, keeping what it said; an id corrects a specific
  one), `recall` (semantic + words), `forget` (out of sight, kept for the record).
- **Extraction.** With `extractor`, every 8 shared messages a cheap model reads them with what's
  already known and writes down what's worth keeping: who people are, preferences, decisions and
  commitments; core only for identity and lasting preferences. Same dedupe, so corrections update.
- **Live check** (gpt-5.4-mini, text-embedding-3-small): an agent remembered unprompted, recalled in
  a new conversation, and the turn context surfaced the dog's name before any tool call; the
  extractor kept three facts, skipped small talk, and turned a correction into an update.
- **Later.** Memory consolidation (merging related memories into one), importance and decay, memory
  per tenant/user identity once Copilotz has identities, and an HNSW index for large stores.
