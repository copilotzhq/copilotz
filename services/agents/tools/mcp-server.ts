/**
 * Agentic Tool Framework - MCP Server Tool
 * Integration with Model Context Protocol (MCP) servers
 */

import type { ToolDefinition } from '../types.ts';
import { SchemaBuilders } from '../validation.ts';
import { makeHttpRequest } from './api.ts';

// =============================================================================
// MCP SERVER TOOL
// =============================================================================

/**
 * MCP Server Tool
 * Connects to and executes tools on MCP servers
 */
export const mcpServerTool: ToolDefinition = {
  id: 'mcp-server',
  name: 'MCP Server',
  description: 'Connect to and execute tools on Model Context Protocol (MCP) servers',
  version: '1.0.0',
  category: 'integration',
  type: 'mcp_server',
  
  input: {
    schema: SchemaBuilders.object({
      serverUrl: SchemaBuilders.string({
        description: 'URL of the MCP server',
        pattern: '^https?://.*',
        minLength: 1,
        maxLength: 500
      }),
      action: SchemaBuilders.string({
        description: 'Action to perform on the MCP server',
        enum: ['list_tools', 'get_tool', 'execute_tool', 'list_resources', 'get_resource', 'list_prompts', 'get_prompt'],
        default: 'list_tools'
      }),
      toolName: SchemaBuilders.string({
        description: 'Name of the tool to get or execute',
        minLength: 1,
        maxLength: 100
      }),
      toolArguments: SchemaBuilders.object({
        description: 'Arguments to pass to the tool'
      }),
      resourceUri: SchemaBuilders.string({
        description: 'URI of the resource to get',
        minLength: 1,
        maxLength: 500
      }),
      promptName: SchemaBuilders.string({
        description: 'Name of the prompt to get',
        minLength: 1,
        maxLength: 100
      }),
      promptArguments: SchemaBuilders.object({
        description: 'Arguments to pass to the prompt'
      }),
      authentication: SchemaBuilders.object({
        type: SchemaBuilders.string({
          description: 'Authentication type',
          enum: ['none', 'bearer', 'api-key', 'basic']
        }),
        token: SchemaBuilders.string({
          description: 'Authentication token'
        }),
        username: SchemaBuilders.string({
          description: 'Username for basic auth'
        }),
        password: SchemaBuilders.string({
          description: 'Password for basic auth'
        })
      }),
      options: SchemaBuilders.object({
        timeout: SchemaBuilders.number({
          description: 'Request timeout in milliseconds',
          minimum: 1000,
          maximum: 300000,
          default: 30000
        }),
        retries: SchemaBuilders.number({
          description: 'Number of retry attempts',
          minimum: 0,
          maximum: 3,
          default: 0
        }),
        validateResponse: SchemaBuilders.boolean({
          description: 'Validate MCP response format',
          default: true
        })
      })
    }, ['serverUrl', 'action']),
    required: ['serverUrl', 'action']
  },
  
  output: {
    schema: SchemaBuilders.object({
      success: { type: 'boolean' },
      data: {
        description: 'Response data from MCP server',
        oneOf: [
          { type: 'object' },
          { type: 'array' },
          { type: 'string' },
          { type: 'null' }
        ]
      },
      error: { type: 'string' },
      serverInfo: SchemaBuilders.object({
        name: { type: 'string' },
        version: { type: 'string' },
        protocolVersion: { type: 'string' },
        capabilities: { type: 'object' }
      }),
      executionTime: { type: 'number' },
      metadata: SchemaBuilders.object({
        action: { type: 'string' },
        serverUrl: { type: 'string' },
        requestId: { type: 'string' }
      })
    }, ['success', 'data', 'executionTime', 'metadata'])
  },
  
  implementation: {
    type: 'function',
    handler: async (input: any) => {
      try {
        const result = await executeMCPAction(input);
        return result;
      } catch (error) {
        return {
          success: false,
          data: null,
          error: error.message || String(error),
          serverInfo: null,
          executionTime: 0,
          metadata: {
            action: input.action,
            serverUrl: input.serverUrl,
            requestId: generateRequestId()
          }
        };
      }
    }
  },
  
  permissions: {
    networkAccess: true,
    fileSystemAccess: false,
    requiresAuthentication: false
  },
  
  execution: {
    environment: 'main',
    timeout: 300000,
    resourceLimits: {
      maxMemoryMB: 256,
      maxExecutionTimeMs: 300000,
      maxConcurrentExecutions: 10
    }
  },
  
  metadata: {
    author: 'Copilotz',
    tags: ['mcp', 'protocol', 'integration', 'server', 'tools'],
    deprecated: false,
    experimental: false
  }
};

