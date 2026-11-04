/**
 * Interfaces: how people and code reach the runtime: the terminal, the
 * developer API (keys, `/api/`), WhatsApp, and MCP (a model outside calling
 * the app's tools).
 */
export * from "./terminal/mod.ts";
export * from "./api/mod.ts";
export * from "./whatsapp/mod.ts";
export * from "./mcp/mod.ts";
