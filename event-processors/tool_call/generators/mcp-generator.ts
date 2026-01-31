import type { MCPServer } from "@/interfaces/index.ts";
import { Client } from "modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "modelcontextprotocol/sdk/client/stdio.js";
import type { ExecutableTool } from "../types.ts";

interface MCPTool {
    name: string;
    description?: string;
    inputSchema: any;
}

/**
 * MCP client using the official MCP TypeScript SDK
 */
type StdioTransportConfig = {
    type: "stdio";
    command?: unknown;
    args?: unknown;
    env?: unknown;
};

const isStdioTransport = (value: unknown): value is StdioTransportConfig =>
    Boolean(
        value &&
        typeof value === "object" &&
        (value as { type?: unknown }).type === "stdio",
    );

class MCPClient {
    private config: MCPServer;
    private client?: Client;
    private transport?: StdioClientTransport;
    private connected = false;

    constructor(config: MCPServer) {
        this.config = config;
    }

    /**
     * Connect to the MCP server using the official MCP SDK
     */
    async connect(): Promise<void> {
        if (this.connected) return;

        const transport = this.config.transport;
        if (!transport) {
            throw new Error(`Transport configuration missing for MCP server ${this.config.name}`);
        }

        try {
            if (isStdioTransport(transport)) {
                await this.connectStdio(transport);
            } else {
                // Note: Official MCP SDK currently only supports stdio transport
                // SSE and WebSocket transports would need custom implementation
                throw new Error(
                    `Transport type ${(transport as { type?: unknown }).type ?? "unknown"} not yet supported by official MCP SDK. Only 'stdio' is currently supported.`,
                );
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to connect to MCP server ${this.config.name}: ${errorMessage}`);
        }
    }

    /**
     * Connect using stdio transport with official MCP SDK
     */
    private async connectStdio(transport: StdioTransportConfig): Promise<void> {
        if (typeof transport.command !== "string" || transport.command.trim() === "") {
            throw new Error("Command is required for stdio transport");
        }

        const args = Array.isArray(transport.args)
            ? transport.args.map((value) => String(value))
            : [];

        const envEntries = transport.env && typeof transport.env === "object"
            ? Object.entries(transport.env).filter((
                entry,
            ): entry is [string, string] => typeof entry[1] === "string")
            : [];
        const env = envEntries.length > 0 ? Object.fromEntries(envEntries) : undefined;

        try {
            // Create stdio transport using official SDK
            this.transport = new StdioClientTransport({
                command: transport.command,
                args,
                env,
            });

            // Create client using the transport
            this.client = new Client({
                name: "Copilotz",
                version: "1.0.0"
            }, {
                capabilities: {}
            });

            // Connect and initialize
            await this.client.connect(this.transport);

            this.connected = true;
        } catch (error) {
            // Clean up on error
            if (this.transport) {
                await this.transport.close();
                this.transport = undefined;
            }
            this.client = undefined;
            throw error;
        }
    }


    /**
     * List available tools from the MCP server using official SDK
     */
    async listTools(): Promise<MCPTool[]> {
        if (!this.client) {
            throw new Error("Not connected to MCP server");
        }

        try {
            const response = await this.client.listTools();
            return response.tools || [];
        } catch (error) {
            return [];
        }
    }

    /**
     * Call a tool on the MCP server using official SDK with timeout
     */
    async callTool(name: string, arguments_: any): Promise<any> {
        if (!this.client) {
            throw new Error("Not connected to MCP server");
        }

        try {
            
            const callPromise = this.client.callTool({
                name: name,
                arguments: arguments_
            });

            // Add 10-second timeout to prevent hanging
            const timeoutPromise = new Promise((_, reject) => {
                const timeoutId = setTimeout(
                    () => reject(new Error("MCP tool call timeout after 10 seconds")),
                    10_000,
                );
                callPromise.finally(() => clearTimeout(timeoutId));
            });
            
            const response = await Promise.race([callPromise, timeoutPromise]);
            return response;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to call MCP tool ${name}: ${errorMessage}`);
        }
    }

