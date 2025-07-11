/**
 * Knowledge Base Database Operations
 * Implementation using ominipg for PostgreSQL operations
 */

import type {
  DatabaseOperations,
  DocumentEntity,
  ChunkEntity,
  CollectionEntity,
  SearchResult,
  QueryOptions
} from '../types.ts';

import {
  KnowledgeBaseError,
  ErrorCodes
} from '../types.ts';
import { knowledgeBaseSchema, knowledgeBaseSchemaNoPgVector, schemaValidation } from './schema.ts';

export class KnowledgeBaseDatabaseOperations implements DatabaseOperations {
  private db: any; // Ominipg instance
  private hasPgVector: boolean = false;

  constructor(private ominipg: any) {
    this.db = ominipg;
  }

  /**
   * Initialize the database with schema and check capabilities
   */
  async initialize(): Promise<void> {
    try {
      // Check if pgvector is available
      const vectorCheck = await this.db.query(schemaValidation.checkPgVectorSupport);
      this.hasPgVector = vectorCheck.rows[0]?.exists || false;

      console.log(`📊 Database initialized. pgvector support: ${this.hasPgVector ? '✅' : '❌'}`);
    } catch (error) {
      console.warn('Database capability check failed:', error);
      this.hasPgVector = false;
    }
  }

  // =============================================================================
  // DOCUMENT OPERATIONS
  // =============================================================================

  async insertDocument(doc: Omit<DocumentEntity, 'id' | 'createdAt' | 'updatedAt'>): Promise<string> {
    try {
      const query = `
        INSERT INTO documents (
          title, content, document_type, source_type, source_url, 
          file_name, file_size, mime_type, metadata, extracted_at, status, error_message
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        RETURNING id
      `;

      const values = [
        doc.title,
        doc.content,
        doc.documentType,
        doc.sourceType,
        doc.sourceUrl || null,
        doc.fileName || null,
        doc.fileSize || null,
        doc.mimeType || null,
        JSON.stringify(doc.metadata),
        doc.extractedAt,
        doc.status,
        doc.errorMessage || null
      ];

      const result = await this.db.query(query, values);
      return result.rows[0].id;
    } catch (error) {
      throw new KnowledgeBaseError(
        `Failed to insert document: ${error.message}`,
        ErrorCodes.DATABASE_ERROR,
        error
      );
    }
  }

  async getDocument(id: string): Promise<DocumentEntity | null> {
    try {
      const query = `
        SELECT 
          id, title, content, document_type, source_type, source_url,
          file_name, file_size, mime_type, metadata, extracted_at,
          created_at, updated_at, status, error_message
        FROM documents 
        WHERE id = $1
      `;

      const result = await this.db.query(query, [id]);
      
      if (result.rows.length === 0) {
        return null;
      }

      const row = result.rows[0];
      return {
        id: row.id,
        title: row.title,
        content: row.content,
        documentType: row.document_type,
        sourceType: row.source_type,
        sourceUrl: row.source_url,
        fileName: row.file_name,
        fileSize: row.file_size,
        mimeType: row.mime_type,
        metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata,
        extractedAt: row.extracted_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        status: row.status,
        errorMessage: row.error_message
      };
    } catch (error) {
      throw new KnowledgeBaseError(
        `Failed to get document: ${error.message}`,
        ErrorCodes.DATABASE_ERROR,
        error
      );
    }
  }

