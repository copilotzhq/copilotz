/**
 * Action Schema V2
 * 
 * This schema represents the new unified action structure with
 * JSON Schema as the single source of truth for validation.
 */

export default {
    "_id": "string",
    "name": "string", // Human readable name
    "description": "string", // Human readable description
    "inputSchema": "object", // JSON schema for input validation
    "outputSchema": "object", // JSON schema for output validation
    "handler": { // Function or URL string
        "type": "string^!"
    },
    "openAPISchema": "string?", // OpenAPI schema URL or content (optional)
    "mcpServer": { // MCP server configuration (optional)
        "url": "string!",
        "headers": "object?",
        "options": "object?"
    }
} 