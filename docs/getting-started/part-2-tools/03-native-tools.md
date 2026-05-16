# Chapter 3: Native Tools

> **Part 2 — Tools: From Custom to Protocol**

## The pain

After writing a few custom tools, a pattern emerges: you're implementing the same things every project needs. An HTTP client. A web scraper. A file reader. A command runner. A search tool. Each one is a small but non-trivial piece of work — you have to handle timeouts, error formatting, response truncation, and making the description clear enough for the LLM to use it reliably.

This is boilerplate. And boilerplate is never as good as a well-maintained shared library.

## The solution

Copilotz ships 30 native tools, production-hardened and LLM-optimized. Add them to any agent with a single import declaration.

```typescript
import { createCopilotz } from "@copilotz/copilotz";

const copilotz = await createCopilotz({
  agents: [
    {
      id: "researcher",
      name: "Researcher",
      role: "A research assistant that can browse the web, read files, and run code.",
      llmOptions: {
        provider: "openai",
        model: "gpt-4o",
      },
      allowedTools: [
        "web_search",
        "fetch_text",
        "http_request",
        "read_file",
        "persistent_terminal",
        "get_current_time",
      ],
    },
  ],
  resources: {
    imports: [
      "tools.web_search",
      "tools.fetch_text",
      "tools.http_request",
      "tools.read_file",
      "tools.persistent_terminal",
      "tools.get_current_time",
    ],
  },
  security: {
    resolveLLMRuntimeConfig: async () => ({
      apiKey: Deno.env.get("OPENAI_API_KEY"),
    }),
  },
  dbConfig: { url: ":memory:" },
});

copilotz.start({ banner: "Research assistant ready.\n" });
```

## The native tool library

### Web & network

| Tool | What it does |
|------|-------------|
| `http_request` | Full HTTP client — GET, POST, PUT, PATCH, DELETE with headers, body, timeout, and response truncation. Best for API calls where you control the request precisely. |
| `fetch_text` | Fetches a URL and returns clean, parsed text. Supports regex extraction, line filtering, and content matching — designed for reading web pages, not raw API calls. |
| `web_search` | Searches the web via DuckDuckGo and returns titles, URLs, and snippets. **No API key required.** |

`fetch_text` and `http_request` solve different problems. `http_request` is your general-purpose API tool. `fetch_text` is for reading web pages — it handles HTML-to-text conversion, regex extraction, and content filtering, so the LLM sees meaningful text instead of raw markup.

`web_search` is notable because it works out of the box with no credentials — it scrapes DuckDuckGo results directly. For an agent that needs to look things up on the internet, it's the fastest path to capability.

```typescript
// web_search parameters
{
  query: string;        // Search query
  count?: number;       // Number of results (default 5, max 20)
  region?: string;      // e.g. "us-en", "uk-en"
  language?: string;    // e.g. "en"
  safeSearch?: "strict" | "moderate" | "off";
}
// Returns: { results: [{ title, url, snippet }] }

// fetch_text parameters
{
  url: string;
  timeout?: number;
  maxChars?: number;
  contains?: string;       // Only return content if it contains this string
  extractRegex?: string;   // Extract only text matching this regex
  extractRegexFlags?: string;
  extractGroup?: number | string;
  mode?: "full" | "first_match" | "all_matches" | "lines_matching";
}
```

### Filesystem

| Tool | What it does |
|------|-------------|
| `read_file` | Read a file's full contents |
| `write_file` | Write content to a file |
| `list_directory` | List files and directories, with optional depth control |
| `search_files` | Search file contents with pattern matching |
| `search_code` | Line-level code search with file pattern filtering, regex, and noise exclusion (node_modules, .git, dist excluded by default) |
| `apply_patch` | Apply text-anchored edits to a file. Takes a snapshot before applying — safe to undo. Uses text matching, not line numbers. |
| `show_file_diff` | Show a diff between the current file and a previously captured snapshot |
| `restore_file_version` | Restore a file from a previously captured snapshot |

`apply_patch` is the preferred tool for code editing. It takes text-anchored operations (`replace`, `insert_before`, `insert_after`) instead of line numbers, so patches stay valid even if surrounding lines change. It snapshots the file before applying — making `show_file_diff` and `restore_file_version` possible.

`search_code` vs `search_files`: `search_code` is purpose-built for source code — it excludes noise directories, supports file glob patterns (`*.ts`, `*.py`), returns line numbers, and outputs structured results. `search_files` is more general.

### Terminal

| Tool | What it does |
|------|-------------|
| `run_command` | Run a one-shot shell command and return stdout/stderr |
| `persistent_terminal` | Maintain a stateful terminal session across multiple tool calls |
| `wait` | Pause execution for a specified duration (0.1–60 seconds) |

`persistent_terminal` is the more capable option for complex workflows. It manages a long-running shell process and supports multiple actions:

```typescript
// persistent_terminal actions
{ action: "run", command: "npm install", timeout: 60 }     // Run a command in the session
{ action: "info" }                                          // Get session info and buffered output
{ action: "restart" }                                       // Restart the shell process
{ action: "close" }                                         // Close and clean up the session
{ action: "list" }                                          // List all active sessions
{ action: "upload_asset", assetRef: "asset://..." }         // Upload an asset into the session
{ action: "export_file", path: "./output.csv" }             // Export a file as an asset
```

