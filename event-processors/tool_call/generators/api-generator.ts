
import type { API } from "@/interfaces/index.ts";
import { parse as parseYaml } from "yaml";
import type { ExecutableTool } from "../types.ts";

type AuthConfig = NonNullable<API["auth"]>;
type DynamicAuth = Extract<AuthConfig, { type: "dynamic" }>;

// Token cache for dynamic authentication
interface CachedToken {
    token: string;
    expiry: number;
    refreshToken?: string;
}

const tokenCache = new Map<string, CachedToken>();

interface OpenAPIOperation {
    operationId?: string;
    summary?: string;
    description?: string;
    parameters?: any[];
    requestBody?: any;
    responses?: any;
}

interface OpenAPIPath {
    [method: string]: OpenAPIOperation;
}

interface OpenAPISchema {
    openapi: string;
    servers?: Array<{ url: string; description?: string }>;
    paths: Record<string, OpenAPIPath>;
    components?: {
        schemas?: Record<string, any>;
    };
}

/**
 * Converts OpenAPI parameter schema to JSON Schema for tool validation
 * Also returns metadata about where each parameter should be routed
 */
function convertParameterToJsonSchema(parameters: any[] = [], requestBody?: any): {
    schema: any;
    parameterMetadata: {
        pathParams: Set<string>;
        queryParams: Set<string>;
        bodyParams: Set<string>;
        isObjectBody: boolean;
    };
} {
    const properties: Record<string, any> = {};
    const required: string[] = [];
    const pathParams = new Set<string>();
    const queryParams = new Set<string>();
    const bodyParams = new Set<string>();
    let isObjectBody = false;

    // Process path, query, and header parameters
    parameters.forEach((param) => {
        if (param.name && param.schema) {
            properties[param.name] = {
                ...param.schema,
                description: param.description || param.schema.description,
            };

            if (param.required) {
                required.push(param.name);
            }

            // Track parameter location
            if (param.in === 'path') {
                pathParams.add(param.name);
            } else if (param.in === 'query') {
                queryParams.add(param.name);
            }
            // Note: headers are handled in authentication, so we skip them here
        }
    });

    // Process request body if it exists
    if (requestBody?.content) {
        const jsonContent = requestBody.content['application/json'];
        if (jsonContent?.schema) {
            // If it's an object schema, merge properties and mark them as body params
            if (jsonContent.schema.type === 'object' && jsonContent.schema.properties) {
                isObjectBody = true;
                Object.keys(jsonContent.schema.properties).forEach(propName => {
                    properties[propName] = jsonContent.schema.properties[propName];
                    bodyParams.add(propName);
                });
                if (jsonContent.schema.required) {
                    required.push(...jsonContent.schema.required);
                }
            } else {
                // For non-object schemas, create a 'body' parameter
                properties.body = jsonContent.schema;
                bodyParams.add('body');
                if (requestBody.required) {
                    required.push('body');
                }
            }
        }
    }

    return {
        schema: {
            type: "object",
            properties,
            required: required.length > 0 ? required : undefined,
        },
        parameterMetadata: {
            pathParams,
            queryParams,
            bodyParams,
            isObjectBody
        }
    };
}

/**
 * Detects if a string is JSON or YAML format
 */
function detectFormat(input: string): 'json' | 'yaml' {
    // Trim whitespace for better detection
    const trimmed = input.trim();

    // JSON typically starts with { or [
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        return 'json';
    }

    // YAML often has key: value patterns without quotes
    // or starts with --- (document separator)
    if (trimmed.startsWith('---') ||
        /^[a-zA-Z_][a-zA-Z0-9_]*:\s/.test(trimmed) ||
        /^openapi:\s*['"]?3\./.test(trimmed)) {
        return 'yaml';
    }

    // Default to JSON and let parsing errors handle invalid format
    return 'json';
}

/**
 * Normalizes OpenAPI schema to ensure consistent structure
 * Supports both JSON and YAML string inputs, as well as parsed objects
 */
