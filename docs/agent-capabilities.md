---
title: "Agent Capabilities"
description: "Declare Agents as plain resources, grant tools, specialists and Skills by exact name, and understand which framework mechanisms Core and Skills derive from those grants."
section: Agent Harness
order: 30
status: stable
---

# Agent Capabilities

## The pain

One application often composes several packages: Notes, a billing API, a Skills
package, a few specialists. Each agent should use only part of that. When you
add the billing package, you need to know whether your notes assistant can now
call billing tools. When a specialist cannot use a tool its coordinator uses,
you need to know where to look.

If "installed" and "allowed" were the same thing, every new package would widen
every agent, and the only way to answer either question would be to read the
whole composition.

## The problem

An application needs a contract that keeps three questions separate:

| Question                  | Answered by                               |
| ------------------------- | ----------------------------------------- |
| Does the operation exist? | A plugin or host resource composes it     |
| How does a model see it?  | A Tool resource presents an Action        |
| May _this_ agent use it?  | The agent's `capabilities` grant, by name |

The contract also has to survive renaming a composition key, and it has to let
tests narrow an agent without undoing host wiring.

## The solution

### An Agent is a plain resource

An Agent is plain data with a stable `id`, a `name`, a `role`, ordered `models`
choices that name host connections, and optional `capabilities`. It holds no
credential and does no I/O, so tests and other compositions can import it. The
host registers it under `resources.agents`; Core resolves agents **by `id`**,
not by the key in that map, so renaming the composition key cannot change an
agent's identity or widen its access.

Other optional fields are `instructions`, `description`, `personality`,
`history: { maxAgeMs }` and `metadata`. `defineAgent` from
`@copilotz/copilotz/core` validates and freezes the same shape when you want an
early error; a plain `as const` object, as in the tutorials, is equally valid.

### Grants are exact, ordered and closed by default

`capabilities` has three optional lists:

| List     | Each entry names                                   |
| -------- | -------------------------------------------------- |
| `tools`  | a key of `resources.tools` (the Action alias)      |
| `agents` | another Agent's `id`                               |
| `skills` | a Skill's `name`, which equals its `SKILL.md` name |

An omitted list grants nothing, and an empty list grants nothing. Each entry
must be a non-empty, unique string that matches a composed resource; an unknown
name fails resolution with an error naming the agent and the grant. Declared
order is preserved. An agent never grants itself.

Nothing is inherited. A specialist reached through `agents` uses only its own
grants, and there is no global default list that installation extends.

These grants decide which tools Core shows a model and lets it call during an
agent turn. They do not authorize other callers: host code, Processors and HTTP
routes reach Actions through their own boundaries, described in
[Actions](./actions.md) and [Server](./server.md).

### A Tool presents an Action; it does not replace it

A Tool resource is data: the Action alias to run, a `name`, a `description`, the
Action's schemas and optional history visibility. When the model calls it, Core
invokes the composed Action under that alias, so validation, lifecycle Events
and operation keys are the same as for any other caller. Every Tool resource
must present the same alias it is registered under.

Three names are easy to confuse. For the Notes tool:

| Name          | Value        | Used by                           |
| ------------- | ------------ | --------------------------------- |
| Action ID     | `notes.save` | Events (`notes.save.completed`)   |
| Alias / grant | `saveNote`   | `resources.tools`, `capabilities` |
| Presentation  | `Save note`  | Shown to the model                |

Grants always use the alias.

### Derived mechanisms

Some tools are plumbing that a higher-level grant needs. The capability policy
adds them with grant source `derived`, after the explicit tools:

| Condition                                                                | Derived tool                | Installed by |
| ------------------------------------------------------------------------ | --------------------------- | ------------ |
| `readToolResult` is installed                                            | `readToolResult`            | `corePlugin` |
| At least one `agents` grant resolves                                     | `ask`                       | `corePlugin` |
| A granted Skill is read by Copilotz (packaged files or a file/HTTP root) | `list_skills`, `load_skill` | Skills       |
| Such a Skill has packaged supporting files, or is a file/HTTP root       | `read_skill_resource`       | Skills       |

A Skill defined from a file or HTTP root does not list its files up front; its
supporting paths are learned from `SKILL.md`, so the reader tool is always
derived for it. A Skill granted only as an external locator derives none of the
Skill reader tools; the agent needs a separately granted tool that can reach
that location.

`readToolResult` lets a model read back a bounded byte range of a large earlier
tool result, so an agent with `tools: []` can still see that one tool. If a
grant requires a mechanism that is not installed, resolution fails with
"required tool '…' is not installed" rather than quietly dropping the grant.
Granting a Skill never grants the tools its front matter lists in
`allowed-tools`; those stay descriptive.

### Dynamic resolution does not change grants

An agent's optional `dynamicResolve(context, execution)` may return effective
`instructions`, `models`, `history` and a small `revision` for one turn, based
on the durable participant, thread and trigger message. It must be deterministic
over those facts. It cannot return `capabilities`: what an agent may use is
static composition, reviewable in one place.

### Where each piece lives

