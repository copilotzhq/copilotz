# API Reference

Complete reference for the Copilotz public API.

## Top-Level Exports

```typescript
import {
  clearSchemaCache,
  // Main factory
  createCopilotz,
  // Database utilities
  createDatabase,
  // Collections
  defineCollection,
  dropTenantSchema,
  // Skills
  filterSkillsForAgent,
  getNativeTools,
  index,
  // Resource utilities
  listPublicAgents,
  listTenantSchemas,
  // Resource loading
  loadResources,
  mergeResourceArrays,
  provisionTenantSchema,
  // Event processing
  relation,
  // Utilities
  resolveNamespace,
  schemaExists,
  warmSchemaCache,
  // Schema management
  withSchema,
} from "@copilotz/copilotz";

// Types
import type {
  Copilotz,
  Resources,
  Skill,
  SkillIndexEntry,
} from "@copilotz/copilotz";
```

---

## createCopilotz

Creates a new Copilotz instance.

```typescript
const copilotz = await createCopilotz(config: CopilotzConfig): Promise<Copilotz>
```

See [Configuration](./configuration.md) for full `CopilotzConfig` options.

---

## Copilotz Instance

### copilotz.run()

Run an agent conversation.

```typescript
const result = await copilotz.run(
  message: MessageInput,
  options?: RunOptions
): Promise<RunHandle>
```

**Parameters:**

| Name      | Type           | Description                      |
| --------- | -------------- | -------------------------------- |
| `message` | `MessageInput` | The message to process           |
| `options` | `RunOptions`   | Optional run configuration       |

**MessageInput:**

```typescript
{
  content: string;
  sender: { type: "user" | "assistant" | "system"; name: string };
  target?: string;          // Explicit routing target
  targetQueue?: string[];   // Follow-up routing queue
  threadId?: string;        // Existing thread or auto-created
  metadata?: Record<string, any>;
  attachments?: Attachment[];
}
```

**RunOptions:**

```typescript
{
  stream?: boolean;         // Enable token streaming
  ackMode?: "immediate" | "onComplete";
  signal?: AbortSignal;     // For cancellation
  queueTTL?: number;        // TTL for events (ms)
  namespace?: string;       // Override namespace
  schema?: string;          // Override schema
  agents?: Partial<Agent>[];  // Override agents
  tools?: Tool[];           // Override tools
}
```

**RunHandle:**

```typescript
{
  events: AsyncIterable<StreamEvent>; // Event stream
  done: Promise<void>; // Completion promise
  threadId: string; // Thread ID
}
```

**Example:**

```typescript
const result = await copilotz.run(
  { content: "Hello!", sender: { type: "user", name: "Alex" } },
  (event) => console.log(event.type),
  { stream: true },
);

for await (const event of result.events) {
  if (event.type === "TOKEN") {
    process.stdout.write(event.payload.token);
  } else if (event.type === "TOOL_RESULT" || event.type === "LLM_RESULT") {
    console.log("Lifecycle event:", event.type, event.payload);
  }
}

await result.done;
```

---

### copilotz.start()

Start an interactive REPL session. Prompts for user input, streams responses to
stdout, and maintains conversation state.

```typescript
const session = copilotz.start(
  initialMessage?: string | StartOptions
): SessionHandle
```

**StartOptions:**

```typescript
{
  content?: string;                    // Initial message to send
  banner?: string | null;              // Banner to display on start
  quitCommand?: string;                // Command to exit (default: "quit")
  threadExternalId?: string;           // Thread identifier for persistence
  sender?: {                           // Sender info for messages
    type: "user" | "assistant" | "system";
    name: string;
    externalId?: string;
    metadata?: Record<string, any>;
  };
  thread?: {
    externalId?: string;
    participants?: string[];
  };
}
```

**SessionHandle:**

```typescript
{
  stop: () => void;          // Stop the session
  closed: Promise<void>;     // Resolves when session ends
}
```

**Example:**

```typescript
// Simple usage with string message
copilotz.start("Hello, introduce yourself!");

// Full options
const session = copilotz.start({
  banner: "🤖 Welcome to the AI assistant!\n",
  quitCommand: "exit",
  sender: { type: "user", name: "Alex" },
  content: "Hello!",
});

// Stop programmatically
setTimeout(() => session.stop(), 60000);

// Wait for session to end
await session.closed;
```

**Behavior:**

1. Displays the banner (if provided)
2. Sends the initial message (if provided)
3. Enters a prompt loop (`Message:`)
4. Streams responses to stdout in real-time
5. Exits when user types the quit command or `stop()` is called

