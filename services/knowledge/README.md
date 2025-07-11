# 📚 Knowledge Base Service

A comprehensive document processing and retrieval system built with **Deno**, **ominipg**, and **PostgreSQL**. Extract, chunk, embed, and search through documents from multiple sources with semantic and keyword search capabilities.

## 🎯 Overview

The Knowledge Base service provides a complete **Extract → Parse → Embed → Persist → Query** pipeline for document processing:

- **📄 Multi-format document extraction** (text, web, PDF, videos, etc.)
- **✂️ Intelligent text chunking** with multiple strategies
- **🧠 Vector embeddings** for semantic search
- **💾 PostgreSQL storage** with optional pgvector support
- **🔍 Hybrid search** combining semantic and keyword approaches
- **🗂️ Document collections** for organization
- **🌐 HTTP API** with Axion Functions integration

## 🏗️ Architecture

```
services/knowledge/
├── types.ts                    # TypeScript definitions
├── index.ts                    # Main service interface
├── database/
│   ├── schema.ts              # PostgreSQL schema
│   └── operations.ts          # Database operations
├── extractors/                # Document extraction providers
│   ├── index.ts              # Provider registry
│   ├── text/index.ts         # Plain text extractor
│   ├── web/index.ts          # Web scraping extractor
│   ├── pdf/index.ts          # PDF extractor (stub)
│   ├── video/index.ts        # Video transcription (stub)
│   ├── audio/index.ts        # Audio transcription (stub)
│   ├── doc/index.ts          # Word documents (stub)
│   ├── csv/index.ts          # CSV parser (stub)
│   └── json/index.ts         # JSON parser (stub)
└── chunking/index.ts         # Text chunking strategies
```

## 🚀 Quick Start

### Prerequisites

- **Deno 2.0+**
- **PostgreSQL** (optional: with pgvector extension)
- **OpenAI API Key** (for embeddings)

### Installation

```bash
# Clone and navigate to your project
cd your-axion-project

# Set environment variables
export OPENAI_API_KEY="your-openai-key"
export KNOWLEDGE_BASE_DB_URL="postgres://user:pass@localhost/knowledge" # or file://./knowledge.db
```

### Basic Usage

```typescript
import { createKnowledgeBase } from './services/knowledge/index.ts';

// Initialize knowledge base
const kb = await createKnowledgeBase({
  database: {
    url: "file://./knowledge.db"  // or PostgreSQL URL
  },
  embedding: {
    provider: "openai",
    model: "text-embedding-ada-002"
  }
});

// Ingest a document
const result = await kb.process({
  type: 'ingest',
  source: {
    type: 'text',
    content: 'Your document content here...',
    title: 'Sample Document'
  }
});

// Search documents
const searchResult = await kb.process({
  type: 'search',
  query: 'your search query',
  config: {
    searchType: 'hybrid',
    limit: 10
  }
});

console.log(searchResult.results);
```

## 📖 Document Sources

### Text Content
```typescript
{
  type: 'ingest',
  source: {
    type: 'text',
    content: 'Your text content here...',
    title: 'Document Title'
  }
}
```

### Web Pages
```typescript
{
  type: 'ingest',
  source: {
    type: 'url',
    url: 'https://example.com/article',
    headers: { 'Authorization': 'Bearer token' } // optional
  },
  config: {
    provider: 'web',
    options: {
      selector: 'main',           // CSS selector for content
      waitFor: 2000,             // Wait time for page load
      followLinks: false,         // Extract linked pages
      maxDepth: 1                // Link following depth
    }
  }
}
```

### File Uploads
```typescript
{
  type: 'ingest',
  source: {
    type: 'file',
    file: fileBlob,
    fileName: 'document.pdf'
  }
}
```

### Base64 Data
```typescript
{
  type: 'ingest',
  source: {
    type: 'base64',
    data: 'base64-encoded-content',
    mimeType: 'application/pdf',
    fileName: 'document.pdf'
  }
}
```

## ✂️ Chunking Strategies

### Sentence-based (Default)
Best for articles and general text. Splits at sentence boundaries while respecting chunk size limits.