  async updateDocument(id: string, updates: Partial<DocumentEntity>): Promise<boolean> {
    try {
      const setClause = [];
      const values = [];
      let paramCount = 1;

      // Build dynamic SET clause
      if (updates.title !== undefined) {
        setClause.push(`title = $${paramCount++}`);
        values.push(updates.title);
      }
      if (updates.content !== undefined) {
        setClause.push(`content = $${paramCount++}`);
        values.push(updates.content);
      }
      if (updates.status !== undefined) {
        setClause.push(`status = $${paramCount++}`);
        values.push(updates.status);
      }
      if (updates.metadata !== undefined) {
        setClause.push(`metadata = $${paramCount++}`);
        values.push(JSON.stringify(updates.metadata));
      }
      if (updates.errorMessage !== undefined) {
        setClause.push(`error_message = $${paramCount++}`);
        values.push(updates.errorMessage);
      }

      if (setClause.length === 0) {
        return true; // Nothing to update
      }

      values.push(id);
      const query = `
        UPDATE documents 
        SET ${setClause.join(', ')} 
        WHERE id = $${paramCount}
      `;

      const result = await this.db.query(query, values);
      return result.rowCount > 0;
    } catch (error) {
      throw new KnowledgeBaseError(
        `Failed to update document: ${error.message}`,
        ErrorCodes.DATABASE_ERROR,
        error
      );
    }
  }

  async deleteDocument(id: string): Promise<boolean> {
    try {
      const query = `DELETE FROM documents WHERE id = $1`;
      const result = await this.db.query(query, [id]);
      return result.rowCount > 0;
    } catch (error) {
      throw new KnowledgeBaseError(
        `Failed to delete document: ${error.message}`,
        ErrorCodes.DATABASE_ERROR,
        error
      );
    }
  }

  async listDocuments(filters?: any, limit: number = 50, offset: number = 0): Promise<DocumentEntity[]> {
    try {
      let query = `
        SELECT 
          id, title, content, document_type, source_type, source_url,
          file_name, file_size, mime_type, metadata, extracted_at,
          created_at, updated_at, status, error_message
        FROM documents
      `;
      
      const conditions = [];
      const values = [];
      let paramCount = 1;

      // Apply filters
      if (filters?.documentType) {
        conditions.push(`document_type = ANY($${paramCount++})`);
        values.push(Array.isArray(filters.documentType) ? filters.documentType : [filters.documentType]);
      }
      
      if (filters?.status) {
        conditions.push(`status = $${paramCount++}`);
        values.push(filters.status);
      }

      if (filters?.createdAfter) {
        conditions.push(`created_at >= $${paramCount++}`);
        values.push(filters.createdAfter);
      }

      if (filters?.createdBefore) {
        conditions.push(`created_at <= $${paramCount++}`);
        values.push(filters.createdBefore);
      }

      if (conditions.length > 0) {
        query += ` WHERE ${conditions.join(' AND ')}`;
      }

      query += ` ORDER BY created_at DESC LIMIT $${paramCount++} OFFSET $${paramCount++}`;
      values.push(limit, offset);

      const result = await this.db.query(query, values);
      
      return result.rows.map((row: any) => ({
        id: row.id,
        title: row.title,
        content: row.content,
        documentType: row.document_type,
        sourceType: row.source_type,
        sourceUrl: row.source_url,
        fileName: row.file_name,
        fileSize: row.file_size,
        mimeType: row.mime_type,
        metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata,
        extractedAt: row.extracted_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        status: row.status,
        errorMessage: row.error_message
      }));
    } catch (error) {
      throw new KnowledgeBaseError(
        `Failed to list documents: ${error.message}`,
        ErrorCodes.DATABASE_ERROR,
        error
      );
    }
  }

  // =============================================================================
  // CHUNK OPERATIONS
  // =============================================================================

  async insertChunks(chunks: Omit<ChunkEntity, 'id' | 'createdAt'>[]): Promise<string[]> {
    try {
      const insertedIds: string[] = [];
      
      for (const chunk of chunks) {
        const query = `
          INSERT INTO chunks (
            document_id, content, start_index, end_index, chunk_index, 
            metadata, embedding, embedding_model, embedded_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          RETURNING id
        `;

        const embeddingValue = this.hasPgVector 
          ? chunk.embedding 
          : chunk.embedding ? JSON.stringify(chunk.embedding) : null;

        const values = [
          chunk.documentId,
          chunk.content,
          chunk.startIndex,
          chunk.endIndex,
          chunk.chunkIndex,
          JSON.stringify(chunk.metadata),
          embeddingValue,
          chunk.embeddingModel || null,
          chunk.embeddedAt || null
        ];

        const result = await this.db.query(query, values);
        insertedIds.push(result.rows[0].id);
      }

      return insertedIds;
    } catch (error) {
      throw new KnowledgeBaseError(
        `Failed to insert chunks: ${error.message}`,
        ErrorCodes.DATABASE_ERROR,
        error
      );
    }
  }

