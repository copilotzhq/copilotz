/**
 * Knowledge Base Endpoint Test
 * Demonstrates usage of the unified knowledge base endpoint
 */

import { POST, GET } from './index.ts';

console.log('🧪 Testing Knowledge Base Endpoint...\n');

// Mock response object
const mockRes = {
    status: (code: number) => console.log(`Status: ${code}`),
    statusCode: 200
};

// Test 1: Health Check
console.log('1. Testing Health Check...');
try {
    const healthResponse = await GET({}, mockRes);
    console.log('✅ Health check successful');
    console.log('   Service:', healthResponse.message);
    console.log('   Version:', healthResponse.version);
    console.log('   Read Operations:', healthResponse.readOperations?.join(', '));
    console.log('   Write Operations:', healthResponse.writeOperations?.join(', '));
} catch (error) {
    console.log('❌ Health check failed:', error instanceof Error ? error.message : String(error));
}

// Test 2: REST Compliance - Write operation via GET (should fail)
console.log('\n2. Testing REST Compliance - Write operation via GET...');
try {
    const ingestResponse = await GET({
        type: 'ingest',
        text: 'This should fail'
    }, mockRes);
    
    if (ingestResponse.success === false) {
        console.log('✅ REST compliance working - GET rejects write operations');
        console.log('   Error:', ingestResponse.error);
    } else {
        console.log('❌ Should have failed but got success:', ingestResponse.success);
    }
} catch (error) {
    console.log('❌ Unexpected error:', error instanceof Error ? error.message : String(error));
}

// Test 3: Document Ingestion via POST
console.log('\n3. Testing Document Ingestion via POST...');
let testDocumentId: string | undefined;
try {
    const postIngestResponse = await POST({
        type: 'ingest',
        source: {
            type: 'text',
            content: 'This is another test document about machine learning. It discusses deep learning, neural networks, and artificial intelligence applications.',
            title: 'ML Test Document'
        },
        config: {
            provider: 'text',
            options: {
                chunkSize: 200,
                chunkStrategy: 'sentences',
                chunkOverlap: 50
            }
        }
    }, mockRes);
    
    if (postIngestResponse.success) {
        console.log('✅ POST ingestion successful');
        console.log('   Document ID:', postIngestResponse.documentId);
        console.log('   Chunks created:', postIngestResponse.chunks);
        console.log('   Processing time:', postIngestResponse.duration + 'ms');
        testDocumentId = postIngestResponse.documentId;
    } else {
        console.log('⚠️  POST ingestion completed with issues:', postIngestResponse.error);
    }
} catch (error) {
    console.log('❌ POST ingestion failed:', error instanceof Error ? error.message : String(error));
}

// Test 4: Collections Management (GET - read only)
console.log('\n4. Testing Collections Management (GET - read only)...');
try {
    const collectionsResponse = await GET({
        type: 'collections'
    }, mockRes);
    
    if (collectionsResponse.success !== false) {
        console.log('✅ Collections listing successful');
        console.log('   Collections found:', collectionsResponse.collections?.length || 0);
    } else {
        console.log('⚠️  Collections listing completed with issues:', collectionsResponse.error);
    }
} catch (error) {
    console.log('❌ Collections listing failed:', error instanceof Error ? error.message : String(error));
}

// Test 5: Collections Create via POST
console.log('\n5. Testing Collections Create via POST...');
try {
    const createResponse = await POST({
        type: 'collections',
        action: 'create',
        data: {
            name: 'Test Collection',
            description: 'A test collection',
            metadata: { created_by: 'test' }
        }
    }, mockRes);
    
    if (createResponse.success !== false) {
        console.log('✅ Collection creation successful');
    } else {
        console.log('⚠️  Collection creation completed with issues:', createResponse.error);
    }
} catch (error) {
    console.log('❌ Collection creation failed:', error instanceof Error ? error.message : String(error));
}

// Test 6: Read Operations via GET
console.log('\n6. Testing Read Operations via GET...');

