import { processKnowledgeBaseRequest, createKnowledgeBase } from '../../services/knowledge/index.ts';
import type { 
  KnowledgeBaseRequest, 
  KnowledgeBaseResponse, 
  KnowledgeBaseConfig,
  DocumentSource,
  DeepPartial
} from '../../services/knowledge/types.ts';

/**
 * REST-Compliant Knowledge Base Endpoint using Oxian-js Framework
 * Separates read and write operations following REST conventions
 * 
 * GET Operations (Read-only):
 * - query: Semantic search with embeddings
 * - search: Hybrid search (semantic + keyword)
 * - retrieve: Get specific documents by ID
 * - collections: List collections only
 * 
 * POST Operations (Write):
 * - ingest: Add documents from various sources
 * - delete: Remove documents
 * - collections: Create/delete collections
 * 
 * Usage Examples:
 * GET /features/knowledge?type=query&q=machine learning - Semantic search
 * GET /features/knowledge?type=search&q=AI technology - Document search
 * GET /features/knowledge?type=retrieve&documentId=123 - Get document
 * GET /features/knowledge?type=collections&action=list - List collections
 * 
 * POST /features/knowledge - Write operations (body contains full request)
 * Body: { "type": "ingest", "source": { "type": "text", "content": "..." } }
 * Body: { "type": "delete", "documentId": "123" }
 * Body: { "type": "collections", "action": "create", "data": {...} }
 */

/**
 * POST: Write operations (ingest, delete, collections create/delete)
 * Accepts write requests in body with type discrimination
 */
export const POST = async (props: any, res: any) => {
    try {
        const request = props as KnowledgeBaseRequest;

        // Validate request has required type
        if (!request.type) {
            res.status(400);
            return {
                success: false,
                error: 'Missing required field: type',
                supportedWriteTypes: ['ingest', 'delete', 'collections']
            };
        }

        // Validate this is a write operation
        if (!['ingest', 'delete', 'collections'].includes(request.type)) {
            res.status(400);
            return {
                success: false,
                error: `Invalid write operation: ${request.type}. Use GET for read operations.`,
                supportedWriteTypes: ['ingest', 'delete', 'collections'],
                supportedReadTypes: ['query', 'search', 'retrieve', 'collections (list only)']
            };
        }

        // For collections, only allow create/delete actions
        if (request.type === 'collections' && request.action === 'list') {
            res.status(400);
            return {
                success: false,
                error: 'Collections list operation should use GET method',
                supportedWriteTypes: ['ingest', 'delete', 'collections (create/delete only)']
            };
        }

        // Validate specific request requirements
        const validation = validateRequest(request);
        if (!validation.valid) {
            res.status(400);
            return {
                success: false,
                error: validation.error,
                supportedWriteTypes: ['ingest', 'delete', 'collections']
            };
        }

        console.log(`📚 Knowledge Write Request: ${request.type}`);
        const startTime = Date.now();

        // Get default config from environment
        const config = getDefaultConfig();

        // Process knowledge base request
        const response: KnowledgeBaseResponse = await processKnowledgeBaseRequest(request, config);

        const duration = Date.now() - startTime;
        console.log(`✅ Knowledge Write Response: ${request.type} completed in ${duration}ms`);

        // Return successful response
        return {
            ...response,
            success: response.type !== 'ingest' || (response as any).success !== false,
            duration
        };

    } catch (error) {
        console.error('❌ Knowledge Write Endpoint Error:', error);
        res.status(500);
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
            timestamp: new Date().toISOString()
        };
    }
};

/**
 * GET: Read operations (query, search, retrieve, collections list)
 * Supports read-only operations via URL parameters
 */
