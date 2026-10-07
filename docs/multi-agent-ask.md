---
title: "Multi-Agent Collaboration"
description: "Enroll agents in a thread, grant who may consult whom, and understand how Core's ask tool records questions, answers, private visibility, failures and continuations."
section: Agent Harness
order: 50
status: stable
---

# Multi-Agent Collaboration

## The pain

A writing assistant should get a release plan checked by a strict reviewer
before it answers. You can call a second model by hand inside the assistant's
turn, but then your application has to build everything else itself. Unless you
add your own recording, the review isn't a message from any identified
participant, nothing limits which agent may consult which, and the assistant has
no recorded way to wait for the answer and carry on. Unless you add your own
recovery, a crash between the two calls loses track of the review.

## The problem

Collaboration needs three separate contracts, and confusing them causes most
failed asks:

| Question                    | Where it's declared                                 |
| --------------------------- | --------------------------------------------------- |
| Does the specialist exist?  | The host composes it in `resources.agents`.         |
| May this agent consult it?  | The asking agent's own `capabilities.agents` grant. |
| Is it in this conversation? | Thread enrollment, through a message's recipients.  |

None of these implies another. Addressing `reviewer` in `recipientIds` enrolls
it and routes that message to it, but grants nothing. Granting `reviewer` to the
assistant doesn't enroll the reviewer in any thread. Core also needs a recorded
way to suspend the asking agent's turn, run the asked agent, and resume the
asker with the answer or with a failure.

## The solution

Core turns a non-empty `capabilities.agents` grant into the built-in `ask` tool.
There's no extra plugin, executor or orchestration API: `corePlugin` already
supplies the Action, the Tool and the Processors that continue the conversation.

### Declare and grant

This reuses the pure definitions from
[Chapter 12](./getting-started/part-3-add-agent-behavior/12-collaborate-with-specialists.md).
In `assistant.ts`, the `reviewer` declaration sits after `assistant`:

```ts
// The release reviewer: a specialist that critiques plans instead of writing
// them. Plain data like `assistant`, so tests can import it too.
export const reviewer = {
  // Stable Agent ID. `ask` targets and message recipients use this ID.
  id: "reviewer",
  // Name recorded for the reviewer's participant in the conversation.
  name: "reviewer",
  // A narrow purpose keeps the reviewer's answers focused.
  role:
    "A release reviewer that checks a plan for risks, gaps and missing steps, " +
    "and answers with a short list of concrete findings.",
  models: {
    // The same named connection and model as the assistant; the host supplies
    // the credential.
    generate: [{ connection: "openai", model: "gpt-5.4-mini" }],
  },
  // No application Tool, Agent or Skill grants. The reviewer works from the
  // question and the conversation context it's allowed to see.
  capabilities: { tools: [], agents: [], skills: [] },
} as const;
```

In `assistant.ts`, **append** `"reviewer"` to `assistant.capabilities.agents`.
Keep any agents already listed there, and leave `tools` and `skills` unchanged.
With no earlier agent grants, the list looks like this:

```ts
// Agents the assistant may consult through the `ask` tool.
agents: ["reviewer"],
```

Grants list **stable Agent IDs**: the `id` of each agent, not its `name` and not
its key in the composition map. The host module `agent.ts` composes both agents
under `agentResources.agents` as `{ assistant, reviewer }`. A grant only works
if an agent with that ID is composed. An omitted or empty list means the agent
can't ask anyone. A grant never merges capabilities: the reviewer's turn runs
with the reviewer's own (empty) grants, not the assistant's Notes tool.

### Enroll, then route

`collaborate.ts` in Chapter 12 enrolls both agents by addressing them together,
then addresses only the assistant:

```ts
// First message: both agents receive it, reply, and become participants.
recipientIds: ["assistant", "reviewer"],
```

```ts
// Later message: only the assistant replies; it may ask the enrolled reviewer.
recipientIds: ["assistant"],
```

The Core `message()` helper used by in-process hosts has only `recipientIds`, so
in-process enrollment happens by addressing an agent. The HTTP client's
conversation send additionally accepts `participantIds`, which enrolls agents
without addressing the message to them. Enrollment belongs to the thread, so a
new thread or a separate in-memory database starts without it.

### What happens on an `ask`

`ask` is an agent Tool call that Core manages. The Action needs the provenance
of a Core Tool plan: which agent, turn and tool call it belongs to. Invoking it
directly from host code or another Action is therefore not a shortcut for
creating an ask. Hosts start collaboration by addressing and enrolling agents
with ordinary messages, and the model decides when to ask.

The model calls the tool with a target, a complete question and an optional
mode:

```json
{
  "target": "reviewer",
  "message": "Check this release plan for risks: …",
  "mode": "private"
}
```