    /**
     * Disconnect from the MCP server using official SDK cleanup
     */
    async disconnect(): Promise<void> {
        try {
            // Close the transport connection
            if (this.transport) {
                await this.transport.close();
                this.transport = undefined;
            }

            this.client = undefined;
        } catch (error) {

        }

        this.connected = false;
    }
}

/**
 * Creates a tool execution function for an MCP tool
 */
function createMcpExecutor(client: MCPClient, originalToolName: string, serverName: string) {
    return async (args: unknown, _context?: unknown) => {
        const params = args && typeof args === "object" ? args : {};
        try {
            const result = await client.callTool(originalToolName, params);
            return result;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            throw new Error(`MCP tool execution failed: ${errorMessage}`);
        }
    };
}

/**
 * Generates Tool instances from an MCP server configuration
 */
export async function generateMcpTools(mcpConfig: MCPServer): Promise<ExecutableTool[]> {
    const tools: ExecutableTool[] = [];
    const client = new MCPClient(mcpConfig);

    try {
        // Connect to the MCP server
        await client.connect();

        // Get available tools
        const mcpTools = await client.listTools();

        // Filter tools based on capabilities if specified
        const capabilityList = Array.isArray(mcpConfig.capabilities)
            ? mcpConfig.capabilities.filter((cap): cap is string => typeof cap === "string")
            : undefined;
        const filteredTools = capabilityList && capabilityList.length > 0
            ? mcpTools.filter((tool) => capabilityList.includes(tool.name))
            : mcpTools;

        // Convert each MCP tool to a Tool
        for (const mcpTool of filteredTools) {
            const toolKey = `${mcpConfig.name}_${mcpTool.name}`;
            const toolName = `${mcpConfig.name}: ${mcpTool.name}`;
            const toolDescription = mcpTool.description || 
                `${mcpConfig.description ? mcpConfig.description + ': ' : ''}${mcpTool.name}`;

            const tool: ExecutableTool = {
                id: crypto.randomUUID(),
                key: toolKey,
                name: toolName,
                description: toolDescription,
                externalId: null,
                metadata: null,
                createdAt: new Date(),
                updatedAt: new Date(),
                inputSchema: mcpTool.inputSchema || {
                    type: "object",
                    properties: {},
                },
                outputSchema: null,
                execute: createMcpExecutor(client, mcpTool.name, mcpConfig.name),
            };

            tools.push(tool);
        }

        // Note: In a production implementation, you'd want to manage the client lifecycle better
        // For now, we'll keep the connection open during tool execution

    } catch (error) {

        await client.disconnect();
    }

    return tools;
}

/**
 * Generates tools from multiple MCP server configurations
 * Note: Currently only supports stdio transport via official MCP SDK
 */
export async function generateAllMcpTools(mcpConfigs: MCPServer[]): Promise<ExecutableTool[]> {
    const allTools: ExecutableTool[] = [];
    
    // Filter for supported transports
    const supportedConfigs = mcpConfigs.filter((config) => isStdioTransport(config.transport));
    
    // Process each supported MCP server configuration
    const toolPromises = supportedConfigs.map(async (config) => {
        try {
            const tools = await generateMcpTools(config);
            return tools;
        } catch (error) {

            return [];
        }
    });

    const toolArrays = await Promise.all(toolPromises);
    
    // Flatten the arrays
    toolArrays.forEach(tools => {
        allTools.push(...tools);
    });
    
    return allTools;
}

/**
 * Cleanup function to disconnect all MCP clients
 * Should be called when the agent system shuts down
 */
export async function disconnectAllMcpServers(): Promise<void> {
    // In a production implementation, you'd maintain a registry of active clients
    // and disconnect them here
}

// Export MCPClient for testing purposes
export { MCPClient }; 