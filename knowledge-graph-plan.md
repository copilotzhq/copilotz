# Knowledge Graph Unification Plan

## Goal
Unify RAG, conversation memory, and future knowledge features into a single graph-based knowledge layer.

## Core Insight
RAG is a special case of knowledge graph where:
- Nodes = chunks (type='chunk')
- Edges = none (implicit only)
- Retrieval = pure vector similarity

Generalizing to a full knowledge graph enables:
- Entity-aware retrieval
- Relationship traversal
- Cross-domain connections
- Conversation memory
- Code understanding

## Ontological Foundation

**The graph IS the database.**

Not a layer on top — the graph is the primary storage for ALL content and knowledge.

```
Node = Universal Content Unit
Edge = Universal Relationship
```

Everything is a node:
- Messages are nodes (type='message')
- Chunks are nodes (type='chunk')  
- Entities are nodes (type='concept', 'decision', etc.)
- Anything else — nodes with appropriate type labels

Type labels are open vocabulary (strings, not enums).
Type-specific properties live in the `data` field (JSONB).

## The Unified Model

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│   METADATA TABLES (lightweight containers)                      │
│   ────────────────────────────────────────                      │
│   • threads: container metadata (name, participants, status)    │
│   • documents: provenance (source URL, hash, status)            │
│                                                                 │
│   GRAPH TABLES (all content + all relationships)                │
│   ──────────────────────────────────────────────                │
│   • nodes: messages, chunks, entities, decisions, anything      │
│   • edges: REPLIED_TO, NEXT_CHUNK, MENTIONS, CAUSED, anything   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## What This Unlocks

1. **Conversation IS a graph**: Messages → REPLIED_TO → Messages, MENTIONS → Entities
2. **Documents ARE graphs**: Chunks → NEXT → Chunks, MENTIONS → Entities
3. **Cross-domain connections**: Message → ANSWERED_BY → Chunk, Entity bridges both
4. **Unified search**: One embedding search finds messages, chunks, entities
5. **History as traversal**: "What do I know about X?" = graph traversal from X

---

## Phase 1: Unified Schema ✅ COMPLETE

### New Tables

```sql
-- Everything worth remembering
CREATE TABLE nodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  namespace TEXT NOT NULL,           -- Scoping: thread_id, agent_id, 'global'
  type TEXT NOT NULL,                -- 'chunk', 'entity', 'concept', 'decision'...
  name TEXT NOT NULL,                -- Human-readable identifier
  embedding VECTOR(1536),            -- For semantic search
  content TEXT,                      -- Full text content (for chunks)
  data JSONB DEFAULT '{}',           -- Flexible properties
  source_type TEXT,                  -- 'document', 'message', 'file', 'extraction'
  source_id UUID,                    -- Reference to origin
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Relationships between nodes
CREATE TABLE edges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_node_id UUID NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  target_node_id UUID NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  type TEXT NOT NULL,                -- 'mentions', 'contains', 'caused', 'imports'...
  data JSONB DEFAULT '{}',           -- Relationship properties
  weight FLOAT DEFAULT 1.0,          -- Relationship strength
  created_at TIMESTAMP DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_nodes_namespace ON nodes(namespace);
CREATE INDEX idx_nodes_type ON nodes(type);
CREATE INDEX idx_nodes_namespace_type ON nodes(namespace, type);
CREATE INDEX idx_nodes_source ON nodes(source_type, source_id);
CREATE INDEX idx_nodes_embedding ON nodes USING ivfflat (embedding vector_cosine_ops);

CREATE INDEX idx_edges_source ON edges(source_node_id);
CREATE INDEX idx_edges_target ON edges(target_node_id);
CREATE INDEX idx_edges_type ON edges(type);
```

### Migration Strategy
- Keep `documents` table (source metadata/provenance)
- Deprecate `document_chunks` table
- Create migration to copy chunks → nodes
- Add edge creation for same-document relationships

### Tasks
- [x] Add nodes/edges to schema definitions
- [x] Create migration SQL
- [x] Update database operations
- [x] Add backward-compatible chunk operations

---