export const GET = async (props: any, res: any) => {
    try {
        const { type, q, query, documentId, collection, action, ...otherParams } = props;

        // Health check endpoint
        if (!type) {
            return {
                status: 'healthy',
                message: 'Copilotz Knowledge Base Service is running',
                version: '1.0.0',
                endpoints: {
                    'GET /features/knowledge': 'Service health check',
                    'GET /features/knowledge?type=query&q=machine learning': 'Semantic search',
                    'GET /features/knowledge?type=search&q=AI technology': 'Document search',
                    'GET /features/knowledge?type=retrieve&documentId=123': 'Document retrieval',
                    'GET /features/knowledge?type=collections': 'List collections',
                    'POST /features/knowledge': 'Write operations (ingest, delete, collections create/delete)'
                },
                readOperations: ['query', 'search', 'retrieve', 'collections'],
                writeOperations: ['ingest', 'delete', 'collections'],
                supportedSources: ['text', 'url', 'file', 'base64'],
                supportedExtractors: ['text', 'web', 'pdf', 'doc', 'csv', 'json', 'audio', 'video'],
                supportedSearchTypes: ['semantic', 'keyword', 'hybrid']
            };
        }

        // Validate this is a read operation
        if (!['query', 'search', 'retrieve', 'collections'].includes(type.toLowerCase())) {
            res.status(400);
            return {
                success: false,
                error: `Invalid read operation: ${type}. Use POST for write operations.`,
                supportedReadTypes: ['query', 'search', 'retrieve', 'collections (list only)'],
                supportedWriteTypes: ['ingest', 'delete', 'collections (create/delete)']
            };
        }

        // For collections, only allow list action
        if (type.toLowerCase() === 'collections' && action && action !== 'list') {
            res.status(400);
            return {
                success: false,
                error: 'Collections create/delete operations should use POST method',
                supportedReadTypes: ['query', 'search', 'retrieve', 'collections (list only)']
            };
        }

        console.log(`📚 Knowledge Read Request: ${type}`);
        const startTime = Date.now();

        // Get default config
        const config = getDefaultConfig();
        let request: KnowledgeBaseRequest;

        // Route to appropriate service based on type
        switch (type.toLowerCase()) {
            case 'query': {
                if (!q && !query) {
                    res.status(400);
                    return { success: false, error: 'Missing required parameter: q or query' };
                }

                request = {
                    type: 'query',
                    query: q || query,
                    config: {
                        limit: parseInt(otherParams.limit) || 5,
                        threshold: parseFloat(otherParams.threshold) || 0.7,
                        includeMetadata: otherParams.includeMetadata === 'true',
                        ...otherParams
                    },
                    collectionId: collection
                };
                break;
            }

            case 'search': {
                if (!q && !query) {
                    res.status(400);
                    return { success: false, error: 'Missing required parameter: q or query' };
                }

                request = {
                    type: 'search',
                    query: q || query,
                    config: {
                        searchType: otherParams.searchType || 'hybrid',
                        limit: parseInt(otherParams.limit) || 10,
                        threshold: parseFloat(otherParams.threshold) || 0.5,
                        keywordWeight: parseFloat(otherParams.keywordWeight) || 0.3,
                        semanticWeight: parseFloat(otherParams.semanticWeight) || 0.7,
                        includeMetadata: otherParams.includeMetadata === 'true',
                        ...otherParams
                    },
                    collectionId: collection
                };
                break;
            }

            case 'retrieve': {
                if (!documentId) {
                    res.status(400);
                    return { success: false, error: 'Missing required parameter: documentId' };
                }

                request = {
                    type: 'retrieve',
                    documentId
                };
                break;
            }

            case 'collections': {
                request = {
                    type: 'collections',
                    action: 'list',
                    data: undefined
                };
                break;
            }

            default: {
                res.status(400);
                return {
                    success: false,
                    error: `Unknown read operation: ${type}`,
                    supportedReadTypes: ['query', 'search', 'retrieve', 'collections']
                };
            }
        }

        // Process the request
        const response = await processKnowledgeBaseRequest(request, config);

        const duration = Date.now() - startTime;
        console.log(`✅ Knowledge Read Response: ${type} completed in ${duration}ms`);

        return {
            ...response,
            success: response.type === 'retrieve' ? (response as any).error === undefined : true,
            duration,
            provider: config.embedding?.provider || 'openai',
            operation: type
        };

    } catch (error) {
        console.error('❌ Knowledge Read Endpoint Error:', error);
        res.status(500);
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
            timestamp: new Date().toISOString()
        };
    }
};

/**
 * Validate knowledge base request structure
 */
function validateRequest(request: KnowledgeBaseRequest): { valid: boolean; error?: string } {
    switch (request.type) {
        case 'ingest':
            if (!request.source) {
                return { valid: false, error: 'Missing required field: source' };
            }
            break;
        case 'query':
        case 'search':
            if (!request.query) {
                return { valid: false, error: 'Missing required field: query' };
            }
            break;
        case 'retrieve':
        case 'delete':
            if (!request.documentId) {
                return { valid: false, error: 'Missing required field: documentId' };
            }
            break;
        case 'collections':
            if (!request.action) {
                return { valid: false, error: 'Missing required field: action' };
            }
            // For write operations, ensure action is create or delete
            if (request.action !== 'list' && request.action !== 'create' && request.action !== 'delete') {
                return { valid: false, error: 'Collections action must be: list, create, or delete' };
            }
            break;
    }
    return { valid: true };
}

/**
 * Get default configuration from environment variables
 */
function getDefaultConfig(): DeepPartial<KnowledgeBaseConfig> {
    const databaseUrl = Deno.env.get('DATABASE_URL') || Deno.env.get('POSTGRES_URL') || ':memory:';
    const openaiKey = Deno.env.get('DEFAULT_OPENAI_KEY') || Deno.env.get('OPENAI_API_KEY');
    
    return {
        database: {
            url: databaseUrl,
            syncUrl: Deno.env.get('DATABASE_SYNC_URL')
        },
        embedding: {
            provider: 'openai',
            model: 'text-embedding-3-small',
            dimensions: 1536
        },
        chunking: {
            strategy: 'sentences',
            size: 500,
            overlap: 50,
            preserveStructure: true,
            minChunkSize: 100,
            maxChunkSize: 1000
        },
        extractors: {
            text: { chunkSize: 500, chunkStrategy: 'sentences' },
            web: { waitFor: 2000, selector: 'article, main, .content, body' },
            pdf: { ocrLanguage: 'eng' },
            audio: { transcriptionProvider: 'openai' },
            video: { transcriptionProvider: 'openai' }
        }
    };
}

/**
 * Determine the appropriate provider based on document source
 */
function getProviderFromSource(source: DocumentSource): any {
    switch (source.type) {
        case 'url':
            return 'web';
        case 'text':
            return 'text';
        case 'file':
            // Try to determine from file extension or mime type
            const fileName = source.fileName || '';
            if (fileName.endsWith('.pdf')) return 'pdf';
            if (fileName.endsWith('.docx') || fileName.endsWith('.doc')) return 'doc';
            if (fileName.endsWith('.csv')) return 'csv';
            if (fileName.endsWith('.json')) return 'json';
            if (fileName.endsWith('.mp3') || fileName.endsWith('.wav')) return 'audio';
            if (fileName.endsWith('.mp4') || fileName.endsWith('.avi')) return 'video';
            return 'text';
        case 'base64':
            const mimeType = source.mimeType || '';
            if (mimeType.includes('pdf')) return 'pdf';
            if (mimeType.includes('audio')) return 'audio';
            if (mimeType.includes('video')) return 'video';
            return 'text';
        default:
            return 'text';
    }
} 