# Skills

Skills are markdown files (`SKILL.md`) with YAML frontmatter that teach agents
how to perform specific tasks. They follow the
[Agent Skills](https://agentskills.io) open standard.

## SKILL.md Format

Each skill lives in its own directory with a `SKILL.md` file and an optional
`references/` subdirectory:

```
my-skill/
  SKILL.md            # Required — frontmatter + instructions
  references/         # Optional — supporting files (examples, templates)
    example.ts
    template.json
```

**SKILL.md structure:**

```markdown
---
name: my-skill
description: One-line description of what this skill does.
allowed-tools: [read_file, write_file]
tags: [framework, tool]
---

# My Skill

Step-by-step instructions the agent follows when this skill is loaded.

## Step 1

...
```

### Frontmatter Fields

| Field           | Required | Description                               |
| --------------- | -------- | ----------------------------------------- |
| `name`          | No       | Skill name. Falls back to directory name. |
| `description`   | Yes      | Short description shown in skill index.   |
| `allowed-tools` | No       | Tools the skill recommends or requires.   |
| `tags`          | No       | Tags for categorization.                  |

Any extra frontmatter fields are preserved in `metadata`.

---

## Discovery & Precedence

Skills are discovered from multiple locations. When names collide, the first
source wins:

1. **Project** — `resources/skills/` (relative to `resources.path`)
2. **Explicit** — URLs or inline definitions in `config.skills`
3. **User** — `~/.copilotz/skills/`
4. **Bundled** — Ships with the framework

This means project skills override bundled skills of the same name, letting you
customize framework defaults.

---

## Progressive Disclosure

Skills use a 3-tier progressive disclosure model to minimize token usage:

1. **Advertise** — Only skill names and descriptions are injected into the
   system prompt (~15-30 tokens per skill)
2. **Load** — Full SKILL.md content is returned on-demand via `load_skill` tool
3. **Read Resources** — Supporting files from `references/` are read via
   `read_skill_resource` tool

This keeps system prompts lean while giving agents access to detailed
instructions when needed.

---

## Configuration

### Loading Skills

Skills are loaded automatically when `resources.path` is set (from
`resources/skills/`). For remote or inline skills, use the `skills` config
option:

```typescript
const copilotz = await createCopilotz({
  resources: { path: "./resources" }, // Loads resources/skills/ automatically

  skills: [
    // Remote skill from URL
    "https://example.com/skills/my-skill/SKILL.md",

    // Inline skill
    {
      name: "custom-skill",
      description: "A custom inline skill.",
      content: "# Custom Skill\n\nInstructions here...",
    },
  ],
  // ...
});
```

### Filtering with allowedSkills

Control which skills an agent can see, mirroring the `allowedTools` pattern:

```typescript
agents: [{
  id: "builder",
  name: "Builder",
  allowedSkills: ["create-agent", "create-tool"], // Only these two
  // ...
}, {
  id: "assistant",
  name: "Assistant",
  allowedSkills: null, // No skills
  // ...
}, {
  id: "admin",
  name: "Admin",
  // allowedSkills: undefined  // All skills (default)
  // ...
}];
```

| Value                 | Behavior                     |
| --------------------- | ---------------------------- |
| `undefined` (default) | Agent sees all skills        |
| `string[]`            | Agent sees only named skills |
| `null`                | Agent sees no skills         |

---

## Native Tools

Three built-in tools power the skills system:

### list_skills

Lists available skills (filtered by the calling agent's `allowedSkills`).

```json
// No parameters required
{}

// Returns
{
  "skills": [
    { "name": "create-agent", "description": "...", "tags": [...], "hasReferences": true }
  ],
  "count": 8
}
```

### load_skill

Loads the full SKILL.md content for a named skill.

```json
{ "name": "create-agent" }

// Returns
{
  "name": "create-agent",
  "description": "...",
  "content": "# Create Agent\n\n...",
  "allowedTools": ["write_file"],
  "hasReferences": true
}
```

### read_skill_resource

Reads a file from a skill's `references/` directory. Only works for local
skills.

```json
{ "skill": "create-agent", "path": "example-config.ts" }

// Returns
{ "skill": "create-agent", "path": "example-config.ts", "content": "..." }
```

---

## Copilotz Agent

Copilotz ships with a bundled native assistant. It is meant to feel like a
practical teammate first, with strong built-in support for building, debugging,
and evolving Copilotz projects through the bundled skill catalog. Import it
explicitly with `resources.imports: ["agents.copilotz"]`:

```typescript
const copilotz = await createCopilotz({
  resources: {
    imports: ["agents.copilotz"],
  },
  agent: {
    llmOptions: { provider: "openai", model: "gpt-4o" },
  },
  agents: [{
    id: "assistant",
    name: "Assistant",
    role: "assistant",
    instructions: "You are a helpful assistant.",
    llmOptions: { provider: "openai", model: "gpt-4o" },
  }],
  dbConfig: { url: ":memory:" },
});
```

The Copilotz agent is added alongside your existing agents. It has access to all
skills and file tools (`list_skills`, `load_skill`, `read_skill_resource`,
`read_file`, `write_file`, `list_directory`, `search_files`).

### Overrides

Override the bundled agent defaults just like a normal agent:

```typescript
agent: {
  id: "dev-assistant",
  name: "Dev Assistant",
  llmOptions: { provider: "anthropic", model: "claude-sonnet-4-5-20241022" },
  allowedTools: ["persistent_terminal"],
  instructions: "Only use the terminal unless explicitly told otherwise.",
}
```

If you define an agent with the same ID, your definition takes precedence.

---

## Bundled Skills

Copilotz ships with 23 bundled skills organized into two families.

### Resource Implementation Skills

These map directly to the Copilotz resource model, so each first-class resource
type has a canonical implementation playbook.

| Skill                       | Description                                                 |
| --------------------------- | ----------------------------------------------------------- |
| `create-agent`              | Scaffold a new Copilotz agent with instructions and config  |
| `create-tool`               | Create a custom tool with config and execute files          |
| `create-feature`            | Add an app-facing backend feature action                    |
| `setup-collection`          | Define a typed collection with schema and indexes           |
| `add-processor`             | Create a custom event processor                             |
| `create-channel`            | Add a transport channel with ingress and egress adapters    |
| `create-llm-provider`       | Register a custom LLM provider adapter                      |
| `create-embedding-provider` | Register a custom embeddings provider adapter               |
| `create-storage-adapter`    | Add a custom asset storage backend                          |
| `add-api-integration`       | Add an OpenAPI-based external API integration               |
| `configure-mcp`             | Add an MCP server integration                               |
| `configure-rag`             | Enable RAG with ingestion and retrieval settings            |
| `multi-agent-setup`         | Configure multi-agent communication and routing             |
| `configure-chat-ui`         | Configure frontend chat UI conventions and chat config      |
| `advanced-chat-features`    | Implement advanced chat adapter behavior and special states |

### Execution Skills

These are execution-centered workflows. They help the assistant explore, decide,
and carry out real work across Copilotz primitives instead of only scaffolding
files.

| Skill                            | Description                                                                             |
| -------------------------------- | --------------------------------------------------------------------------------------- |
| `explore-codebase`               | Discover repo structure, entrypoints, architecture, and likely implementation targets   |
| `implement-feature`              | Turn a product request into the right set of Copilotz and app edits                     |
| `debug-runtime-issue`            | Reproduce, inspect, isolate, and verify runtime fixes                                   |
| `refactor-resource-architecture` | Move behavior to the right Copilotz primitive and reduce boundary confusion             |
| `integrate-external-service`     | Choose the right integration pattern for third-party services                           |
| `build-copilotz-system`          | Assemble a multi-resource Copilotz application or agent system                          |
| `review-copilotz-project`        | Review a Copilotz project for gaps, risks, and missing capabilities                     |
| `ship-chat-experience`           | Connect chat UI, adapters, backend features, and runtime behavior into one product flow |

Override any bundled skill by creating a skill with the same name in your
project's `resources/skills/` directory.

---

## Writing Custom Skills

1. Create a directory under `resources/skills/`:

```
resources/skills/my-workflow/
  SKILL.md
  references/
    template.ts
```

2. Write the SKILL.md with frontmatter and step-by-step instructions:

```markdown
---
name: my-workflow
description: Guide the agent through the custom workflow.
allowed-tools: [write_file, http_request]
tags: [workflow, custom]
---

# My Workflow

## Prerequisites

- A configured API key in environment

## Steps

1. First, check the current state by...
2. Then create the configuration file...
3. Finally, verify by...

## File Template

\`\`\`typescript // resources/my-resource/config.ts export default { // ... };
\`\`\`
```

3. The skill is automatically discovered on the next request when
   `resources.path` is configured.

---

## Next Steps

- [Configuration](./configuration.md) — Full `skills`, `agent`, and resource
  import config options
- [Loaders](./loaders.md) — Resource directory structure
- [Tools](./tools.md) — Native tools reference
