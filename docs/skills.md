# Skills

Skills are markdown files (`SKILL.md`) with YAML frontmatter that teach agents how to perform specific tasks. They follow the [Agent Skills](https://agentskills.io) open standard.

## SKILL.md Format

Each skill lives in its own directory with a `SKILL.md` file and an optional `references/` subdirectory:

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

| Field | Required | Description |
|-------|----------|-------------|
| `name` | No | Skill name. Falls back to directory name. |
| `description` | Yes | Short description shown in skill index. |
| `allowed-tools` | No | Tools the skill recommends or requires. |
| `tags` | No | Tags for categorization. |

Any extra frontmatter fields are preserved in `metadata`.

---

## Discovery & Precedence

Skills are discovered from multiple locations. When names collide, the first source wins:

1. **Project** — `resources/skills/` (relative to `resources.path`)
2. **Explicit** — URLs or inline definitions in `config.skills`
3. **User** — `~/.copilotz/skills/`
4. **Bundled** — Ships with the framework

This means project skills override bundled skills of the same name, letting you customize framework defaults.

---

## Progressive Disclosure

Skills use a 3-tier progressive disclosure model to minimize token usage:

1. **Advertise** — Only skill names and descriptions are injected into the system prompt (~15-30 tokens per skill)
2. **Load** — Full SKILL.md content is returned on-demand via `load_skill` tool
3. **Read Resources** — Supporting files from `references/` are read via `read_skill_resource` tool

This keeps system prompts lean while giving agents access to detailed instructions when needed.

---

## Configuration

### Loading Skills

Skills are loaded automatically when `resources.path` is set (from `resources/skills/`). For remote or inline skills, use the `skills` config option:

```typescript
const copilotz = await createCopilotz({
  resources: { path: "./resources" },  // Loads resources/skills/ automatically
  
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
  allowedSkills: ["create-agent", "create-tool"],  // Only these two
  // ...
}, {
  id: "assistant",
  name: "Assistant",
  allowedSkills: null,  // No skills
  // ...
}, {
  id: "admin",
  name: "Admin",
  // allowedSkills: undefined  // All skills (default)
  // ...
}]
```

| Value | Behavior |
|-------|----------|
| `undefined` (default) | Agent sees all skills |
| `string[]` | Agent sees only named skills |
| `null` | Agent sees no skills |

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

Reads a file from a skill's `references/` directory. Only works for local skills.

```json
{ "skill": "create-agent", "path": "example-config.ts" }

// Returns
{ "skill": "create-agent", "path": "example-config.ts", "content": "..." }
```

---

## Admin Agent

Copilotz ships with a bundled admin agent — a framework development assistant that uses skills to help you build agents, tools, APIs, and other resources. Enable it with `admin: true`:

```typescript
const copilotz = await createCopilotz({
  admin: true,
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

The admin agent is added alongside your existing agents. It has access to all skills and file tools (`list_skills`, `load_skill`, `read_skill_resource`, `read_file`, `write_file`, `list_directory`, `search_files`).

### Custom Admin Config

Override the admin agent's name or LLM options:

```typescript
admin: {
  name: "dev-assistant",
  llmOptions: { provider: "anthropic", model: "claude-sonnet-4-5-20241022" },
}
```

If you define an agent with the same ID as the admin agent, your definition takes precedence.

---

## Bundled Skills

Copilotz ships with 8 framework development skills:

| Skill | Description |
|-------|-------------|
| `create-agent` | Scaffold a new agent with instructions.md and config.ts |
| `create-tool` | Create a custom tool with config.ts and execute.ts |
| `add-api-integration` | Add an OpenAPI integration |
| `setup-collection` | Define a typed collection with schema and indexes |
| `configure-rag` | Enable RAG with embeddings for an agent |
| `add-processor` | Create a custom event processor |
| `configure-mcp` | Add an MCP server integration |
| `multi-agent-setup` | Configure multi-agent communication |

Override any bundled skill by creating a skill with the same name in your project's `resources/skills/` directory.

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

\`\`\`typescript
// resources/my-resource/config.ts
export default {
  // ...
};
\`\`\`
```

3. The skill is automatically discovered on the next request when `resources.path` is configured.

---

## Next Steps

- [Configuration](./configuration.md) — Full `skills` and `admin` config options
- [Loaders](./loaders.md) — Resource directory structure
- [Tools](./tools.md) — Native tools reference