  async getChunks(documentId: string): Promise<ChunkEntity[]> {
    try {
      const embeddingColumn = this.hasPgVector ? 'embedding' : 'embedding_json';
      const query = `
        SELECT 
          id, document_id, content, start_index, end_index, chunk_index,
          metadata, ${embeddingColumn} as embedding_data, embedding_model, embedded_at, created_at
        FROM chunks 
        WHERE document_id = $1 
        ORDER BY chunk_index
      `;

      const result = await this.db.query(query, [documentId]);
      
      return result.rows.map((row: any) => ({
        id: row.id,
        documentId: row.document_id,
        content: row.content,
        startIndex: row.start_index,
        endIndex: row.end_index,
        chunkIndex: row.chunk_index,
        metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata,
        embedding: this.hasPgVector 
          ? row.embedding_data 
          : row.embedding_data ? JSON.parse(row.embedding_data) : undefined,
        embeddingModel: row.embedding_model,
        embeddedAt: row.embedded_at,
        createdAt: row.created_at
      }));
    } catch (error) {
      throw new KnowledgeBaseError(
        `Failed to get chunks: ${error.message}`,
        ErrorCodes.DATABASE_ERROR,
        error
      );
    }
  }

  async updateChunkEmbedding(id: string, embedding: number[], model: string): Promise<boolean> {
    try {
      let query: string;
      let values: any[];
      
      if (this.hasPgVector) {
        // For pgvector, convert array to string and cast to vector type
        const embeddingStr = JSON.stringify(embedding);
        query = `
          UPDATE chunks 
          SET embedding = $1::vector, embedding_model = $2, embedded_at = NOW()
          WHERE id = $3
        `;
        values = [embeddingStr, model, id];
      } else {
        // For JSON fallback
        query = `
          UPDATE chunks 
          SET embedding_json = $1, embedding_model = $2, embedded_at = NOW()
          WHERE id = $3
        `;
        values = [JSON.stringify(embedding), model, id];
      }

      const result = await this.db.query(query, values);
      return result.rowCount > 0;
    } catch (error) {
      throw new KnowledgeBaseError(
        `Failed to update chunk embedding: ${error.message}`,
        ErrorCodes.DATABASE_ERROR,
        error
      );
    }
  }

  async deleteChunks(documentId: string): Promise<boolean> {
    try {
      const query = `DELETE FROM chunks WHERE document_id = $1`;
      const result = await this.db.query(query, [documentId]);
      return result.rowCount > 0;
    } catch (error) {
      throw new KnowledgeBaseError(
        `Failed to delete chunks: ${error.message}`,
        ErrorCodes.DATABASE_ERROR,
        error
      );
    }
  }

  // =============================================================================
  // COLLECTION OPERATIONS
  // =============================================================================

  async createCollection(collection: Omit<CollectionEntity, 'id' | 'createdAt' | 'updatedAt'>): Promise<string> {
    try {
      const query = `
        INSERT INTO collections (name, description, metadata)
        VALUES ($1, $2, $3)
        RETURNING id
      `;

      const values = [
        collection.name,
        collection.description || null,
        JSON.stringify(collection.metadata)
      ];

      const result = await this.db.query(query, values);
      return result.rows[0].id;
    } catch (error) {
      throw new KnowledgeBaseError(
        `Failed to create collection: ${error.message}`,
        ErrorCodes.DATABASE_ERROR,
        error
      );
    }
  }