// Test query operation
console.log('   Testing query operation...');
try {
    const queryResponse = await GET({
        type: 'query',
        q: 'artificial intelligence',
        limit: 3
    }, mockRes);
    
    if (queryResponse.success !== false) {
        console.log('   ✅ Query operation successful');
        console.log('      Results:', queryResponse.results?.length || 0);
    } else {
        console.log('   ⚠️  Query operation failed (expected - no embeddings):', queryResponse.error);
    }
} catch (error) {
    console.log('   ⚠️  Query operation failed (expected - no embeddings):', error instanceof Error ? error.message : String(error));
}

// Test search operation with keyword search (should work without embeddings)
console.log('   Testing keyword search operation...');
try {
    const searchResponse = await GET({
        type: 'search',
        q: 'machine learning',
        searchType: 'keyword',
        limit: 5
    }, mockRes);
    
    if (searchResponse.success !== false) {
        console.log('   ✅ Keyword search operation successful');
        console.log('      Results:', searchResponse.results?.length || 0);
    } else {
        console.log('   ⚠️  Keyword search failed:', searchResponse.error);
    }
} catch (error) {
    console.log('   ⚠️  Keyword search failed:', error instanceof Error ? error.message : String(error));
}

// Test 7: Document Retrieval via GET
console.log('\n7. Testing Document Retrieval via GET...');
if (testDocumentId) {
    try {
        const retrieveResponse = await GET({
            type: 'retrieve',
            documentId: testDocumentId
        }, mockRes);
        
        if (retrieveResponse.success !== false) {
            console.log('✅ Document retrieval successful');
            console.log('   Document title:', retrieveResponse.document?.title);
            console.log('   Chunks found:', retrieveResponse.chunks?.length || 0);
        } else {
            console.log('⚠️  Document retrieval failed:', retrieveResponse.error);
        }
    } catch (error) {
        console.log('❌ Document retrieval failed:', error instanceof Error ? error.message : String(error));
    }
} else {
    console.log('⚠️  Skipping document retrieval - no document ID available');
}

// Test 8: Error Handling
console.log('\n8. Testing Error Handling...');
try {
    const errorResponse = await POST({
        type: 'invalid-type'
    }, mockRes);
    
    if (!errorResponse.success) {
        console.log('✅ Error handling working correctly');
        console.log('   Error:', errorResponse.error);
        console.log('   Supported types:', errorResponse.supportedWriteTypes?.join(', '));
    }
} catch (error) {
    console.log('❌ Error handling test failed:', error instanceof Error ? error.message : String(error));
}

console.log('\n🎉 Knowledge Base Endpoint Tests Complete!');
console.log('\nREST-Compliant Usage Examples:');
console.log('===============================');
console.log('');
console.log('📖 READ OPERATIONS (GET):');
console.log('-------------------------');
console.log('1. Health Check:');
console.log('   GET /features/knowledge');
console.log('');
console.log('2. Semantic Search:');
console.log('   GET /features/knowledge?type=query&q=machine learning');
console.log('');
console.log('3. Document Search:');
console.log('   GET /features/knowledge?type=search&q=AI&searchType=hybrid');
console.log('');
console.log('4. Document Retrieval:');
console.log('   GET /features/knowledge?type=retrieve&documentId=123');
console.log('');
console.log('5. List Collections:');
console.log('   GET /features/knowledge?type=collections');
console.log('');
console.log('✏️  WRITE OPERATIONS (POST):');
console.log('----------------------------');
console.log('6. Document Ingestion:');
console.log('   POST /features/knowledge');
console.log('   Body: { "type": "ingest", "source": { "type": "text", "content": "..." } }');
console.log('');
console.log('7. Document Deletion:');
console.log('   POST /features/knowledge');
console.log('   Body: { "type": "delete", "documentId": "123" }');
console.log('');
console.log('8. Collections Management:');
console.log('   POST /features/knowledge');
console.log('   Body: { "type": "collections", "action": "create", "data": {...} }');
console.log(''); 