# Chapter 7: Native Skills

> **Part 3 — Skills: Taming Tool Sprawl**

## The pain

Skills solve the context bloat problem, but now you need to write them. A well-crafted skill takes real effort: you need to think through the workflow, document the edge cases, choose the right tools, and iterate until the agent follows it reliably.

For one-off skills specific to your domain, that investment is worth it. But for common workflows — debugging code, reviewing a PR, browsing the web, analyzing data — you're writing something the community has already written better.

## The solution

Copilotz ships a library of native skills. These are production-tested playbooks for common agentic workflows, maintained as part of the framework. Load them the same way you load custom skills.

```typescript
import { createCopilotz } from "@copilotz/copilotz";

const copilotz = await createCopilotz({
  agents: [
    {
      id: "dev-assistant",
      name: "Dev Assistant",
      role: "A software development assistant.",
      llmOptions: {
        provider: "openai",
        model: "gpt-4o",
      },
      allowedSkills: [
        "review-copilotz-project",
        "debug-runtime-issue",
        "init-copilotz-project",
      ],
    },
  ],
  resources: {
    preset: ["core", "code"],  // Loads code tools + native skills
  },
  security: {
    resolveLLMRuntimeConfig: async () => ({
      apiKey: Deno.env.get("OPENAI_API_KEY"),
    }),
  },
  dbConfig: { url: ":memory:" },
});

copilotz.start({ banner: "Dev assistant ready. What are we building?\n" });
```

Now ask the agent to review your code, debug a runtime error, or scaffold a new project — it loads the right playbook and follows a structured workflow.

## The native skill library

Copilotz ships skills in several categories:

### Development
| Skill | What it does |
|-------|-------------|
| `review-copilotz-project` | Audits a Copilotz project for correctness, patterns, and best practices |
| `debug-runtime-issue` | Reproduces, isolates, and verifies fixes for runtime bugs |
| `init-copilotz-project` | Scaffolds a new Copilotz project with correct file structure |
| `implement-feature` | Implements a feature following the project's conventions |

### Knowledge & Research
| Skill | What it does |
|-------|-------------|
| `search-web` | Searches for current information and synthesizes cited summaries |
| `ingest-knowledge` | Ingests documents into the knowledge base from various sources |

### Operations
| Skill | What it does |
|-------|-------------|
| `run-diagnostics` | Diagnoses system issues via terminal and logs |
| `manage-scheduled-jobs` | Creates, updates, and manages background jobs |

To see the full list of available skills at runtime, have your agent call `list_skills`.

## Using native skills alongside custom ones

Native and custom skills coexist. An agent can use both:

```typescript
{
  id: "assistant",
  allowedSkills: [
    // Native skills
    "debug-runtime-issue",
    "review-copilotz-project",
    // Custom skills (from your resources/ directory)
    "handle-customer-refund",
    "onboard-new-user",
  ],
}
```

The agent sees a unified list. It doesn't know or care which skills are native vs. custom.

## Extending a native skill

You can shadow a native skill with a custom one of the same name. Put a `SKILL.md` with the matching name in your `resources/skills/` directory and it takes precedence. Useful when you want to customize a native workflow for your domain:

```markdown
---
name: debug-runtime-issue
description: Debug runtime issues in our specific stack (Node.js + PostgreSQL + Redis).
allowed-tools: [read_file, search_files, run_command, persistent_terminal]
---

# Debug Runtime Issues

[Your extended workflow here, building on the native one's structure...]
```

## What this unlocks

- Expert workflows for common tasks, zero authoring required
- Skills maintained and improved by the Copilotz team
- Override any native skill with your own version
- A consistent interface for both custom and native capabilities

## What's next

Your `main.ts` file is growing. You have agents, tools, skills, MCP servers, API configs, and security setup — all in one place. This works for a prototype, but it's not how you want to maintain a real application. It's time to organize the code.

→ **[Chapter 8: The Resource System](../part-4-organizing/08-resource-system.md)**