  async getCollection(id: string): Promise<CollectionEntity | null> {
    try {
      const query = `
        SELECT id, name, description, metadata, created_at, updated_at
        FROM collections 
        WHERE id = $1
      `;

      const result = await this.db.query(query, [id]);
      
      if (result.rows.length === 0) {
        return null;
      }

      const row = result.rows[0];
      return {
        id: row.id,
        name: row.name,
        description: row.description,
        metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      };
    } catch (error) {
      throw new KnowledgeBaseError(
        `Failed to get collection: ${error.message}`,
        ErrorCodes.DATABASE_ERROR,
        error
      );
    }
  }

  async listCollections(): Promise<CollectionEntity[]> {
    try {
      const query = `
        SELECT id, name, description, metadata, created_at, updated_at
        FROM collections 
        ORDER BY created_at DESC
      `;

      const result = await this.db.query(query);
      
      return result.rows.map((row: any) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      }));
    } catch (error) {
      throw new KnowledgeBaseError(
        `Failed to list collections: ${error.message}`,
        ErrorCodes.DATABASE_ERROR,
        error
      );
    }
  }

  async addDocumentToCollection(documentId: string, collectionId: string): Promise<boolean> {
    try {
      const query = `
        INSERT INTO document_collections (document_id, collection_id)
        VALUES ($1, $2)
        ON CONFLICT (document_id, collection_id) DO NOTHING
      `;

      await this.db.query(query, [documentId, collectionId]);
      return true;
    } catch (error) {
      throw new KnowledgeBaseError(
        `Failed to add document to collection: ${error.message}`,
        ErrorCodes.DATABASE_ERROR,
        error
      );
    }
  }

  async removeDocumentFromCollection(documentId: string, collectionId: string): Promise<boolean> {
    try {
      const query = `
        DELETE FROM document_collections 
        WHERE document_id = $1 AND collection_id = $2
      `;

      const result = await this.db.query(query, [documentId, collectionId]);
      return result.rowCount > 0;
    } catch (error) {
      throw new KnowledgeBaseError(
        `Failed to remove document from collection: ${error.message}`,
        ErrorCodes.DATABASE_ERROR,
        error
      );
    }
  }

  // =============================================================================
  // SEARCH OPERATIONS
  // =============================================================================

  async searchSemantic(embedding: number[], options: QueryOptions): Promise<SearchResult[]> {
    try {
      if (!this.hasPgVector) {
        // Fallback to simple search if no pgvector
        return await this.searchKeyword(options.keywords?.join(' ') || '', options);
      }

      const embeddingStr = JSON.stringify(embedding);
      let query = `
        SELECT 
          c.id as chunk_id,
          c.document_id,
          c.content,
          c.metadata as chunk_metadata,
          c.embedding <=> $1::vector as distance,
          1 - (c.embedding <=> $1::vector) as score,
          d.title,
          d.document_type,
          d.source_url,
          d.file_name,
          d.created_at
        FROM chunks c
        JOIN documents d ON c.document_id = d.id
        WHERE c.embedding IS NOT NULL
      `;

      const values = [embeddingStr];
      let paramCount = 2;

      // Apply filters
      if (options.filters?.documentType) {
        query += ` AND d.document_type = ANY($${paramCount++})`;
        values.push(options.filters.documentType);
      }

      if (options.threshold) {
        query += ` AND (1 - (c.embedding <=> $1::vector)) >= $${paramCount++}`;
        values.push(options.threshold);
      }

      query += ` ORDER BY c.embedding <=> $1::vector`;
      
      if (options.limit) {
        query += ` LIMIT $${paramCount++}`;
        values.push(options.limit);
      }

      if (options.offset) {
        query += ` OFFSET $${paramCount++}`;
        values.push(options.offset);
      }

      const result = await this.db.query(query, values);
      
      return result.rows.map((row: any) => ({
        documentId: row.document_id,
        chunkId: row.chunk_id,
        content: row.content,
        score: parseFloat(row.score),
        metadata: typeof row.chunk_metadata === 'string' ? JSON.parse(row.chunk_metadata) : row.chunk_metadata,
        document: {
          title: row.title,
          documentType: row.document_type,
          sourceUrl: row.source_url,
          fileName: row.file_name,
          createdAt: row.created_at
        }
      }));
    } catch (error) {
      throw new KnowledgeBaseError(
        `Failed to perform semantic search: ${error.message}`,
        ErrorCodes.DATABASE_ERROR,
        error
      );
    }
  }

  async searchKeyword(query: string, options: QueryOptions): Promise<SearchResult[]> {
    try {
      let searchQuery = `
        SELECT 
          c.id as chunk_id,
          c.document_id,
          c.content,
          c.metadata as chunk_metadata,
          ts_rank(to_tsvector('english', c.content), plainto_tsquery('english', $1)) as score,
          d.title,
          d.document_type,
          d.source_url,
          d.file_name,
          d.created_at
        FROM chunks c
        JOIN documents d ON c.document_id = d.id
        WHERE to_tsvector('english', c.content) @@ plainto_tsquery('english', $1)
      `;

      const values = [query];
      let paramCount = 2;

      // Apply filters
      if (options.filters?.documentType) {
        searchQuery += ` AND d.document_type = ANY($${paramCount++})`;
        values.push(options.filters.documentType);
      }

      if (options.threshold) {
        searchQuery += ` AND ts_rank(to_tsvector('english', c.content), plainto_tsquery('english', $1)) >= $${paramCount++}`;
        values.push(options.threshold);
      }

      searchQuery += ` ORDER BY score DESC`;
      
      if (options.limit) {
        searchQuery += ` LIMIT $${paramCount++}`;
        values.push(options.limit);
      }

      if (options.offset) {
        searchQuery += ` OFFSET $${paramCount++}`;
        values.push(options.offset);
      }

      const result = await this.db.query(searchQuery, values);
      
      return result.rows.map((row: any) => ({
        documentId: row.document_id,
        chunkId: row.chunk_id,
        content: row.content,
        score: parseFloat(row.score),
        metadata: typeof row.chunk_metadata === 'string' ? JSON.parse(row.chunk_metadata) : row.chunk_metadata,
        document: {
          title: row.title,
          documentType: row.document_type,
          sourceUrl: row.source_url,
          fileName: row.file_name,
          createdAt: row.created_at
        }
      }));
    } catch (error) {
      throw new KnowledgeBaseError(
        `Failed to perform keyword search: ${error.message}`,
        ErrorCodes.DATABASE_ERROR,
        error
      );
    }
  }

  async searchHybrid(query: string, embedding: number[], options: QueryOptions): Promise<SearchResult[]> {
    try {
      // Get both semantic and keyword results
      const [semanticResults, keywordResults] = await Promise.all([
        this.searchSemantic(embedding, { ...options, limit: options.limit || 50 }),
        this.searchKeyword(query, { ...options, limit: options.limit || 50 })
      ]);

      // Combine and rerank results
      const combinedResults = new Map<string, SearchResult>();
      
      // Add semantic results with weight
      const semanticWeight = 0.7;
      semanticResults.forEach(result => {
        combinedResults.set(result.chunkId, {
          ...result,
          score: result.score * semanticWeight
        });
      });

      // Add keyword results with weight and combine scores
      const keywordWeight = 0.3;
      keywordResults.forEach(result => {
        const existing = combinedResults.get(result.chunkId);
        if (existing) {
          existing.score += result.score * keywordWeight;
        } else {
          combinedResults.set(result.chunkId, {
            ...result,
            score: result.score * keywordWeight
          });
        }
      });

      // Sort by combined score and return
      return Array.from(combinedResults.values())
        .sort((a, b) => b.score - a.score)
        .slice(0, options.limit || 20);
    } catch (error) {
      throw new KnowledgeBaseError(
        `Failed to perform hybrid search: ${error.message}`,
        ErrorCodes.DATABASE_ERROR,
        error
      );
    }
  }
} 