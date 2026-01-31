# API Reference

Complete reference for the Copilotz public API.

## Top-Level Exports

```typescript
import {
  // Main factory
  createCopilotz,
  
  // Collections
  defineCollection,
  relation,
  index,
  
  // Resource loading
  loadResources,
  
  // Database utilities
  createDatabase,
  
  // Schema management
  withSchema,
  provisionTenantSchema,
  dropTenantSchema,
  schemaExists,
  listTenantSchemas,
  warmSchemaCache,
  clearSchemaCache,
  
  // Event processing
  registerEventProcessor,
  
  // Utilities
  resolveNamespace,
  getNativeTools,
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
  onEvent?: (event: StreamEvent) => void,
  options?: RunOptions
): Promise<RunHandle>
```

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `message` | `MessageInput` | The message to process |
| `onEvent` | `function` | Optional callback for each event |
| `options` | `RunOptions` | Optional run configuration |

**MessageInput:**

```typescript
{
  content: string;
  sender: { type: "user" | "assistant" | "system"; name: string };
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
  events: AsyncIterable<StreamEvent>;  // Event stream
  done: Promise<void>;                 // Completion promise
  threadId: string;                    // Thread ID
}
```

**Example:**

```typescript
const result = await copilotz.run(
  { content: "Hello!", sender: { type: "user", name: "Alex" } },
  (event) => console.log(event.type),
  { stream: true }
);

for await (const event of result.events) {
  if (event.type === "TOKEN") {
    process.stdout.write(event.payload.token);
  }
}

await result.done;
```

---

### copilotz.start()

Start an interactive REPL session. Prompts for user input, streams responses to stdout, and maintains conversation state.

```typescript
const session = copilotz.start(
  initialMessage?: string | StartOptions,
  onEvent?: (event: StreamEvent) => void
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
3. Enters a prompt loop (`Message: `)
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

#### Message Operations

```typescript
// Get message history
await copilotz.ops.getMessageHistory(
  threadId: string,
  userId: string,
  limit?: number
): Promise<Message[]>

// Get messages from graph
await copilotz.ops.getMessageHistoryFromGraph(
  threadId: string,
  limit?: number
): Promise<Message[]>

// Create a message
await copilotz.ops.createMessage(
  message: MessageInput,
  namespace?: string
): Promise<Message>

// Get last message node
await copilotz.ops.getLastMessageNode(threadId: string): Promise<Node | null>
```

#### User Operations

```typescript
// Upsert a user node
await copilotz.ops.upsertUserNode(
  externalId: string,
  namespace: string | null,
  data: { name?: string; metadata?: Record<string, any> }
): Promise<Node>

// Get a user node
await copilotz.ops.getUserNode(
  externalId: string,
  namespace?: string
): Promise<Node | null>

// Get all user nodes by external ID
await copilotz.ops.getUserNodesByExternalId(externalId: string): Promise<Node[]>
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

#### RAG Operations

```typescript
// Create a document
await copilotz.ops.createDocument(doc: {
  source: string;
  namespace: string;
  metadata?: Record<string, any>;
}): Promise<Document>

// Get document by ID
await copilotz.ops.getDocumentById(id: string): Promise<Document | null>

// Get document by content hash
await copilotz.ops.getDocumentByHash(hash: string, namespace: string): Promise<Document | null>

// Update document status
await copilotz.ops.updateDocumentStatus(
  id: string,
  status: "pending" | "processing" | "completed" | "failed",
  errorMessage?: string,
  chunkCount?: number
): Promise<void>

// Delete document
await copilotz.ops.deleteDocument(id: string): Promise<void>

// Search chunks
await copilotz.ops.searchChunks(options: {
  query: string;
  namespace?: string;
  limit?: number;
  threshold?: number;
}): Promise<Chunk[]>

// Search chunks from graph
await copilotz.ops.searchChunksFromGraph(options: {
  query: string;
  namespace?: string;
  limit?: number;
}): Promise<Chunk[]>

// Get namespace stats
await copilotz.ops.getNamespaceStats(): Promise<Record<string, {
  documentCount: number;
  chunkCount: number;
}>>
```

#### Graph Operations

```typescript
// Create a node
await copilotz.ops.createNode(node: {
  type: string;
  namespace: string;
  properties: Record<string, any>;
  embedding?: number[];
}): Promise<Node>

// Create multiple nodes
await copilotz.ops.createNodes(nodes: NodeInput[]): Promise<Node[]>

// Get node by ID
await copilotz.ops.getNodeById(id: string): Promise<Node | null>

// Get nodes by namespace
await copilotz.ops.getNodesByNamespace(
  namespace: string,
  type?: string
): Promise<Node[]>

// Update a node
await copilotz.ops.updateNode(
  id: string,
  updates: Partial<Node>
): Promise<Node>

// Delete a node
await copilotz.ops.deleteNode(id: string): Promise<void>

// Create an edge
await copilotz.ops.createEdge(edge: {
  sourceId: string;
  targetId: string;
  type: string;
  properties?: Record<string, any>;
}): Promise<Edge>

// Create multiple edges
await copilotz.ops.createEdges(edges: EdgeInput[]): Promise<Edge[]>

// Get edges for a node
await copilotz.ops.getEdgesForNode(
  nodeId: string,
  direction?: "in" | "out" | "both",
  types?: string[]
): Promise<Edge[]>

// Delete an edge
await copilotz.ops.deleteEdge(id: string): Promise<void>

// Search nodes by embedding
await copilotz.ops.searchNodes(options: {
  query: string;
  namespace?: string;
  type?: string;
  limit?: number;
  threshold?: number;
}): Promise<Node[]>

// Traverse the graph
await copilotz.ops.traverseGraph(
  startNodeId: string,
  edgeTypes?: string[],
  maxDepth?: number
): Promise<{ nodes: Node[]; edges: Edge[] }>

// Find related nodes
await copilotz.ops.findRelatedNodes(
  nodeId: string,
  depth?: number
): Promise<Node[]>
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
  refOrId: string  // "asset://id" or just "id"
): Promise<{ base64: string; mime: string }>

// Get asset as data URL
const dataUrl = await copilotz.assets.getDataUrl(
  refOrId: string
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
  ragOptions?: AgentRagOptions;
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

interface Node {
  id: string;
  type: string;
  namespace: string;
  properties: Record<string, any>;
  embedding?: number[];
  createdAt: string;
  updatedAt: string;
}

interface Edge {
  id: string;
  sourceId: string;
  targetId: string;
  type: string;
  properties?: Record<string, any>;
  createdAt: string;
}
```

---

## Next Steps

- [Configuration](./configuration.md) — Full configuration options
- [Database](./database.md) — Database operations details
- [Collections](./collections.md) — Collection CRUD reference