## Phase 2: Unified Operations ✅ COMPLETE

### Node Operations
```typescript
interface NodeOperations {
  createNode(node: NewNode): Promise<Node>;
  getNode(id: string): Promise<Node | null>;
  updateNode(id: string, updates: Partial<Node>): Promise<Node>;
  deleteNode(id: string): Promise<void>;
  
  // Batch operations
  createNodes(nodes: NewNode[]): Promise<Node[]>;
  deleteNodesBySource(sourceType: string, sourceId: string): Promise<void>;
}
```

### Edge Operations
```typescript
interface EdgeOperations {
  createEdge(edge: NewEdge): Promise<Edge>;
  getEdges(nodeId: string, direction?: 'in' | 'out' | 'both'): Promise<Edge[]>;
  deleteEdge(id: string): Promise<void>;
  
  // Batch operations
  createEdges(edges: NewEdge[]): Promise<Edge[]>;
}
```

### Graph Retrieval
```typescript
interface GraphQuery {
  query: string;                    // Natural language query
  namespace?: string;               // Scope to search
  nodeTypes?: string[];             // Filter node types
  edgeTypes?: string[];             // Relationship types to traverse
  maxDepth?: number;                // Traversal depth (0 = vector only)
  limit?: number;                   // Max results
  minSimilarity?: number;           // Vector similarity threshold
}

interface GraphResult {
  nodes: Node[];                    // Retrieved nodes
  edges: Edge[];                    // Traversed edges
  paths: NodePath[];                // Paths from seed to each node
}

interface KnowledgeOperations {
  // Unified retrieval
  retrieve(query: GraphQuery): Promise<GraphResult>;
  
  // Convenience methods (use retrieve internally)
  searchChunks(query: string, opts): Promise<ChunkResult[]>;  // Backward compat
  findRelated(nodeId: string, depth: number): Promise<Node[]>;
  getContext(namespace: string, query: string): Promise<string>;
}
```

### Tasks
- [x] Implement node CRUD operations
- [x] Implement edge CRUD operations
- [x] Implement graph traversal (iterative BFS)
- [x] Implement hybrid retrieval (searchNodes with vector similarity)
- [x] Maintain backward-compatible chunk operations

---

## Phase 3: Messages as Nodes ✅ COMPLETE

### The Shift
Messages move from a separate table to nodes in the graph.
The `messages` table becomes either deprecated or a view.

### What Changes
```typescript
// OLD: Create message in messages table
await ops.createMessage({
  threadId,
  content,
  senderId,
  senderType,
});

// NEW: Create message as node
await ops.createNode({
  namespace: threadId,
  type: 'message',
  name: `${senderType}:${timestamp}`,
  content,
  embedding: await embed(content),
  data: {
    senderId,
    senderType,
    toolCalls,
    // ... message-specific fields
  },
});

// With edge to previous message
await ops.createEdge({
  sourceNodeId: previousMessageId,
  targetNodeId: newMessageId,
  type: 'REPLIED_BY',
});
```

### Backward Compatibility
- Dual-write: `createMessage()` writes to both `messages` table and `nodes` table
- `getMessageHistory()` reads from `nodes` table (graph is source of truth)
- Thread hierarchy and participant permissions still enforced via `threads` table

### Tasks
- [x] Update createMessage to dual-write (messages table + nodes)
- [x] Add REPLIED_BY edges between sequential messages
- [x] Create backward-compatible message query operations (getMessageHistoryFromGraph)
- [x] Add getLastMessageNode for edge creation
- [x] **Switch getMessageHistory to read from graph** (hybrid approach)
- [x] Tests passing (25 tests)

---

## Phase 4: Unified Extraction ✅ COMPLETE

### All Content → Nodes + Edges

```typescript
// Document ingestion - IMPLEMENTED
Document → [chunk nodes] + [NEXT_CHUNK edges]

// Message processing - IMPLEMENTED  
Message → [message node] + [REPLIED_BY edges]

// Future: Code files
File → [symbol nodes] + [edges]
```

### What's Implemented