This is essential for workflows like: start a dev server → make changes → run tests → inspect output, all within a single persistent shell context.

`wait` is useful when an agent needs to pause between steps — waiting for a server to start, a build to complete, or an async process to settle.

### Knowledge & RAG

| Tool | What it does |
|------|-------------|
| `search_knowledge` | Semantic similarity search over ingested documents |
| `ingest_document` | Add a document (URL, text, file, or asset) to the knowledge base |
| `delete_document` | Remove a document from the knowledge base |
| `list_knowledge_spaces` | List all knowledge space nodes in the current namespace |

### Memory

| Tool | What it does |
|------|-------------|
| `update_my_memory` | Let the agent persist notes about the current user or context to its memory |

### Assets

| Tool | What it does |
|------|-------------|
| `save_asset` | Save binary data (images, files) to the asset store |
| `fetch_asset` | Retrieve a previously saved asset by reference |

### Scheduling

| Tool | What it does |
|------|-------------|
| `scheduled_jobs` | Full lifecycle for background jobs: create, list, update, pause, resume, cancel, run_now |

`scheduled_jobs` lets agents schedule work to happen later — set up a cron job, trigger a one-time run at a specific time, or manage existing jobs. Actions map directly to job states.

### Multi-agent

| Tool | What it does |
|------|-------------|
| `delegate` | Delegate a task to another agent |
| `create_thread` | Create a new conversation thread |
| `end_thread` | Close an active thread |

### Skills

| Tool | What it does |
|------|-------------|
| `list_skills` | List available skills with their names and descriptions |
| `load_skill` | Load a skill's full instructions into context on demand |
| `read_skill_resource` | Read a skill's attached resource files (examples, references) |

### Utilities

| Tool | What it does |
|------|-------------|
| `get_current_time` | Return the current date and time in ISO format |
| `read_tool_result` | Fetch the full output of a truncated tool result by its event ID — useful when history was truncated and the agent needs to paginate through large outputs |

`read_tool_result` solves an important edge case: when a tool produces a very large output, Copilotz truncates it in the conversation history and leaves a `toolResultQueueEventId` marker. The agent calls `read_tool_result` with that ID to read the full output in pages.

## Loading tools

Tools are loaded via `resources.imports`. The pattern is `tools.<tool-key>`:

```typescript
resources: {
  imports: [
    "tools.web_search",
    "tools.fetch_text",
    "tools.http_request",
    "tools.read_file",
    "tools.write_file",
    "tools.search_code",
    "tools.apply_patch",
    "tools.persistent_terminal",
  ],
}
```

Or use a preset that bundles relevant groups:

```typescript
resources: {
  preset: ["core", "code"],  // core = basic infra, code = all file/terminal/code tools
}
```

## Mixing native and custom tools

Native and custom tools coexist seamlessly. Register both in the same config:

```typescript
const copilotz = await createCopilotz({
  agents: [
    {
      id: "assistant",
      allowedTools: ["web_search", "fetch_text", "get_weather", "get_current_time"],
    },
  ],
  tools: [getWeatherTool],          // Your custom tools
  resources: {
    imports: ["tools.web_search", "tools.fetch_text", "tools.get_current_time"],
  },
  // ...
});
```

The agent sees them all in a unified list. It doesn't know or care which is custom vs. native.

## A practical example: a web research assistant

```typescript
const copilotz = await createCopilotz({
  agents: [
    {
      id: "researcher",
      name: "Researcher",
      role: "A web research assistant.",
      instructions: `
        When researching a topic:
        1. Use web_search to find relevant sources
        2. Use fetch_text to read the most promising pages
        3. Synthesize a clear, cited summary

        Always include source URLs in your response.
      `,
      llmOptions: { provider: "openai", model: "gpt-4o" },
      allowedTools: ["web_search", "fetch_text"],
    },
  ],
  resources: {
    imports: ["tools.web_search", "tools.fetch_text"],
  },
  security: {
    resolveLLMRuntimeConfig: async () => ({
      apiKey: Deno.env.get("OPENAI_API_KEY"),
    }),
  },
  dbConfig: { url: ":memory:" },
});

copilotz.start({ banner: "Research assistant ready. Ask me anything.\n" });
```

This agent uses `web_search` to find sources and `fetch_text` to read their content — a tight, effective research loop with no API keys beyond the LLM itself.

## What this unlocks

- 30 production-ready tools available with a single import line
- No boilerplate — timeout handling, error formatting, and response truncation are built in
- `web_search` works with no external API key
- `persistent_terminal` maintains shell state across multiple tool calls
- `fetch_text` extracts clean readable text from any URL, with regex filtering
- `apply_patch` + `show_file_diff` + `restore_file_version` give agents safe, reversible file editing
- Mix and match freely with your own custom tools

## What's next

Native tools cover common operations, but real products talk to third-party services — Slack, GitHub, Notion, databases. Each one requires custom integration code. Unless there's a standard protocol for agent-to-tool communication — and there is.

→ **[Chapter 4: MCP Servers](./04-mcp-servers.md)**