```typescript
{
  strategy: 'sentences',
  size: 1000,
  overlap: 200
}
```

### Paragraph-based
Ideal for structured documents. Maintains paragraph boundaries.

```typescript
{
  strategy: 'paragraphs',
  size: 1200,
  overlap: 150
}
```

### Fixed-size
For uniform content like code or data.

```typescript
{
  strategy: 'fixed',
  size: 800,
  overlap: 100
}
```

### Semantic
Intelligent splitting based on document structure (headers, sections).

```typescript
{
  strategy: 'semantic',
  size: 1500,
  overlap: 200,
  preserveStructure: true
}
```

## 🔍 Search Types

### Semantic Search
Uses vector embeddings for meaning-based search:

```typescript
{
  type: 'search',
  query: 'machine learning algorithms',
  config: {
    searchType: 'semantic',
    threshold: 0.7,
    limit: 10
  }
}
```

### Keyword Search
Traditional full-text search:

```typescript
{
  type: 'search',
  query: 'neural networks',
  config: {
    searchType: 'keyword',
    threshold: 0.1,
    limit: 10
  }
}
```

### Hybrid Search (Recommended)
Combines semantic and keyword search with weighted scoring:

```typescript
{
  type: 'search',
  query: 'deep learning',
  config: {
    searchType: 'hybrid',
    threshold: 0.5,
    limit: 10
  }
}
```

## 🌐 HTTP API

### Ingest Document
```bash
POST /features/knowledge/ingest
Content-Type: application/json

{
  "source": {
    "type": "text",
    "content": "Document content...",
    "title": "My Document"
  },
  "config": {
    "provider": "text",
    "options": {
      "chunkSize": 1000,
      "chunkStrategy": "sentences"
    }
  },
  "collectionId": "optional-collection-id"
}
```

**Response:**
```json
{
  "success": true,
  "documentId": "uuid-here",
  "chunks": 5,
  "processingTime": 1250,
  "message": "Document ingested successfully with 5 chunks"
}
```

### Search Documents
```bash
GET /features/knowledge/search?q=query&type=hybrid&limit=10&threshold=0.5
```

**Response:**
```json
{
  "success": true,
  "results": [
    {
      "documentId": "uuid",
      "chunkId": "chunk-uuid",
      "content": "Relevant text chunk...",
      "score": 0.85,
      "metadata": {},
      "document": {
        "title": "Document Title",
        "documentType": "text",
        "createdAt": "2024-01-01T00:00:00Z"
      }
    }
  ],
  "totalResults": 10,
  "processingTime": 150,
  "query": "search query",
  "searchType": "hybrid"
}
```

## ⚙️ Configuration

### Database Configuration
```typescript
const config = {
  database: {
    url: "postgres://user:pass@localhost/kb",  // PostgreSQL
    // OR
    url: "file://./knowledge.db",              // Local file
    syncUrl: "postgres://remote-url",          // Optional sync
    schema: customSchemaArray                  // Optional custom schema
  }
}
```

### Embedding Configuration
```typescript
const config = {
  embedding: {
    provider: "openai",                        // openai | cohere | huggingface
    model: "text-embedding-ada-002",           // Model name
    dimensions: 1536                           // Vector dimensions
  }
}
```

### Chunking Configuration
```typescript
const config = {
  chunking: {
    strategy: "sentences",                     // sentences | paragraphs | fixed | semantic
    size: 1000,                               // Target chunk size
    overlap: 200,                             // Overlap between chunks
    preserveStructure: true,                  // Maintain document structure
    minChunkSize: 100,                        // Minimum chunk size
    maxChunkSize: 2000                        // Maximum chunk size
  }
}
```

## 💾 Database Schema

The service automatically creates these PostgreSQL tables:

### Documents Table
```sql
CREATE TABLE documents (
  id UUID PRIMARY KEY,
  title VARCHAR(500) NOT NULL,
  content TEXT NOT NULL,
  document_type VARCHAR(50) NOT NULL,
  source_type VARCHAR(50) NOT NULL,
  source_url TEXT,
  file_name VARCHAR(255),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  status VARCHAR(50) DEFAULT 'processing'
);
```

