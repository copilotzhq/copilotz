import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "echo", version: "1.0.0" });
server.registerTool(
  "echo",
  { inputSchema: { text: z.string() } },
  async ({ text }: { text: string }) => ({
    content: [{ type: "text", text }],
  }),
);
await server.connect(new StdioServerTransport());