---

### copilotz.shutdown()

Gracefully shutdown the Copilotz instance.

```typescript
await copilotz.shutdown(): Promise<void>
```

---

### copilotz.ops

Database operations API.

#### Raw Query

```typescript
await copilotz.ops.query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>
```

Execute arbitrary SQL against the database. Primarily used by features that need direct data access (e.g., the admin feature uses this for aggregation queries).

#### Thread Operations

```typescript
// Find or create a thread
await copilotz.ops.findOrCreateThread(
  threadId?: string,
  data?: { metadata?: Record<string, any>; externalId?: string }
): Promise<Thread>

// Get thread by ID
await copilotz.ops.getThreadById(id: string): Promise<Thread | null>

// Get thread by external ID
await copilotz.ops.getThreadByExternalId(externalId: string): Promise<Thread | null>

// Get threads for a participant
await copilotz.ops.getThreadsForParticipant(
  participantId: string,
  options?: { limit?: number; offset?: number }
): Promise<Thread[]>

// Archive a thread
await copilotz.ops.archiveThread(threadId: string, summary: string): Promise<void>
```

#### Message operations (graph-backed)

Messages persist as **`nodes` with `type: "message"`** (plus edges). Prefer graph APIs:

```typescript
// Message history (ordered from graph)
await copilotz.ops.getMessageHistoryFromGraph(
  threadId: string,
  limit?: number
): Promise<Message[]>

// Optional: includes parent threads when the user is in participants (still reads graph nodes)
await copilotz.ops.getMessageHistory(
  threadId: string,
  userId: string,
  limit?: number
): Promise<Message[]>

// Create a message (writes a message node + edges)
await copilotz.ops.createMessage(
  message: MessageInput,
  namespace?: string
): Promise<Message>

// Last message node in a thread
await copilotz.ops.getLastMessageNode(threadId: string): Promise<Node | null>
```

#### Participant / user nodes

> **Deprecated**: Use the built-in `participant` collection via `copilotz.collections.participant` for all identity management.

```typescript
// Deprecated graph-node accessors
await copilotz.ops.upsertParticipantNode(externalId, kind, namespace, data)
await copilotz.ops.getParticipantNode(externalId, namespace?)
```

#### Queue Operations

```typescript
// Add to queue
await copilotz.ops.addToQueue(
  threadId: string,
  event: { type: string; payload: any; priority?: number; ttl?: number }
): Promise<QueueItem>

// Get processing item
await copilotz.ops.getProcessingQueueItem(threadId: string): Promise<QueueItem | null>

// Get next pending item
await copilotz.ops.getNextPendingQueueItem(
  threadId: string,
  namespace?: string
): Promise<QueueItem | null>

// Update queue item status
await copilotz.ops.updateQueueItemStatus(
  queueId: string,
  status: "pending" | "processing" | "completed" | "failed"
): Promise<void>
```

#### RAG operations (document + chunk nodes)

RAG does **not** use separate `documents` / `document_chunks` tables. Ingestion stores a **`document` node** (metadata in `data`) and **`chunk` nodes** with embeddings; helpers below map to those nodes.

```typescript
// Create / read document metadata (backed by type "document" nodes)
await copilotz.ops.createDocument(doc: {
  source: string;
  namespace: string;
  metadata?: Record<string, any>;
}): Promise<Document>

await copilotz.ops.getDocumentById(id: string): Promise<Document | null>
await copilotz.ops.getDocumentByHash(hash: string, namespace: string): Promise<Document | null>

await copilotz.ops.updateDocumentStatus(
  id: string,
  status: "pending" | "processing" | "indexed" | "failed",
  errorMessage?: string,
  chunkCount?: number
): Promise<void>

await copilotz.ops.deleteDocument(id: string): Promise<void>

// Chunk search over `chunk` nodes (requires an embedding vector; embed NL queries first — see `search_knowledge` tool)
await copilotz.ops.searchChunksFromGraph(options: {
  embedding: number[];
  namespaces?: string[];
  limit?: number;
  threshold?: number;
  documentFilters?: { sourceType?: string; mimeType?: string; status?: string };
}): Promise<ChunkSearchResult[]>

await copilotz.ops.searchChunks(options: ChunkSearchOptions): Promise<ChunkSearchResult[]>

// Per-namespace counts of document vs chunk nodes
await copilotz.ops.getNamespaceStats(): Promise<NamespaceStats[]>
```

#### Graph operations (`nodes` + `edges` tables)