// =============================================================================
// MCP IMPLEMENTATION
// =============================================================================

/**
 * MCP action configuration
 */
interface MCPActionConfig {
  serverUrl: string;
  action: string;
  toolName?: string;
  toolArguments?: any;
  resourceUri?: string;
  promptName?: string;
  promptArguments?: any;
  authentication?: {
    type?: string;
    token?: string;
    username?: string;
    password?: string;
  };
  options?: {
    timeout?: number;
    retries?: number;
    validateResponse?: boolean;
  };
}

/**
 * MCP action result
 */
interface MCPActionResult {
  success: boolean;
  data: any;
  error?: string;
  serverInfo?: {
    name: string;
    version: string;
    protocolVersion: string;
    capabilities: any;
  };
  executionTime: number;
  metadata: {
    action: string;
    serverUrl: string;
    requestId: string;
  };
}

/**
 * MCP message types
 */
interface MCPMessage {
  jsonrpc: '2.0';
  id: string | number;
  method?: string;
  params?: any;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

/**
 * Execute MCP action
 */
async function executeMCPAction(config: MCPActionConfig): Promise<MCPActionResult> {
  const startTime = Date.now();
  const requestId = generateRequestId();
  
  const {
    serverUrl,
    action,
    toolName,
    toolArguments,
    resourceUri,
    promptName,
    promptArguments,
    authentication = { type: 'none' },
    options = {}
  } = config;

  const {
    timeout = 30000,
    retries = 0,
    validateResponse = true
  } = options;

  try {
    // First, initialize connection with server
    const serverInfo = await initializeMCPConnection(serverUrl, authentication, timeout);
    
    // Execute the requested action
    let result: any;
    
    switch (action) {
      case 'list_tools':
        result = await listTools(serverUrl, authentication, timeout);
        break;
      case 'get_tool':
        if (!toolName) throw new Error('Tool name is required for get_tool action');
        result = await getTool(serverUrl, toolName, authentication, timeout);
        break;
      case 'execute_tool':
        if (!toolName) throw new Error('Tool name is required for execute_tool action');
        result = await executeTool(serverUrl, toolName, toolArguments || {}, authentication, timeout);
        break;
      case 'list_resources':
        result = await listResources(serverUrl, authentication, timeout);
        break;
      case 'get_resource':
        if (!resourceUri) throw new Error('Resource URI is required for get_resource action');
        result = await getResource(serverUrl, resourceUri, authentication, timeout);
        break;
      case 'list_prompts':
        result = await listPrompts(serverUrl, authentication, timeout);
        break;
      case 'get_prompt':
        if (!promptName) throw new Error('Prompt name is required for get_prompt action');
        result = await getPrompt(serverUrl, promptName, promptArguments || {}, authentication, timeout);
        break;
      default:
        throw new Error(`Unknown action: ${action}`);
    }

    // Validate response if requested
    if (validateResponse) {
      validateMCPResponse(result);
    }

    return {
      success: true,
      data: result,
      serverInfo,
      executionTime: Date.now() - startTime,
      metadata: {
        action,
        serverUrl,
        requestId
      }
    };

  } catch (error) {
    return {
      success: false,
      data: null,
      error: error.message || String(error),
      executionTime: Date.now() - startTime,
      metadata: {
        action,
        serverUrl,
        requestId
      }
    };
  }
}

/**
 * Initialize MCP connection
 */
async function initializeMCPConnection(
  serverUrl: string,
  authentication: any,
  timeout: number
): Promise<any> {
  const message: MCPMessage = {
    jsonrpc: '2.0',
    id: generateRequestId(),
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {
        roots: {},
        sampling: {}
      },
      clientInfo: {
        name: 'Copilotz-Agent',
        version: '1.0.0'
      }
    }
  };

  const response = await sendMCPMessage(serverUrl, message, authentication, timeout);
  
  if (response.error) {
    throw new Error(`MCP initialization failed: ${response.error.message}`);
  }

  return response.result;
}

/**
 * List available tools
 */
async function listTools(
  serverUrl: string,
  authentication: any,
  timeout: number
): Promise<any> {
  const message: MCPMessage = {
    jsonrpc: '2.0',
    id: generateRequestId(),
    method: 'tools/list',
    params: {}
  };

  const response = await sendMCPMessage(serverUrl, message, authentication, timeout);
  
  if (response.error) {
    throw new Error(`Failed to list tools: ${response.error.message}`);
  }

  return response.result;
}

/**
 * Get tool information
 */
