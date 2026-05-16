---
title: "Ch 6: Tool Sprawl & Custom Skills"
description: "Package tools into skills to cut context bloat and improve tool selection."
section: Getting Started
order: 60
status: stable
---

# Chapter 6: Tool Sprawl & Custom Skills

> **Part 3 — Skills: Taming Tool Sprawl**

## The pain

You've built a capable agent. It has native tools, an MCP server connected to GitHub, and an OpenAPI integration with your internal API. Combined, that's 50+ tools available.

Here's the problem: every tool's name, description, and input schema goes into the system prompt on every single call. At 50 tools, you're spending 3,000–5,000 tokens on tool descriptions before the conversation even starts. That's:

- **Higher cost** — you pay for those tokens every call, even when the tools aren't used
- **Worse performance** — research consistently shows LLMs make poorer tool selections when the choice set is too large
- **Slower responses** — more tokens in = more time to first token out
- **Wasted context window** — tokens used on irrelevant tool descriptions are tokens you can't use for conversation history

The counterintuitive truth: adding tools can make your agent dumber.

## The solution

**Skills** invert the relationship between agents and capabilities. Instead of loading everything upfront, skills are loaded on-demand — only when the agent decides it needs them.

A skill is a `SKILL.md` file: a markdown document with a frontmatter header describing the skill. The agent's base context stays lean. When the agent encounters a task that matches a skill, it loads the full instructions — tools, examples, and all — only for that interaction.

Think of it like a doctor who knows *about* every specialty but reaches for a specific playbook only when treating a relevant condition.

## Creating your first skill

Create a directory `resources/skills/search-and-summarize/SKILL.md`:

```markdown
---
name: search-and-summarize
description: Search the web for information on a topic, fetch relevant pages, and produce a cited summary. Use this when the user asks to research or investigate a topic.
allowed-tools: [http_request]
tags: [research, web, summarization]
---

# Search and Summarize

Use this skill when the user wants to research a topic, find current information, or get a summary of something from the web.

## Workflow

1. Identify 2–3 good URLs to check for the topic
2. Use `http_request` to fetch each page
3. Extract the key facts from each response
4. Synthesize a clear summary that cites sources

## Output format

Always end your summary with a **Sources** section listing the URLs you consulted.

## What to avoid

- Don't fabricate URLs — only fetch pages you have actual reason to believe exist
- Don't summarize more than 3 pages to keep responses concise
- If a page returns an error, skip it and note that in your response
```

Now register the skill and let the agent use it:

```typescript
import { createCopilotz } from "@copilotz/copilotz";

const copilotz = await createCopilotz({
  agents: [
    {
      id: "assistant",
      name: "Assistant",
      role: "A helpful assistant.",
      llmOptions: {
        provider: "openai",
        model: "gpt-4o",
      },
      allowedSkills: ["search-and-summarize"],  // Skills this agent can load
      // Note: allowedTools is NOT set — the skill controls which tools are active
    },
  ],
  resources: {
    path: "./resources",  // Auto-discovers skills/ subdirectory
    imports: ["tools.http_request"],
  },
  security: {
    resolveLLMRuntimeConfig: async () => ({
      apiKey: Deno.env.get("OPENAI_API_KEY"),
    }),
  },
  dbConfig: { url: ":memory:" },
});

copilotz.start();
```

When you ask the agent to research a topic, it loads `search-and-summarize`, gains access to `http_request`, and follows the structured workflow. For a simple greeting, none of that fires — the base context stays clean.

## How skills work

Copilotz registers two meta-tools when skills are enabled:

- **`list_skills`** — Returns a list of available skills with their names and descriptions
- **`load_skill`** — Loads a specific skill's full instructions into context

The agent calls `list_skills` to see what's available, then `load_skill` to pull in the instructions for the relevant skill. This happens in a single turn, transparently.

The `allowed-tools` frontmatter field tells the framework which tools to unlock when that skill is active. The agent can only use those tools while executing the skill's workflow.

## SKILL.md format reference

```markdown
---
name: skill-name                    # Required: unique identifier
description: When and why to use this skill. This is what the agent reads when deciding
             whether to load it. Be specific about trigger conditions.
allowed-tools: [tool_key_1, tool_key_2]   # Tools unlocked when skill is active
tags: [category, subcategory]       # Optional: for organization
---

# Skill Title

Brief intro paragraph.

## Goal
What success looks like.

## Workflow
Step-by-step numbered instructions.

## What to avoid
Common mistakes or guardrails.
```

## Controlling skill access

Like tools, skills are controlled by a whitelist:

```typescript
{
  id: "support-agent",
  allowedSkills: ["handle-refund", "escalate-ticket", "lookup-order"],
  // This agent can ONLY load these three skills
}
```

Set `allowedSkills: null` to disable skills entirely. Leave it `undefined` to allow all registered skills.

## When to use a skill vs. a tool

| Use a **tool** when | Use a **skill** when |
|--------------------|--------------------|
| The capability is always needed | The capability is situationally needed |
| It's a single, atomic action | It's a multi-step workflow |
| No special instructions needed | The agent needs a structured playbook |
| < 5 tools total | You have many tools and need to manage context |

## What this unlocks

- Keep the base system prompt lean regardless of how many tools you've registered
- Agents pull in expert workflows only when relevant
- Structured playbooks improve reliability on complex multi-step tasks
- Fine-grained per-skill tool access control

## What's next

Just like there are 27 native tools, there are native skills bundled with Copilotz — expert workflows for common tasks that you don't have to write.

→ **[Chapter 7: Native Skills](./07-native-skills.md)**