```typescript
// Create a node (type, namespace, name, content, data, embedding, sourceType, sourceId, …)
await copilotz.ops.createNode(node): Promise<KnowledgeNode>
await copilotz.ops.createNodes(nodes): Promise<KnowledgeNode[]>

await copilotz.ops.getNodeById(id: string): Promise<KnowledgeNode | undefined>
await copilotz.ops.getNodesByNamespace(namespace: string, type?: string): Promise<KnowledgeNode[]>

await copilotz.ops.updateNode(id: string, updates): Promise<KnowledgeNode | undefined>
await copilotz.ops.deleteNode(id: string): Promise<void>
await copilotz.ops.deleteNodesBySource(sourceType: string, sourceId: string): Promise<void>

// Edges (sourceNodeId, targetNodeId, type, data, weight, …)
await copilotz.ops.createEdge(edge): Promise<KnowledgeEdge>
await copilotz.ops.createEdges(edges): Promise<KnowledgeEdge[]>

await copilotz.ops.getEdgesForNode(
  nodeId: string,
  direction?: "in" | "out" | "both",
  types?: string[]
): Promise<KnowledgeEdge[]>

await copilotz.ops.deleteEdge(id: string): Promise<void>
await copilotz.ops.deleteEdgesForNode(nodeId: string): Promise<void>

await copilotz.ops.searchNodes(options: GraphQueryOptions): Promise<GraphQueryResult[]>

await copilotz.ops.traverseGraph(
  startNodeId: string,
  edgeTypes?: string[],
  maxDepth?: number
): Promise<{ nodes: KnowledgeNode[]; edges: KnowledgeEdge[] }>

await copilotz.ops.findRelatedNodes(nodeId: string, depth?: number): Promise<KnowledgeNode[]>
```

---

### copilotz.collections

Collection manager for type-safe data operations.

```typescript
// Access a collection
copilotz.collections.customer.create({ ... });

// Create a namespace-scoped manager
const scoped = copilotz.collections.withNamespace("tenant:acme");
scoped.customer.find({ ... });
```

See [Collections](./collections.md) for full CRUD operations.

---

### copilotz.schema

Schema management for multi-tenancy.

```typescript
// Provision a tenant schema
await copilotz.schema.provision(schemaName: string): Promise<void>

// Drop a tenant schema
await copilotz.schema.drop(schemaName: string): Promise<void>

// Check if schema exists
await copilotz.schema.exists(schemaName: string): Promise<boolean>

// List all tenant schemas
await copilotz.schema.list(): Promise<string[]>

// Warm schema cache
await copilotz.schema.warmCache(): Promise<void>
```

---

### copilotz.assets

Asset storage and retrieval.

```typescript
// Get asset as base64
const { base64, mime } = await copilotz.assets.getBase64(
  refOrId: string,  // "asset://id" or just "id"
  options?: { namespace?: string }
): Promise<{ base64: string; mime: string }>

// Get asset as data URL
const dataUrl = await copilotz.assets.getDataUrl(
  refOrId: string,
  options?: { namespace?: string }
): Promise<string>  // "data:mime;base64,..."
```

---

## Collection Helpers

### defineCollection()

```typescript
const collection = defineCollection({
  name: string;
  schema: JSONSchema;
  indexes?: Index[];
  relations?: Record<string, Relation>;
  hooks?: {
    beforeCreate?: (data, context) => data;
    afterCreate?: (record, context) => void;
    beforeUpdate?: (filter, updates, context) => updates;
    afterUpdate?: (record, context) => void;
    beforeDelete?: (filter, context) => void;
    afterDelete?: (record, context) => void;
  };
});
```

### index

```typescript
index.field(fieldName: string): Index
index.fulltext(fieldName: string): Index
```

### relation

```typescript
relation.hasOne(collection: string, foreignKey: string): Relation
relation.hasMany(collection: string, foreignKey: string): Relation
relation.belongsTo(collection: string, foreignKey: string): Relation
```

---

## Resource Loading

### loadResources()

Load agents, tools, APIs, and processors from filesystem.

```typescript
const resources = await loadResources({
  path: string;  // Directory path
}): Promise<{
  agents: Agent[];
  tools: Tool[];
  apis: API[];
  processors: EventProcessor[];
}>
```

See [Loaders](./loaders.md) for directory structure.

---

### listPublicAgents()

Extract a safe, deduplicated list of agents for public-facing endpoints.

```typescript
const agents = listPublicAgents(
  copilotz.config.agents ?? []
): Array<{ id: string; name: string; description: string | null }>
```

### mergeResourceArrays()

Merge two resource arrays with ID-collision replacement. Explicit items win when
they share the same `id`, `key`, or `name` as a file-loaded item.

