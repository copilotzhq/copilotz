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

## Phase 3: Messages as Nodes ⏳

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
- Keep `messages` table as read-only view on nodes(type='message')
- OR dual-write during migration period
- `getMessageHistory()` → queries nodes, returns in message format

### Tasks
- [ ] Update NEW_MESSAGE processor to create message nodes
- [ ] Add REPLIED_BY edges between sequential messages
- [ ] Create backward-compatible message query operations
- [ ] Migrate or dual-write existing messages

---

## Phase 4: Unified Extraction ⏳

### All Content → Nodes + Edges

```typescript
// Document ingestion
Document → [chunk nodes] + [entity nodes] + [edges]

// Message processing  
Message → [message node] + [entity nodes] + [edges]

// Future: Code files
File → [symbol nodes] + [edges]
```

### Extraction Utility
```typescript
interface ExtractionResult {
  nodes: NewKnowledgeNode[];
  edges: NewKnowledgeEdge[];
}

// Document extraction: chunk + embed + (optional) entity extraction
async function extractFromDocument(content: string, ctx): Promise<ExtractionResult>;

// Message extraction: embed + (optional) entity extraction
async function extractFromMessage(content: string, ctx): Promise<ExtractionResult>;
```

### Entity Extraction (Optional Enhancement)
- LLM-based extraction of concepts, decisions, facts
- Creates additional nodes linked to source (chunk or message)
- Enables richer graph traversal

### Tasks
- [ ] Update RAG_INGEST to create chunk nodes (not document_chunks)
- [ ] Add optional entity extraction during ingestion
- [ ] Add optional entity extraction during message processing
- [ ] Implement entity deduplication/merge logic

---

## Phase 5: Advanced Features (Future)

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
| 3. Messages as Nodes | ⏳ Pending | |
| 4. Unified Extraction | ⏳ Pending | |

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