| Role             | Example file     | Contains                                  |
| ---------------- | ---------------- | ----------------------------------------- |
| Definition       | `assistant.ts`   | The Agent and its grants; no env, no I/O  |
| Definition       | `notes-tools.ts` | Tool presentations and their plugin       |
| Host composition | `agent.ts`       | Credentials, connections, host tools, MCP |
| Entrypoint       | `chat.ts`        | Creates the app, sends, reads, closes     |

Resources that carry their own Action, such as the built-in
`getCurrentTimeToolResource`, install that Action under their alias when the
host composes them. A plugin's `plugins` list composes its dependencies, so
`notesToolsPlugin` brings `notesPlugin` and the `notes.save` Action with it.

### Worked example

This uses `notes-plugin.ts` from
[Chapter 5](./getting-started/part-1-design-and-build/05-package-a-plugin.md)
and `notes-tools.ts` from
[Chapter 9](./getting-started/part-3-add-agent-behavior/09-grant-tools.md),
which registers the `saveNote` Tool for the `notes.save` Action.

Here is the complete `assistant.ts` as it stands after Chapter 9. If you have
continued to Chapters 10–13, your file has more grants; keep them. Read this as
the baseline, not as a replacement.

```ts
// The Notes assistant: identity, purpose, model choices and grants.
// Plain data, so tests and other compositions can import it without side
// effects. `as const` infers readonly, literal types for every value.
export const assistant = {
  // Stable Agent ID. Core resolves grants and messages by this ID.
  id: "assistant",
  // Name recorded for the agent's participant in the conversation.
  name: "assistant",
  // The agent's purpose, which Core gives the model on every turn.
  role: "A notes assistant that helps the team capture and find notes.",
  // Guidance on when to use the granted tools.
  instructions:
    "When the user explicitly asks you to save or record a note, call the saveNote tool with the note text. When the user asks for the time or date, call the get_current_time tool. Do not save notes the user did not ask for.",
  models: {
    // Ordered choices; `connection` names an entry the host supplies.
    generate: [{ connection: "openai", model: "gpt-5.4-mini" }],
  },
  capabilities: {
    // Aliases from `resources.tools`: the Notes tool and the host's clock.
    tools: ["saveNote", "get_current_time"],
    // No specialists, so Core derives no `ask` tool.
    agents: [],
    // No Skills, so no Skill reader tools are derived.
    skills: [],
  },
} as const;
```

The file imports nothing and reads no environment. `agent.ts` decides that
`get_current_time` exists and which credential reaches `openai`; this file only
decides that the assistant may use them. With `corePlugin` composed, the
resolved tool list is `saveNote` and `get_current_time` (explicit), then
`readToolResult` (derived).

### Narrowing in tests

A test composes its own boundary from definitions. It replaces the whole
`capabilities` object with exactly the grants its registered resources satisfy.
Create `test-policy.ts`, a pure definition that tests import:

```ts
// The production assistant definition; pure, so safe to import in tests.
import { assistant } from "./assistant.ts";

// The assistant, narrowed to the one tool a Notes test composes. Spreading
// replaces `capabilities` wholesale, so no grant for an uncomposed resource
// (such as `get_current_time`, specialists or Skills) survives to fail
// resolution.
export const testAssistant = {
  ...assistant,
  capabilities: { tools: ["saveNote"] },
} as const;
```

This does not undo host I/O: tests never import `agent.ts` in the first place,
and they also replace the whole connection entry with a scripted one.
[Chapter 14](./getting-started/part-3-add-agent-behavior/14-test-agents-without-a-provider.md)
shows the complete scripted test.

## Reference

The capability policy a turn actually uses is the composed
`resources.capabilities.default` resource. Core installs its own
`agentCapabilities` there, and the Skills plugin replaces it with a policy that
calls Core's and adds the Skill reader mechanisms. Its
`resolve({ agent }, { resources, actions })` returns
`{ agent, tools, agents, skills }`; each entry is `{ id, resource, grant }`,
where `grant` is `"explicit"` or `"derived"`.

Calling the imported `agentCapabilities` directly gives Core's view only,
without Skills or any custom policy. A trusted host that builds inspection views
should resolve through the composed `capabilities.default` resource.

Core needs only a Skill's stable `name` to resolve a grant, so its types
describe resolved Skill entries by `name`. The entries are the composed Skill
resources themselves; their description, files and `read` are owned and
interpreted by the Skills plugin.

## What this unlocks

- Install many plugins without widening any existing agent.
- Review each agent's authority in one pure file.
- Present any validated Action to models without duplicating its logic.
- Add specialists and Skills, with their plumbing derived and checked.
- Narrow agents in tests without touching host credentials or live services.

## Next steps

- [Chapter 9: Grant Tools](./getting-started/part-3-add-agent-behavior/09-grant-tools.md)
  walks through the first grant.
- [Integrations](./integrations.md) covers Tools generated from OpenAPI and MCP.
- [Multi-Agent Ask](./multi-agent-ask.md) explains the derived `ask` tool.
- [Skills](./skills.md) covers Skill resources and progressive disclosure.