function normalizeOpenApiSchema(schema: any): OpenAPISchema {
    // If it's already an object, return as-is
    if (typeof schema === 'object' && schema !== null) {
        return schema as OpenAPISchema;
    }

    // If it's a string, detect format and parse accordingly
    if (typeof schema === 'string') {
        const format = detectFormat(schema);

        try {
            if (format === 'json') {
                schema = JSON.parse(schema);
            } else {
                // YAML format - parseYaml can also handle JSON
                schema = parseYaml(schema);
            }
        } catch (error) {
            console.error(`Failed to parse ${format.toUpperCase()} OpenAPI schema:`, error);
            throw new Error(`Invalid ${format.toUpperCase()} OpenAPI schema provided. ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    // Validate that it's a valid OpenAPI 3.x schema
    if (!schema.openapi || !schema.openapi.startsWith('3.')) {
        console.warn("Provided schema does not appear to be OpenAPI 3.x format. Some features might not work as expected.");
    }

    // Ensure required fields exist
    if (!schema.paths) {
        throw new Error("OpenAPI schema must contain a 'paths' object");
    }

    return schema as OpenAPISchema;
}

/**
 * Extracts value from object using JSONPath-like string
 */
function extractValue(obj: any, path: string): any {
    return path.split('.').reduce((current, key) => current?.[key], obj);
}

/**
 * Calls authentication endpoint and returns token
 */
async function callAuthEndpoint(authConfig: DynamicAuth, baseUrl: string): Promise<CachedToken> {
    const authUrl = authConfig.authEndpoint.url.startsWith('http')
        ? authConfig.authEndpoint.url
        : baseUrl + authConfig.authEndpoint.url;

    const method = authConfig.authEndpoint.method || 'POST';
    const headers = {
        'Content-Type': 'application/json',
        'User-Agent': 'Copilotz-Agents/1.0',
        ...authConfig.authEndpoint.headers
    };

    let body: string | undefined;
    if (method !== 'GET') {
        body = JSON.stringify(authConfig.authEndpoint.body || authConfig.authEndpoint.credentials || {});
    }

    console.log(`🔐 Calling auth endpoint: ${method} ${authUrl}`);

    const response = await fetch(authUrl, { method, headers, body });

    if (!response.ok) {
        throw new Error(`Authentication failed: ${response.status} ${response.statusText}`);
    }

    const authResponse = await response.json();
    const token = extractValue(authResponse, authConfig.tokenExtraction.path);

    if (!token) {
        throw new Error(`Token not found at path: ${authConfig.tokenExtraction.path}`);
    }

    // Calculate expiry
    let expiry = Date.now() + (authConfig.cache?.duration || 3600) * 1000;
    if (authConfig.refreshConfig?.expiryPath) {
        const expiryValue = extractValue(authResponse, authConfig.refreshConfig.expiryPath);
        if (expiryValue) {
            // Handle both absolute timestamps and relative seconds
            expiry = typeof expiryValue === 'number' && expiryValue > 1000000000
                ? expiryValue * 1000 // Unix timestamp 
                : Date.now() + expiryValue * 1000; // Relative seconds
        }
    }

    // Extract refresh token if configured
    const refreshToken = authConfig.refreshConfig?.refreshPath
        ? extractValue(authResponse, authConfig.refreshConfig.refreshPath)
        : undefined;

    console.log(`✅ Authentication successful, token expires: ${new Date(expiry).toISOString()}`);

    return { token, expiry, refreshToken };
}

/**
 * Gets or refreshes authentication token for dynamic auth
 */
async function getDynamicToken(authConfig: DynamicAuth, baseUrl: string, apiName: string): Promise<string> {
    const cacheKey = `${apiName}_dynamic_token`;
    const cached = tokenCache.get(cacheKey);
    const now = Date.now();

    // Check if we have a valid cached token
    if (cached && cached.expiry > now + (authConfig.refreshConfig?.refreshBeforeExpiry || 300) * 1000) {
        return cached.token;
    }

    // Try to refresh if we have a refresh token and refresh endpoint
    if (cached?.refreshToken && authConfig.refreshConfig?.refreshEndpoint) {
        try {
            console.log(`🔄 Refreshing token for ${apiName}`);

            const refreshUrl = authConfig.refreshConfig.refreshEndpoint.startsWith('http')
                ? authConfig.refreshConfig.refreshEndpoint
                : baseUrl + authConfig.refreshConfig.refreshEndpoint;

            const refreshResponse = await fetch(refreshUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': 'Copilotz-Agents/1.0'
                },
                body: JSON.stringify({ refresh_token: cached.refreshToken })
            });

            if (refreshResponse.ok) {
                const refreshData = await refreshResponse.json();
                const newToken = extractValue(refreshData, authConfig.tokenExtraction.path);
                if (newToken) {
                    const newCached: CachedToken = {
                        token: newToken,
                        expiry: now + (authConfig.cache?.duration || 3600) * 1000,
                        refreshToken: cached.refreshToken
                    };
                    tokenCache.set(cacheKey, newCached);
                    console.log(`✅ Token refreshed for ${apiName}`);
                    return newToken;
                }
            }
        } catch (error) {
            console.warn(`⚠️ Token refresh failed for ${apiName}, getting new token:`, error);
        }
    }

    // Get new token
    const newToken = await callAuthEndpoint(authConfig, baseUrl);

    if (authConfig.cache?.enabled !== false) {
        tokenCache.set(cacheKey, newToken);
    }

    return newToken.token;
}

/**
 * Applies authentication configuration to headers and query parameters
 */
async function applyAuthentication(
    auth: API["auth"] | undefined,
    headers: Record<string, string>,
    queryParams: URLSearchParams,
    baseUrl?: string,
    apiName?: string
) {
    if (!auth) return;
    const normalizedAuth: AuthConfig = auth;

    switch (normalizedAuth.type) {
        case 'apiKey':
            if (normalizedAuth.in === 'header') {
                headers[normalizedAuth.name] = normalizedAuth.key;
            } else if (normalizedAuth.in === 'query') {
                queryParams.set(normalizedAuth.name, normalizedAuth.key);
            }
            break;

        case 'bearer': {
            const scheme = normalizedAuth.scheme || 'Bearer';
            headers['Authorization'] = `${scheme} ${normalizedAuth.token}`;
            break;
        }
        case 'basic': {
            const credentials = btoa(`${normalizedAuth.username}:${normalizedAuth.password}`);
            headers['Authorization'] = `Basic ${credentials}`;
            break;
        }
        case 'custom':
            if (normalizedAuth.headers) {
                Object.assign(headers, normalizedAuth.headers);
            }
            if (normalizedAuth.queryParams) {
                Object.entries(normalizedAuth.queryParams).forEach(([key, value]) => {
                    queryParams.set(key, String(value));
                });
            }
            break;

        case 'dynamic': {
            if (!baseUrl || !apiName) {
                throw new Error('Dynamic authentication requires baseUrl and apiName');
            }

            const token = await getDynamicToken(normalizedAuth, baseUrl, apiName);

            if (normalizedAuth.tokenExtraction.type === 'bearer') {
                const prefix = normalizedAuth.tokenExtraction.prefix || 'Bearer ';
                headers['Authorization'] = `${prefix}${token}`;
            } else if (normalizedAuth.tokenExtraction.type === 'apiKey') {
                const headerName = normalizedAuth.tokenExtraction.headerName || 'Authorization';
                const prefix = normalizedAuth.tokenExtraction.prefix || '';
                headers[headerName] = `${prefix}${token}`;
            }
            break;
        }
    }
}

/**
 * Creates a tool execution function for an API operation
 */
function createApiExecutor(
    apiConfig: API,
    path: string,
    method: string,
    operation: OpenAPIOperation,
    baseUrl: string,
    parameterMetadata: {
        pathParams: Set<string>;
        queryParams: Set<string>;
        bodyParams: Set<string>;
        isObjectBody: boolean;
    }
) {
    return async (
        args: unknown,
        _context?: unknown,
    ) => {
        try {
            const params = (args && typeof args === "object")
                ? args as Record<string, unknown>
                : {};

            // Build the URL
            let url = baseUrl + path;

            // Replace path parameters
            parameterMetadata.pathParams.forEach(key => {
                if (params[key] !== undefined) {
                    url = url.replace(`{${key}}`, encodeURIComponent(String(params[key])));
                }
            });

            // Build query parameters (only for parameters explicitly marked as query)
            const queryParams = new URLSearchParams();
            parameterMetadata.queryParams.forEach(key => {
                if (params[key] !== undefined) {
                    queryParams.append(key, String(params[key]));
                }
            });

            // Build request headers
            const headers: Record<string, string> = {
                'Content-Type': 'application/json',
                'User-Agent': 'Copilotz-Agents/1.0',
                ...apiConfig.headers, // Legacy header support (still supported)
            };

            // Apply authentication (now async for dynamic auth)
            await applyAuthentication(apiConfig.auth, headers, queryParams, baseUrl, apiConfig.name);

            // Add final query parameters to URL
            if (queryParams.toString()) {
                url += '?' + queryParams.toString();
            }

            // Build request options
            const requestOptions: RequestInit = {
                method: method.toUpperCase(),
                headers,
            };

            // Add body for methods that support it
            if (['POST', 'PUT', 'PATCH'].includes(method.toUpperCase()) && parameterMetadata.bodyParams.size > 0) {
                let requestBody: any;

                if (parameterMetadata.isObjectBody) {
                    // Collect all body parameters into an object
                    requestBody = {};
                    parameterMetadata.bodyParams.forEach(key => {
                        if (params[key] !== undefined) {
                            requestBody[key] = params[key];
                        }
                    });
                } else {
                    // Use the 'body' parameter directly
                    requestBody = params.body;
                }

                if (requestBody !== undefined) {
                    requestOptions.body = typeof requestBody === 'string'
                        ? requestBody
                        : JSON.stringify(requestBody);
                }
            }

            // Set timeout
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), (apiConfig.timeout || 30) * 1000);
            requestOptions.signal = controller.signal;

            // Make the request
            const response = await fetch(url, requestOptions);
            clearTimeout(timeoutId);

            // Parse response
            const contentType = response.headers.get('content-type') || '';
            let responseData;

            if (contentType.includes('application/json')) {
                responseData = await response.json();
            } else {
                responseData = await response.text();
            }

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}\nResponse: ${JSON.stringify(responseData)}`);
            }

            return {
                status: response.status,
                statusText: response.statusText,
                headers: Object.fromEntries(response.headers.entries()),
                data: responseData,
            };

        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
                throw new Error(`Request timeout after ${apiConfig.timeout || 30} seconds`);
            }
            throw error;
        }
    };
}

