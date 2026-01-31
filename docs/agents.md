# Agents

Agents are the actors in your AI application. Each agent is a configured AI persona with its own instructions, model, tools, and permissions. Copilotz supports multi-agent systems where agents can communicate and collaborate.

## What is an Agent?

Think of an agent as a specialized team member:

- **A support agent** knows your product and helps customers
- **A research agent** searches documents and summarizes findings
- **An escalation agent** handles complex issues that require human-like judgment

Each agent has a role, capabilities, and boundaries.

## Basic Agent Configuration

```typescript
const agent = {
  id: "support-agent",           // Unique identifier
  name: "Support",               // Display name
  role: "assistant",             // "assistant", "system", or "user"
  instructions: `You are a customer support agent for Acme Corp.
    Be friendly, helpful, and concise.
    If you don't know something, say so.`,
  llmOptions: { 
    provider: "openai", 
    model: "gpt-4o-mini" 
  },
  allowedTools: ["search_knowledge", "create_ticket"],
};
```

### Required Fields

| Field | Description |
|-------|-------------|
| `id` | Unique identifier for the agent |
| `name` | Display name (used in conversations) |
| `role` | Usually "assistant" for AI agents |
| `llmOptions` | LLM provider and model configuration |

### Optional Fields

| Field | Description |
|-------|-------------|
| `instructions` | System prompt defining behavior |
| `allowedTools` | Tools this agent can use |
| `allowedAgents` | Other agents this agent can communicate with |
| `ragOptions` | Knowledge base configuration |

## LLM Configuration

### Static Configuration

```typescript
llmOptions: {
  provider: "openai",           // Provider name
  model: "gpt-4o-mini",        // Model name
  temperature: 0.7,             // Creativity (0-2)
  maxTokens: 4096,              // Max response length
  apiKey: "sk-...",             // Optional: override env variable
}
```

### Supported Providers

| Provider | Example Models |
|----------|----------------|
| `openai` | `gpt-4o`, `gpt-4o-mini` |
| `anthropic` | `claude-3-haiku-20240307`, `claude-3-opus-20240229` |
| `gemini` | `gemini-2.0-flash-lite-preview-02-05` |
| `groq` | `llama3-8b-8192`, `mixtral-8x7b-32768` |
| `deepseek` | `deepseek-chat` |
| `ollama` | `llama3.2`, `mistral` (local) |

### Dynamic Configuration

Resolve LLM options at runtime based on context:

```typescript
import type { AgentLlmOptionsResolver } from "@copilotz/copilotz";

const llmOptions: AgentLlmOptionsResolver = async ({ payload, context }) => {
  // Use a better model for complex queries
  const isComplex = payload.messages.length > 10;
  
  return {
    provider: "openai",
    model: isComplex ? "gpt-4o" : "gpt-4o-mini",
    temperature: 0.3,
  };
};

const agent = {
  id: "adaptive-agent",
  name: "Adaptive",
  llmOptions, // Function instead of object
  // ...
};
```

## Tool Permissions

Control which tools each agent can access:

```typescript
// Specific tools only
allowedTools: ["read_file", "search_knowledge"]

// All tools
allowedTools: ["*"]

// No tools
allowedTools: []
```

See [Tools](./tools.md) for the full list of native tools.

## Multi-Agent Systems

### Agent Communication

Agents can talk to each other using `@mentions`:

```typescript
const agents = [
  {
    id: "coordinator",
    name: "Coordinator",
    instructions: "You coordinate between specialized agents. Use @Researcher for facts.",
    allowedAgents: ["researcher", "writer"],
    // ...
  },
  {
    id: "researcher",
    name: "Researcher",
    instructions: "You find and verify information.",
    allowedTools: ["search_knowledge", "http_request"],
    // ...
  },
  {
    id: "writer",
    name: "Writer",
    instructions: "You write clear, engaging content.",
    // ...
  },
];
```

When the Coordinator says "@Researcher, what are the latest stats?", Copilotz routes the message to the Researcher agent.

### Ask Question Tool

Agents can programmatically ask questions to other agents:

```typescript
const agent = {
  id: "main-agent",
  allowedTools: ["ask_question"],
  allowedAgents: ["expert-agent"],
  // ...
};

// The agent can now call ask_question to get answers from expert-agent
```

The `ask_question` tool:
1. Creates a temporary thread
2. Sends the question to the target agent
3. Waits for the response
4. Returns the answer to the calling agent

## RAG Configuration

Configure how each agent interacts with the knowledge base:

```typescript
const agent = {
  id: "docs-agent",
  ragOptions: {
    mode: "auto",              // "auto", "tool", or "disabled"
    namespaces: ["docs", "faq"], // Which namespaces to search
    ingestNamespace: "docs",   // Where to store ingested docs
    autoInjectLimit: 4,        // Max chunks to inject (auto mode)
    entityExtraction: {
      enabled: true,
      namespace: "thread",     // "thread", "agent", or "global"
    },
  },
  // ...
};
```

### RAG Modes

| Mode | Behavior |
|------|----------|
| `auto` | Relevant chunks automatically injected into prompt |
| `tool` | Agent explicitly calls `search_knowledge` tool |
| `disabled` | No RAG for this agent |

## Multiple Agents Example

A complete multi-agent setup:

```typescript
import { createCopilotz } from "@copilotz/copilotz";

const copilotz = await createCopilotz({
  agents: [
    {
      id: "triage",
      name: "Triage",
      instructions: `You're the first point of contact.
        For technical questions, mention @Technical.
        For billing questions, mention @Billing.`,
      llmOptions: { provider: "openai", model: "gpt-4o-mini" },
      allowedAgents: ["technical", "billing"],
    },
    {
      id: "technical",
      name: "Technical",
      instructions: "You handle technical support questions.",
      llmOptions: { provider: "openai", model: "gpt-4o" }, // Better model
      allowedTools: ["search_knowledge", "read_file"],
      ragOptions: { mode: "auto", namespaces: ["tech-docs"] },
    },
    {
      id: "billing",
      name: "Billing",
      instructions: "You handle billing and account questions.",
      llmOptions: { provider: "openai", model: "gpt-4o-mini" },
      allowedTools: ["search_knowledge", "http_request"],
      ragOptions: { mode: "auto", namespaces: ["billing-faq"] },
    },
  ],
  dbConfig: { url: ":memory:" },
});
```

## Overriding Agents Per-Run

Override or extend agents for a specific run:

```typescript
await copilotz.run(message, onEvent, {
  agents: [
    {
      id: "support-agent",
      // Override just the instructions for this run
      instructions: "Today is a holiday. Be extra cheerful!",
    },
  ],
});
```

## Next Steps

- [Tools](./tools.md) — Configure tool access for agents
- [RAG](./rag.md) — Set up agent knowledge bases
- [Events](./events.md) — Understand how agent messages flow through the system