```typescript
const merged = mergeResourceArrays<T>(
  fileLoaded: T[],
  explicit: T[] | undefined
): T[]
```

### Resources type

The return type of `loadResources()`:

```typescript
type Resources = {
  agents: Agent[];
  tools: Tool[];
  apis: API[];
  processors: EventProcessor[];
  mcpServers: MCPServerConfig[];
  skills: Skill[];
};
```

---

## Skills

### filterSkillsForAgent()

Filter skills based on an agent's `allowedSkills` setting.

```typescript
const agentSkills = filterSkillsForAgent(
  skills: Skill[],
  agent?: Agent | null
): Skill[]
```

| `allowedSkills` value | Result                    |
| --------------------- | ------------------------- |
| `undefined` (default) | Returns all skills        |
| `string[]`            | Returns only named skills |
| `null`                | Returns empty array       |

### Skill type

```typescript
interface Skill {
  name: string; // Unique name (from directory or frontmatter)
  description: string; // Short description from frontmatter
  content: string; // Full markdown body
  allowedTools?: string[];
  tags?: string[];
  source: "project" | "user" | "bundled" | "remote";
  sourcePath: string; // Absolute path or URL
  hasReferences: boolean; // Whether references/ subdir exists
  metadata?: Record<string, unknown>;
}
```

### SkillIndexEntry type

Compact entry injected into the system prompt (~15-30 tokens per entry):

```typescript
interface SkillIndexEntry {
  name: string;
  description: string;
  tags?: string[];
}
```

### Skill Native Tools

Three built-in tools for the progressive disclosure workflow:

| Tool                  | Parameters                        | Description                                                |
| --------------------- | --------------------------------- | ---------------------------------------------------------- |
| `list_skills`         | _(none)_                          | Lists available skills filtered by agent's `allowedSkills` |
| `load_skill`          | `{ name: string }`                | Returns full SKILL.md content for a named skill            |
| `read_skill_resource` | `{ skill: string, path: string }` | Reads a file from a skill's `references/` directory        |

See [Skills](./skills.md) for full documentation.

---

## Utility Functions

### getNativeTools()

Get all built-in tools.

```typescript
const tools = getNativeTools(): Record<string, Tool>
```

### resolveNamespace()

Resolve namespace based on scope.

```typescript
const namespace = resolveNamespace(
  scope: "thread" | "agent" | "global",
  context: { threadId?: string; agentId?: string },
  prefix?: string
): string
```

---

## Types

### Core Types

```typescript
interface Agent {
  id: string;
  name: string;
  role: "assistant" | "system" | "user";
  instructions?: string;
  llmOptions: LlmOptions | AgentLlmOptionsResolver;
  allowedTools?: string[];
  allowedAgents?: string[];
  allowedSkills?: string[] | null;
  ragOptions?: AgentRagOptions;
  assetOptions?: {
    produce?: {
      persistGeneratedAssets?: boolean;
    };
  };
}

interface Message {
  id: string;
  threadId: string;
  content: string;
  sender: { type: string; name: string };
  metadata?: Record<string, any>;
  createdAt: string;
}

interface Thread {
  id: string;
  externalId?: string;
  metadata?: Record<string, any>;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
}

interface StreamEvent {
  type: string;
  payload: any;
  threadId?: string;
  traceId?: string;
}

interface KnowledgeNode {
  id: string;
  type: string;
  namespace: string;
  name?: string | null;
  content?: string | null;
  data?: Record<string, any> | null;
  embedding?: number[] | null;
  sourceType?: string | null;
  sourceId?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

interface KnowledgeEdge {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  type: string;
  data?: Record<string, any> | null;
  weight?: number | null;
  createdAt?: string;
}

interface ProviderConfig {
  provider: "openai" | "anthropic" | "gemini" | "groq" | "deepseek" | "ollama" | "minimax" | "xai";
  model?: string;
  temperature?: number;
  maxTokens?: number;
  outputReasoning?: boolean;
  estimateCost?: boolean;
  pricingModelId?: string;
}
```

### Usage and Cost Notes

- Provider-native usage is preferred whenever the provider exposes token accounting
- If native usage is unavailable, Copilotz falls back to a rough character-based token estimate
- Cost estimation is enabled by default and uses OpenRouter pricing data
- Cost is only estimated when usage came from the provider, not from the rough fallback heuristic

---

## Server Helpers (`copilotz/server`)

Framework-independent handler factories that wrap Copilotz operations into
domain-specific helpers. Import from the `copilotz/server` entrypoint.