async function getTool(
  serverUrl: string,
  toolName: string,
  authentication: any,
  timeout: number
): Promise<any> {
  const message: MCPMessage = {
    jsonrpc: '2.0',
    id: generateRequestId(),
    method: 'tools/get',
    params: {
      name: toolName
    }
  };

  const response = await sendMCPMessage(serverUrl, message, authentication, timeout);
  
  if (response.error) {
    throw new Error(`Failed to get tool: ${response.error.message}`);
  }

  return response.result;
}

/**
 * Execute tool
 */
async function executeTool(
  serverUrl: string,
  toolName: string,
  toolArguments: any,
  authentication: any,
  timeout: number
): Promise<any> {
  const message: MCPMessage = {
    jsonrpc: '2.0',
    id: generateRequestId(),
    method: 'tools/call',
    params: {
      name: toolName,
      arguments: toolArguments
    }
  };

  const response = await sendMCPMessage(serverUrl, message, authentication, timeout);
  
  if (response.error) {
    throw new Error(`Failed to execute tool: ${response.error.message}`);
  }

  return response.result;
}

/**
 * List available resources
 */
async function listResources(
  serverUrl: string,
  authentication: any,
  timeout: number
): Promise<any> {
  const message: MCPMessage = {
    jsonrpc: '2.0',
    id: generateRequestId(),
    method: 'resources/list',
    params: {}
  };

  const response = await sendMCPMessage(serverUrl, message, authentication, timeout);
  
  if (response.error) {
    throw new Error(`Failed to list resources: ${response.error.message}`);
  }

  return response.result;
}

/**
 * Get resource
 */
async function getResource(
  serverUrl: string,
  resourceUri: string,
  authentication: any,
  timeout: number
): Promise<any> {
  const message: MCPMessage = {
    jsonrpc: '2.0',
    id: generateRequestId(),
    method: 'resources/read',
    params: {
      uri: resourceUri
    }
  };

  const response = await sendMCPMessage(serverUrl, message, authentication, timeout);
  
  if (response.error) {
    throw new Error(`Failed to get resource: ${response.error.message}`);
  }

  return response.result;
}

/**
 * List available prompts
 */
async function listPrompts(
  serverUrl: string,
  authentication: any,
  timeout: number
): Promise<any> {
  const message: MCPMessage = {
    jsonrpc: '2.0',
    id: generateRequestId(),
    method: 'prompts/list',
    params: {}
  };

  const response = await sendMCPMessage(serverUrl, message, authentication, timeout);
  
  if (response.error) {
    throw new Error(`Failed to list prompts: ${response.error.message}`);
  }

  return response.result;
}

/**
 * Get prompt
 */
async function getPrompt(
  serverUrl: string,
  promptName: string,
  promptArguments: any,
  authentication: any,
  timeout: number
): Promise<any> {
  const message: MCPMessage = {
    jsonrpc: '2.0',
    id: generateRequestId(),
    method: 'prompts/get',
    params: {
      name: promptName,
      arguments: promptArguments
    }
  };

  const response = await sendMCPMessage(serverUrl, message, authentication, timeout);
  
  if (response.error) {
    throw new Error(`Failed to get prompt: ${response.error.message}`);
  }

  return response.result;
}

/**
 * Send MCP message to server
 */
async function sendMCPMessage(
  serverUrl: string,
  message: MCPMessage,
  authentication: any,
  timeout: number
): Promise<MCPMessage> {
  // Build headers
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  };

  // Add authentication
  if (authentication.type === 'bearer' && authentication.token) {
    headers['Authorization'] = `Bearer ${authentication.token}`;
  } else if (authentication.type === 'api-key' && authentication.token) {
    headers['X-API-Key'] = authentication.token;
  } else if (authentication.type === 'basic' && authentication.username && authentication.password) {
    const credentials = btoa(`${authentication.username}:${authentication.password}`);
    headers['Authorization'] = `Basic ${credentials}`;
  }

  // Send request
  const response = await makeHttpRequest({
    url: serverUrl,
    method: 'POST',
    headers,
    body: message,
    options: {
      timeout,
      validateStatus: true
    }
  });

  // Check for HTTP errors
  if (!response.success) {
    throw new Error(`HTTP error: ${response.status} ${response.statusText}`);
  }

  // Parse response
  const mcpResponse = response.data as MCPMessage;
  
  // Validate JSON-RPC format
  if (!mcpResponse || mcpResponse.jsonrpc !== '2.0') {
    throw new Error('Invalid JSON-RPC response format');
  }

  return mcpResponse;
}

/**
 * Validate MCP response
 */
function validateMCPResponse(response: any): void {
  if (!response) {
    throw new Error('Empty response from MCP server');
  }

  // Basic validation - can be extended based on MCP spec
  if (typeof response !== 'object') {
    throw new Error('Invalid response format');
  }
}