/**
 * Generates Tool instances from an OpenAPI configuration
 */
export function generateApiTools(apiConfig: API): ExecutableTool[] {
    const tools: ExecutableTool[] = [];
    const schema = normalizeOpenApiSchema(apiConfig.openApiSchema);

    // Determine base URL
    const baseUrl = apiConfig.baseUrl ||
        (schema.servers && schema.servers.length > 0 ? schema.servers[0].url : '');

    if (!baseUrl) {
        throw new Error(`No base URL found for API ${apiConfig.name}. Provide baseUrl in config or servers in OpenAPI schema.`);
    }

    // Process each path and method
    Object.entries(schema.paths).forEach(([path, pathItem]) => {
        Object.entries(pathItem).forEach(([method, operation]) => {
            // Skip non-operation properties
            if (!['get', 'post', 'put', 'patch', 'delete', 'options', 'head'].includes(method.toLowerCase())) {
                return;
            }

            const op = operation as OpenAPIOperation;

            // Generate tool key and name
            const toolKey = op.operationId ||
                `${apiConfig.name}_${method}_${path.replace(/[^a-zA-Z0-9]/g, '_')}`;

            const toolName = op.summary ||
                `${method.toUpperCase()} ${path}`;

            const toolDescription = op.description ||
                `${apiConfig.description ? apiConfig.description + ': ' : ''}${toolName}`;

            // Convert OpenAPI parameters to JSON Schema
            const { schema: inputSchema, parameterMetadata } = convertParameterToJsonSchema(op.parameters, op.requestBody);

            // Create the tool
            const tool: ExecutableTool = {
                id: crypto.randomUUID(),
                key: toolKey,
                name: toolName,
                description: toolDescription,
                externalId: null,
                metadata: null,
                createdAt: new Date(),
                updatedAt: new Date(),
                outputSchema: null,
                inputSchema,
                execute: createApiExecutor(apiConfig, path, method, op, baseUrl, parameterMetadata),
            };

            tools.push(tool);
        });
    });

    return tools;
}

/**
 * Generates tools from multiple API configurations
 */
export function generateAllApiTools(apiConfigs: API[]): ExecutableTool[] {
    const allTools: ExecutableTool[] = [];

    apiConfigs.forEach(config => {
        try {
            const tools = generateApiTools(config);
            allTools.push(...tools);
        } catch (error) {
            console.error(`Failed to generate tools for API ${config.name}:`, error);
        }
    });

    return allTools;
} 