**RAG_INGEST Dual-Write** (`event-processors/rag_ingest/index.ts`):
- Document ingestion now creates chunks in BOTH:
  - Legacy `document_chunks` table (backward compatibility)
  - New `nodes` table with `type='chunk'`
- Creates `NEXT_CHUNK` edges between sequential chunks

**Chunk-as-Node Operations** (`database/operations/index.ts`):
- `searchChunksFromGraph`: Vector search on chunk nodes

**Tests** (`examples/chunk-as-node-test.ts`):
- 8 tests verifying chunk node creation, embedding, edges, search, and cleanup

### Tasks
- [x] Update RAG_INGEST to create chunk nodes (dual-write)
- [x] Add NEXT_CHUNK edges between sequential chunks
- [x] Implement searchChunksFromGraph operation
- [x] Tests passing (8 tests)

---

## Phase 5: Entity Extraction ✅ COMPLETE

### Overview

Extract semantic entities (concepts, decisions, people, etc.) from messages and chunks,
creating a richer knowledge graph with cross-referenced concepts.

### Architecture

```
NEW_MESSAGE processor
       │
       ├──> Create message node (sync, fast)
       │
       └──> Emit ENTITY_EXTRACT event (async)
                   │
                   ▼
       ┌─────────────────────────┐
       │  1. LLM Extraction      │  ← Extract entities from content
       └───────────┬─────────────┘
                   │
                   ▼ (for each entity)
       ┌─────────────────────────┐
       │  2. Semantic Search     │  ← Find similar existing entities
       └───────────┬─────────────┘
                   │
           ┌───────┴───────┐
           │               │
           ▼               ▼
       No match         Match found
       (< 0.95)         (≥ 0.95)
           │               │
           ▼               │
       Create new         │
       entity node        ├── ≥0.99: Auto-merge (skip LLM)
                          │
                          └── ≥0.95: LLM Confirm
                                      │
                              ┌───────┴───────┐
                              │               │
                              ▼               ▼
                          "Same"         "Different"
                              │               │
                              ▼               ▼
                          Merge +         Create new +
                          add alias       RELATED_TO edge
```

### Deduplication Strategy

| Similarity | Action |
|------------|--------|
| ≥ 0.99 | Auto-merge (high confidence) |
| ≥ 0.95 | LLM confirms if same entity |
| < 0.95 | Create new entity |

**Merge behavior**: Reuse existing entity node, track aliases in `data.aliases[]`

### Namespace Strategy

**Instance-level prefix** (optional):
```typescript
const copilotz = createCopilotz({
  namespacePrefix: "myapp",  // Optional, default: ""
});
```

**Entity scope** (per-agent):
```typescript
entityExtraction: {
  namespace: "agent",  // "thread" | "agent" | "global"
}
```

**Resolution**:
```
prefix + scope + id → "myapp:agent:support-bot"
```

| Scope | Resolved Namespace |
|-------|-------------------|
| thread | `{prefix}:thread:{threadId}` |
| agent | `{prefix}:agent:{agentId}` |
| global | `{prefix}:global` |

### Configuration

```typescript
interface CopilotzConfig {
  namespacePrefix?: string;  // Optional isolation prefix
  // ...
}

interface EntityExtractionConfig {
  enabled: boolean;                           // Default: false
  similarityThreshold?: number;               // Default: 0.95
  autoMergeThreshold?: number;                // Default: 0.99
  namespace?: "thread" | "agent" | "global";  // Default: "agent"
  entityTypes?: string[];                     // e.g., ["concept", "decision", "person"]
}

// Per-agent configuration
agent.ragOptions.entityExtraction = {
  enabled: true,
  namespace: "agent",
};
```

### Entity Types (Open Vocabulary)

Common types for AI agents:
- `concept` — technical terms, ideas, topics
- `decision` — agreed actions, conclusions
- `task` — action items, todos
- `person` — mentioned individuals
- `tool` — APIs, services, resources
- `fact` — stated truths or assertions

Types are strings (open vocabulary), not enums.

### Edge Types