### Chunks Table
```sql
CREATE TABLE chunks (
  id UUID PRIMARY KEY,
  document_id UUID REFERENCES documents(id),
  content TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  metadata JSONB DEFAULT '{}',
  embedding VECTOR(1536),  -- pgvector column
  embedding_model VARCHAR(100),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### Collections & Relationships
```sql
CREATE TABLE collections (
  id UUID PRIMARY KEY,
  name VARCHAR(255) UNIQUE NOT NULL,
  description TEXT,
  metadata JSONB DEFAULT '{}'
);

CREATE TABLE document_collections (
  document_id UUID REFERENCES documents(id),
  collection_id UUID REFERENCES collections(id),
  PRIMARY KEY (document_id, collection_id)
);
```

## 🔧 Extending the Service

### Adding New Document Extractors

1. **Create extractor implementation:**

```typescript
// services/knowledge/extractors/my-format/index.ts
import type { DocumentExtractor, ExtractorConfig, ExtractionRequest, ExtractionResult } from '../../types.ts';

export class MyFormatExtractor implements DocumentExtractor {
  name = 'my-format' as const;
  supportedTypes = ['my-format'];
  
  constructor(private config: ExtractorConfig) {}
  
  validate(source: any): boolean {
    // Validate if this extractor can handle the source
    return source.type === 'file' && source.file?.type === 'application/my-format';
  }
  
  async extract(request: ExtractionRequest): Promise<ExtractionResult> {
    // Your extraction logic here
    return {
      success: true,
      content: extractedText,
      metadata: { /* document metadata */ },
      processingTime: Date.now() - startTime
    };
  }
}

export function createMyFormatExtractor(config: ExtractorConfig): MyFormatExtractor {
  return new MyFormatExtractor(config);
}
```

2. **Register in the provider registry:**

```typescript
// services/knowledge/extractors/index.ts
import { createMyFormatExtractor } from './my-format/index.ts';

const extractorRegistry: Record<ExtractorName, ExtractorFactory> = {
  // ... existing extractors
  'my-format': createMyFormatExtractor
};
```

3. **Update types:**

```typescript
// services/knowledge/types.ts
export type ExtractorName = 'pdf' | 'web' | 'text' | 'video' | 'doc' | 'audio' | 'csv' | 'json' | 'my-format';
export type DocumentType = 'pdf' | 'doc' | 'docx' | 'txt' | 'md' | 'web' | 'video' | 'audio' | 'csv' | 'json' | 'my-format';
```

### Adding Custom Chunking Strategies

```typescript
// services/knowledge/chunking/index.ts
class CustomChunker implements ChunkingStrategy {
  chunk(content: string, config: ChunkingConfig): TextChunk[] {
    // Your custom chunking logic
    return chunks;
  }
}

const chunkers: Record<ChunkingConfig['strategy'], ChunkingStrategy> = {
  // ... existing chunkers
  'custom': new CustomChunker()
};
```

## 🧪 Testing

### Run Built-in Tests
```bash
# Test the HTTP API
deno run --allow-all features/knowledge/index.ts

# Test specific components
deno run --allow-all services/knowledge/extractors/text/index.ts
deno run --allow-all services/knowledge/chunking/index.ts
```

### Example Test Script
```typescript
import { createKnowledgeBase } from './services/knowledge/index.ts';

const kb = await createKnowledgeBase({
  database: { url: ':memory:' }  // In-memory database for testing
});

// Test document ingestion
const result = await kb.process({
  type: 'ingest',
  source: {
    type: 'text',
    content: 'Test document content about artificial intelligence and machine learning.',
    title: 'Test Document'
  }
});

console.log('Ingestion result:', result);

// Test search
const searchResult = await kb.process({
  type: 'search',
  query: 'artificial intelligence',
  config: { searchType: 'hybrid', limit: 5 }
});