/**
 * Generate request ID
 */
function generateRequestId(): string {
  return `mcp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Quick MCP server connection test
 */
export async function testMCPConnection(serverUrl: string, authentication?: any): Promise<boolean> {
  try {
    const result = await executeMCPAction({
      serverUrl,
      action: 'list_tools',
      authentication,
      options: {
        timeout: 10000,
        validateResponse: false
      }
    });
    
    return result.success;
  } catch (error) {
    return false;
  }
}

/**
 * List all available tools on MCP server
 */
export async function listMCPTools(serverUrl: string, authentication?: any): Promise<any[]> {
  const result = await executeMCPAction({
    serverUrl,
    action: 'list_tools',
    authentication
  });
  
  if (!result.success) {
    throw new Error(result.error || 'Failed to list tools');
  }
  
  return result.data?.tools || [];
}

/**
 * Execute MCP tool with arguments
 */
export async function executeMCPTool(
  serverUrl: string,
  toolName: string,
  toolArguments: any,
  authentication?: any
): Promise<any> {
  const result = await executeMCPAction({
    serverUrl,
    action: 'execute_tool',
    toolName,
    toolArguments,
    authentication
  });
  
  if (!result.success) {
    throw new Error(result.error || 'Failed to execute tool');
  }
  
  return result.data;
}

/**
 * Get MCP server capabilities
 */
export async function getMCPServerInfo(serverUrl: string, authentication?: any): Promise<any> {
  const result = await executeMCPAction({
    serverUrl,
    action: 'list_tools',
    authentication
  });
  
  if (!result.success) {
    throw new Error(result.error || 'Failed to get server info');
  }
  
  return result.serverInfo;
}

/**
 * Create MCP client for a specific server
 */
class MCPClient {
  private serverUrl: string;
  private authentication: any;
  private serverInfo: any;

  constructor(serverUrl: string, authentication?: any) {
    this.serverUrl = serverUrl;
    this.authentication = authentication;
  }

  /**
   * Initialize connection to MCP server
   */
  async initialize(): Promise<void> {
    const result = await executeMCPAction({
      serverUrl: this.serverUrl,
      action: 'list_tools',
      authentication: this.authentication
    });
    
    if (!result.success) {
      throw new Error(result.error || 'Failed to initialize MCP client');
    }
    
    this.serverInfo = result.serverInfo;
  }

  /**
   * List available tools
   */
  async listTools(): Promise<any[]> {
    return listMCPTools(this.serverUrl, this.authentication);
  }

  /**
   * Execute tool
   */
  async executeTool(toolName: string, toolArguments: any): Promise<any> {
    return executeMCPTool(this.serverUrl, toolName, toolArguments, this.authentication);
  }

  /**
   * List resources
   */
  async listResources(): Promise<any[]> {
    const result = await executeMCPAction({
      serverUrl: this.serverUrl,
      action: 'list_resources',
      authentication: this.authentication
    });
    
    if (!result.success) {
      throw new Error(result.error || 'Failed to list resources');
    }
    
    return result.data?.resources || [];
  }

  /**
   * Get resource
   */
  async getResource(resourceUri: string): Promise<any> {
    const result = await executeMCPAction({
      serverUrl: this.serverUrl,
      action: 'get_resource',
      resourceUri,
      authentication: this.authentication
    });
    
    if (!result.success) {
      throw new Error(result.error || 'Failed to get resource');
    }
    
    return result.data;
  }

  /**
   * List prompts
   */
  async listPrompts(): Promise<any[]> {
    const result = await executeMCPAction({
      serverUrl: this.serverUrl,
      action: 'list_prompts',
      authentication: this.authentication
    });
    
    if (!result.success) {
      throw new Error(result.error || 'Failed to list prompts');
    }
    
    return result.data?.prompts || [];
  }

  /**
   * Get prompt
   */
  async getPrompt(promptName: string, promptArguments: any): Promise<any> {
    const result = await executeMCPAction({
      serverUrl: this.serverUrl,
      action: 'get_prompt',
      promptName,
      promptArguments,
      authentication: this.authentication
    });
    
    if (!result.success) {
      throw new Error(result.error || 'Failed to get prompt');
    }
    
    return result.data;
  }

  /**
   * Get server information
   */
  getServerInfo(): any {
    return this.serverInfo;
  }
}

// =============================================================================
// EXPORTS
// =============================================================================

export default mcpServerTool;
export { 
  executeMCPAction, 
  MCPClient,
  type MCPActionConfig, 
  type MCPActionResult 
}; 