| Edge | Meaning |
|------|---------|
| `MENTIONS` | message/chunk → entity |
| `SAME_AS` | entity ↔ entity (aliases) |
| `RELATED_TO` | entity → entity (similar but different) |
| `CAUSED` | decision → task |

### Tasks
- [x] Add ENTITY_EXTRACT event type and payload
- [x] Create EntityExtractProcessor
- [x] Implement LLM extraction prompt
- [x] Add semantic search for entity dedup
- [x] Implement LLM merge confirmation (≥0.99 auto-merge, ≥0.95 LLM confirm)
- [x] Add alias tracking in entity data
- [x] Add namespacePrefix to ChatContext
- [x] Implement resolveNamespace utility
- [x] Update agent config with entityExtraction options
- [x] Update NEW_MESSAGE processor to emit ENTITY_EXTRACT events
- [x] Tests (13 tests passing)

---

## Phase 6: Advanced Features (Future)

### Code Extractor
- Parse AST for symbols
- Extract imports/calls/inherits relationships
- Integrate with file watcher

### Cross-Domain Links
- Connect conversation entities to document chunks
- Connect code symbols to documentation

### Memory Compression
- Summarize old entities
- Prune low-relevance edges
- Hierarchical entity merging

---

## File Structure

```
lib/
├── database/
│   ├── schemas/
│   │   └── index.ts              # Add nodes, edges schemas
│   ├── migrations/
│   │   └── migration_0003_knowledge_graph.ts  # New migration
│   └── operations/
│       └── index.ts              # Add node/edge/graph operations
├── knowledge/
│   ├── index.ts                  # Main knowledge API
│   ├── retrieval.ts              # Hybrid retrieval logic
│   ├── extractors/
│   │   ├── types.ts              # Extractor interface
│   │   ├── conversation.ts       # Message entity extractor
│   │   └── document.ts           # Document chunk extractor (existing RAG)
│   └── graph.ts                  # Graph traversal utilities
└── event-processors/
    ├── rag_ingest/
    │   └── index.ts              # Update to create nodes
    └── new_message/
        └── index.ts              # Add entity extraction
```

---

## Progress Log

| Phase | Status | Date |
|-------|--------|------|
| 1. Unified Schema | ✅ Complete | Jan 15, 2026 |
| 2. Unified Operations | ✅ Complete | Jan 15, 2026 |
| 3. Messages as Nodes | ✅ Complete | Jan 15, 2026 |
| 4. Unified Extraction | ✅ Complete | Jan 15, 2026 |
| 5. Entity Extraction | ✅ Complete | Jan 15, 2026 |

### Architectural Breakthrough (Jan 15, 2026)

Realized that the graph should BE the database, not a layer on top:
- Messages, chunks, entities — all nodes
- All relationships — edges  
- Unified search and traversal across all content
- Tables like `messages` and `document_chunks` become deprecated/views

### What's Implemented

**Schema** (`database/schemas/index.ts`):
- `nodes` table: namespace, type, name, embedding, content, data, source tracking
- `edges` table: source/target nodes, type, data, weight
- Types: `KnowledgeNode`, `NewKnowledgeNode`, `KnowledgeEdge`, `NewKnowledgeEdge`

**Operations** (`database/operations/index.ts`):
- Node CRUD: `createNode`, `createNodes`, `getNodeById`, `getNodesByNamespace`, `updateNode`, `deleteNode`, `deleteNodesBySource`
- Edge CRUD: `createEdge`, `createEdges`, `getEdgesForNode`, `deleteEdge`, `deleteEdgesForNode`
- Graph queries: `searchNodes` (vector search), `traverseGraph` (BFS), `findRelatedNodes`

**Tests** (`examples/knowledge-graph-test.ts`):
- 23 tests covering all CRUD operations, vector search, graph traversal, and namespace queries

**Chunk Nodes** (`event-processors/rag_ingest/index.ts`):
- Dual-write: chunks → `document_chunks` table + `nodes` table
- NEXT_CHUNK edges between sequential chunks
- searchChunksFromGraph for graph-based retrieval

**Tests** (`examples/chunk-as-node-test.ts`):
- 8 tests covering chunk node creation, embedding, edges, search, and cleanup

