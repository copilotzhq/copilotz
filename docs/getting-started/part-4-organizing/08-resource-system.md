# Chapter 8: The Resource System

> **Part 4 — Organizing Your Code**

## The pain

Your `main.ts` started as 20 lines. After adding tools, skills, MCP servers, an API integration, and security config, it's 200 lines and growing. Every new agent, every new tool, every new skill means editing the same file.

There's no clear separation between concerns. Your agent definitions are mixed with your tool implementations. Adding a tool for one agent risks breaking another. Sharing a tool across projects means copy-pasting.

This is the "big ball of mud" problem. It doesn't have a clever solution — it has an obvious one: separate the code into files.

## The solution

Copilotz uses a **file-based resource system** inspired by Next.js's file-based routing. You organize your agents, tools, skills, and other resources into a directory structure, and the framework auto-discovers and loads them at startup.

Create a `resources/` directory. The framework reads it. No manual registration.

## The directory structure

```
my-app/
├── main.ts                         # Entry point — just createCopilotz + start
├── deno.json
└── resources/
    ├── agents/
    │   ├── assistant/
    │   │   ├── config.ts           # Agent metadata and LLM options
    │   │   └── instructions.md     # Behavioral instructions (markdown)
    │   └── analyst/
    │       ├── config.ts
    │       └── instructions.md
    ├── tools/
    │   ├── get_weather/
    │   │   └── index.ts            # Tool definition + execute function
    │   └── lookup_customer/
    │       └── index.ts
    └── skills/
        ├── handle-refund/
        │   └── SKILL.md
        └── onboard-user/
            └── SKILL.md
```

And your `main.ts` becomes:

```typescript
import { createCopilotz } from "@copilotz/copilotz";

const copilotz = await createCopilotz({
  resources: {
    path: "./resources",  // Copilotz auto-discovers everything inside
  },
  security: {
    resolveLLMRuntimeConfig: async ({ provider }) => ({
      apiKey: Deno.env.get(`${provider.toUpperCase()}_API_KEY`),
    }),
  },
  dbConfig: { url: ":memory:" },
});

copilotz.start();
```

That's it. The framework handles the rest.

## What each file exports

### `resources/agents/{id}/config.ts`

```typescript
export default {
  role: "A customer support specialist.",
  personality: "Empathetic, clear, solution-focused.",
  description: "Handles billing inquiries and account issues.",
  llmOptions: {
    provider: "openai",
    model: "gpt-4o-mini",
    temperature: 0.5,
  },
  allowedTools: ["lookup_customer", "update_ticket", "http_request"],
  allowedSkills: ["handle-refund", "escalate-issue"],
};
```

The agent's `id` comes from the directory name — `resources/agents/support-agent/` → `id: "support-agent"`.

### `resources/agents/{id}/instructions.md`

```markdown
# Support Agent Instructions

You are a support specialist for Acme Corp.

## Your responsibilities
- Help customers with billing questions
- Process refund requests within policy
- Escalate to human agents when needed

## Tone
Always be warm, patient, and solution-focused. Never make promises you can't keep.

## What you cannot do
- Issue refunds above $500 without manager approval
- Access accounts not belonging to the user you're speaking with
```

Copilotz merges `config.ts` and `instructions.md` automatically. The directory name becomes the `id`.

### `resources/tools/{key}/index.ts`

```typescript
export default {
  key: "lookup_customer",
  name: "Lookup Customer",
  description: "Find a customer account by email address. Use when the user references their account or needs account-specific information.",
  inputSchema: {
    type: "object",
    properties: {
      email: { type: "string", description: "Customer email address" },
    },
    required: ["email"],
  },
  execute: async ({ email }: { email: string }) => {
    // Your actual implementation
    const response = await fetch(`https://api.myapp.com/customers?email=${email}`, {
      headers: { Authorization: `Bearer ${Deno.env.get("API_KEY")}` },
    });
    return await response.json();
  },
};
```

### `resources/skills/{name}/SKILL.md`

Same format as Chapter 6 — frontmatter + markdown.

## Everything is a resource

Agents, tools, and skills are the most common resources, but the system supports more:

| Directory | Resource type | Purpose |
|-----------|--------------|---------|
| `resources/agents/` | Agents | Agent definitions and instructions |
| `resources/tools/` | Tools | Custom tool implementations |
| `resources/skills/` | Skills | SKILL.md playbooks |
| `resources/processors/` | Processors | Custom event processors (Chapter 9) |
| `resources/channels/` | Channels | Custom ingress/egress adapters (Chapter 15) |
| `resources/llm/` | LLM providers | Custom LLM integrations (Chapter 18) |
| `resources/collections/` | Collections | Custom data collections (Chapter 19) |
| `resources/memory/` | Memory resources | Custom memory implementations |
| `resources/storage/` | Storage adapters | File/asset storage backends |

**In Copilotz, everything is a resource.** Every extension point — whether you're adding a new agent, a new LLM provider, or a custom event processor — follows the same file-based pattern. Learn it once, apply it everywhere.

## Mixing file-based and inline resources

Resources from the filesystem and resources in `createCopilotz()` config merge seamlessly. File-based resources load first; inline config overrides:

```typescript
const copilotz = await createCopilotz({
  resources: {
    path: "./resources",            // Load everything from filesystem
    preset: ["rag"],                // Also load the RAG preset
    imports: ["tools.http_request"], // Also load a specific native tool
  },
  agents: [
    {
      id: "admin",                  // This agent is defined inline, not in resources/
      name: "Admin",
      role: "Internal admin agent",
      llmOptions: { provider: "openai", model: "gpt-4o" },
    },
  ],
  // ...
});
```

## Selective loading with `imports`

To avoid loading all resources in a directory, use `imports` to name specific ones:

```typescript
resources: {
  path: "./resources",
  imports: [
    "agents.support-agent",       // Load only the support-agent
    "tools.lookup_customer",      // Load only this tool
    "tools",                      // Load ALL tools
    "skills",                     // Load ALL skills
  ],
}
```

## Hot reloading in development

Enable `watch` to reload resources when files change (development only):

```typescript
resources: {
  path: "./resources",
  watch: true,
}
```

## What this unlocks

- Clean separation of concerns — one file per agent, tool, and skill
- No manual registration — add a file, get a resource
- Shareable resource packages — publish to JSR and import remotely
- A consistent mental model: everything is a resource

## What's next

Now that the code is clean and organized, let's go deeper into the runtime. You've added tools and watched them execute — but what actually happens between "the LLM calls a tool" and "the tool runs"? And more importantly: can you intercept that moment?

→ **[Chapter 9: Custom Processors](../part-5-runtime/09-custom-processors.md)**
