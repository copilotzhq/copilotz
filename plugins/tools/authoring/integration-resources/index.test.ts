import { assertEquals } from "@std/assert";
import type { API, MCPServer } from "./index.ts";

Deno.test("Tool integration declarations remain plain authoring values", () => {
  const api: API = { id: "api", name: "API", baseUrl: "https://example.test" };
  const server: MCPServer = { id: "mcp", name: "MCP" };
  assertEquals([api.id, server.id], ["api", "mcp"]);
});