console.log('Search results:', searchResult.results);
```

## 🛠️ Implementation Status

| Component | Status | Notes |
|-----------|--------|-------|
| Text Extractor | ✅ Complete | Handles txt, md, plain text |
| Web Extractor | ✅ Complete | HTML parsing, link following |
| PDF Extractor | 🟡 Stub | Ready for pdf-parse integration |
| Video Extractor | 🟡 Stub | Ready for Whisper integration |
| Audio Extractor | 🟡 Stub | Ready for transcription service |
| Doc Extractor | 🟡 Stub | Ready for mammoth integration |
| CSV Parser | 🟡 Stub | Ready for implementation |
| JSON Parser | 🟡 Stub | Ready for implementation |
| Database Operations | ✅ Complete | Full CRUD with ominipg |
| Vector Search | ✅ Complete | pgvector + JSON fallback |
| Chunking Strategies | ✅ Complete | 4 strategies implemented |
| HTTP API | ✅ Complete | Axion Functions endpoints |

## 🎯 Roadmap

### Phase 1: Core Extractors
- [ ] **PDF Extraction**: Integrate `pdf-parse` or `pdfjs-dist`
- [ ] **Word Documents**: Add `mammoth` for .docx parsing
- [ ] **CSV Processing**: Implement CSV parsing with headers
- [ ] **JSON Processing**: Add JSONPath support

### Phase 2: Advanced Features
- [ ] **Audio/Video Transcription**: OpenAI Whisper integration
- [ ] **OCR Support**: Image text extraction
- [ ] **Re-ranking**: Cohere/OpenAI re-ranking for better results
- [ ] **Metadata Extraction**: Enhanced document metadata

### Phase 3: Enterprise Features
- [ ] **Access Control**: Document-level permissions
- [ ] **Audit Logging**: Track all operations
- [ ] **Batch Processing**: Background job queue
- [ ] **Analytics**: Search analytics and insights

## 🤝 Contributing

1. **Fork** the repository
2. **Create** a feature branch (`git checkout -b feature/amazing-feature`)
3. **Implement** your changes with tests
4. **Commit** your changes (`git commit -m 'Add amazing feature'`)
5. **Push** to the branch (`git push origin feature/amazing-feature`)
6. **Open** a Pull Request

### Development Guidelines

- **Follow TypeScript best practices**
- **Add comprehensive tests** for new features
- **Update documentation** for API changes
- **Use semantic commit messages**
- **Ensure all tests pass** before submitting

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🆘 Support

- **Documentation**: Check this README and inline code comments
- **Issues**: Open a GitHub issue for bugs or feature requests
- **Discussions**: Use GitHub Discussions for questions and ideas

---

## 📚 Examples

### Simple Text Ingestion and Search
```typescript
const kb = await createKnowledgeBase({
  database: { url: 'file://./demo.db' }
});

// Ingest a document
await kb.process({
  type: 'ingest',
  source: {
    type: 'text',
    content: 'Machine learning is a subset of artificial intelligence...',
    title: 'ML Basics'
  }
});

// Search for content
const results = await kb.process({
  type: 'search',
  query: 'machine learning',
  config: { searchType: 'hybrid', limit: 5 }
});

console.log(results.results[0].content);
```

### Web Content Ingestion
```typescript
// Scrape and index a web page
await kb.process({
  type: 'ingest',
  source: {
    type: 'url',
    url: 'https://en.wikipedia.org/wiki/Natural_language_processing'
  },
  config: {
    provider: 'web',
    options: {
      selector: '#mw-content-text',
      chunkSize: 1200,
      chunkStrategy: 'semantic'
    }
  }
});
```

### Collection Management
```typescript
// Create a collection
await kb.process({
  type: 'collections',
  action: 'create',
  data: {
    name: 'AI Research Papers',
    description: 'Collection of AI and ML research papers',
    metadata: { topic: 'artificial-intelligence' }
  }
});

// Add document to collection
await kb.process({
  type: 'ingest',
  source: { /* document source */ },
  collectionId: 'collection-uuid'
});
```

Ready to build powerful document processing and search capabilities! 🚀 