1. Core resolves `target` by stable agent ID first, then by name, and rejects an
   unknown or ambiguous target, a self-ask, an ungranted target, or a target
   that isn't a participant in the thread.
2. The Action atomically hands off the question as opaque work with
   `deferAction`. Its durable state is `copilotz.core.ask.deferred`; the worker
   is released while the Action remains open. Core's dispatcher records the
   question with the Ask ID, participants, mode, depth and originating tool
   call.
3. The asked agent runs an ordinary turn with its own models and grants. It may
   use tools and ask further agents. Inherited deliveries and nested Actions
   belong to that deferred invocation; explicitly detached work does not.
4. Once that work drains, the runtime invokes Core's resolver. Core finds the
   exact answer, or an explicit failure, and produces the ordinary
   `copilotz.core.ask.completed`, `.failed` or `.cancelled` terminal. The normal
   tool-plan path delivers the result and continues the asker.

The asking agent receives the answer through this continuation, independently of
what shared history shows. Several top-level tool calls produced in one model
step run as parallel branches. An `ask` branch settles when the asked agent's
final answer or failure is recorded. That answer comes after the asked agent's
own tool calls and nested asks within its turn. Work the asked agent's turn
starts in the background is not part of the branch. The asker continues once
every branch has settled.

### Public and private asks

| Mode               | Question and answer in shared history                          |
| ------------------ | -------------------------------------------------------------- |
| `public` (default) | Yes. The human and later turns of other participants see them. |
| `private`          | Only the asking and asked agents' participants.                |

A nested ask inside a private ask is always private. Questions raised inside a
Core-owned scoped task (such as memory maintenance) are recorded as internal
messages tied to that task's history scope rather than the shared thread.

Visibility governs participant history and prompts. It isn't an authorization
boundary for raw operation output. A trusted in-process host reading `app.send`
outputs or `app.observe`, and an operation owner observing the operation over
HTTP, receive the asked agent's answer stream bytes even in private mode. Hiding
those bytes in client JavaScript doesn't keep them off the network. End-user
views should read access-filtered thread history; if a user must never receive
private answers, don't give that user raw operation observation.

### Failure and settlement

- A rejected `ask` (unknown, ungranted, unenrolled target or self-ask) is a
  recorded Action failure. Core doesn't create threads or enroll agents on the
  fly.
- If the asked agent fails or is cancelled, Core records the failure and still
  resumes the asker with a labelled tool result (`AgentAskFailed` or
  `AbortError`), so the asker can explain or recover.
- Nesting is limited to depth 8. Each nested ask records a reference to its
  parent question, and resuming reloads that recorded parent instead of an
  in-memory stack. Pending asks can continue after a restart only with a
  persistent database and a worker that recovers it. The default in-memory
  database doesn't survive the process.
- `done` covers the operation's attached work, including asks that continue the
  conversation. It doesn't wait for detached work started from it, such as
  memory maintenance. As with any agent turn, inspect recorded model failures
  such as `llm.call.failed` separately; a settled operation doesn't prove a
  successful reply.
- The model decides whether to call `ask`. Core gives no guarantee about how
  many model calls a collaboration costs; a single ask typically adds at least
  the asked agent's call and the asker's resumed call.

There's no global speaker lock: each agent's output is its own stream, and Core
labels which agent produced it (read it with `coreStreamAgent`). Work that
shouldn't join any conversation belongs in a separate thread or workflow you
define, not a hidden ask.

### Testing collaboration without a provider

Tests import the pure `assistant` and `reviewer` definitions without changing
them. They replace the complete named entry in the test host's
`resources.llmConnections` with a scripted adapter, as
[Chapter 14](./getting-started/part-3-add-agent-behavior/14-test-agents-without-a-provider.md)
shows. Script the assistant's first call to emit an `ask` tool call and its
resumed call to read the answer, and assert on the recorded
`copilotz.core.ask.completed` Event and final messages, using fresh state per
scenario.

## What this unlocks

- Narrow specialists with their own models and grants, consulted by name instead
  of folded into one prompt.
- Delegation that's recorded and recoverable: identified questions, answers,
  provenance and failures, resumed from recorded state.
- Independent control over who exists, who may consult whom and who's in the
  conversation.
- Private consultations that stay out of participants' shared history, with a
  clear line between history visibility and raw-output authorization.

## Next steps

- Tutorial:
  [Chapter 12: Collaborate With Specialists](./getting-started/part-3-add-agent-behavior/12-collaborate-with-specialists.md)
- [Agent Capabilities](./agent-capabilities.md) for how tool, agent and Skill
  grants resolve.
- [Channels](./channels.md) and [Server](./server.md) for filtered history and
  operation observation over HTTP.