```typescript
import {
  createAssetHandlers,
  createCollectionHandlers,
  createEventHandlers,
  createMessageHandlers,
  createParticipantHandlers,
  createThreadHandlers,
  withApp,
} from "copilotz/server";

import type {
  AppRequest,
  AppResponse,
  AssetHandlers,
  CollectionHandlers,
  CopilotzApp,
  EventHandlers,
  MessageHandlers,
  ParticipantHandlers,
  ThreadHandlers,
} from "copilotz/server";
```

### createThreadHandlers(copilotz)

Returns `ThreadHandlers`:

| Method            | Signature                                       |
| ----------------- | ----------------------------------------------- |
| `list`            | `(participantId, options?) → Promise<Thread[]>` |
| `getById`         | `(id) → Promise<Thread \| undefined>`           |
| `getByExternalId` | `(externalId) → Promise<Thread \| undefined>`   |
| `findOrCreate`    | `(threadId, threadData) → Promise<Thread>`      |
| `archive`         | `(id, summary) → Promise<Thread \| null>`       |

### createMessageHandlers(copilotz)

Returns `MessageHandlers`:

| Method          | Signature                                         |
| --------------- | ------------------------------------------------- |
| `listForThread` | `(threadId, options?) → Promise<Message[]>`       |
| `getHistory`    | `(threadId, userId, limit?) → Promise<Message[]>` |
| `listFromGraph` | `(threadId, limit?) → Promise<Message[]>`         |

### createEventHandlers(copilotz)

Returns `EventHandlers`:

| Method           | Signature                                                            |
| ---------------- | -------------------------------------------------------------------- |
| `enqueue`        | `(threadId, event) → Promise<Record<string, unknown>>`               |
| `getProcessing`  | `(threadId, minPriority?) → Promise<Queue \| undefined>`             |
| `getNextPending` | `(threadId, namespace?, minPriority?) → Promise<Queue \| undefined>` |
| `updateStatus`   | `(eventId, status) → Promise<void>`                                  |

### createAssetHandlers(copilotz)

Returns `AssetHandlers`:

| Method       | Signature                                |
| ------------ | ---------------------------------------- |
| `getBase64`  | `(refOrId) → Promise<{ base64, mime }>`  |
| `getDataUrl` | `(refOrId) → Promise<{ dataUrl, mime }>` |
| `parseRef`   | `(ref) → ParsedAssetRef \| null`         |

### createCollectionHandlers(copilotz)

Returns `CollectionHandlers`:

| Method            | Signature                                                 |
| ----------------- | --------------------------------------------------------- |
| `listCollections` | `() → string[]`                                           |
| `hasCollection`   | `(name) → boolean`                                        |
| `resolve`         | `(collectionName, namespace?) → unknown`                  |
| `list`            | `(collectionName, options?) → Promise<unknown[]>`         |
| `getById`         | `(collectionName, id, options?) → Promise<unknown>`       |
| `create`          | `(collectionName, data, options?) → Promise<unknown>`     |
| `update`          | `(collectionName, id, data, options?) → Promise<unknown>` |
| `delete`          | `(collectionName, id, options?) → Promise<unknown>`       |
| `search`          | `(collectionName, query, options?) → Promise<unknown[]>`  |

### createParticipantHandlers(copilotz)

Returns `ParticipantHandlers` backed by the built-in `participant` collection.
There is no dedicated `/participants` HTTP resource by default; use
`collections/participant` (see [Collections](./collections.md)) or wire these
handlers yourself.

| Method   | Signature                                                            |
| -------- | -------------------------------------------------------------------- |
| `get`    | `(externalId, options?) → Promise<Record<string, unknown> \| null>`  |
| `update` | `(externalId, updates, options?) → Promise<Record<string, unknown>>` |

### withApp(copilotz)

Returns the same instance with an `.app: CopilotzApp` property attached. Aggregates all handler factories, provides a pattern-based route table, and exposes a universal `handle()` dispatcher.

```typescript
const extended = withApp(copilotz);
extended.app.handle({ resource: "threads", method: "GET", path: [id] });
extended.app.threads.getById(id);
extended.app.resources(); // list all registered resources
```

See [Server Helpers](./server.md) for usage examples and framework wiring.

---

## Next Steps

- [Configuration](./configuration.md) — Full configuration options
- [Skills](./skills.md) — SKILL.md format, discovery, and admin agent
- [Database](./database.md) — Database operations details
- [Collections](./collections.md) — Collection CRUD reference
- [Server Helpers](./server.md) — Framework-independent handler factories
