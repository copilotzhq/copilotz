/**
 * Interfaces: how people and code reach the runtime: the terminal, the
 * developer API (keys, `/api/`), WhatsApp, the phone (voice), MCP (a model outside calling the
 * app's tools), and maintenance (operators, `/maintenance/`).
 */
export * from "./terminal/mod.ts";
export * from "./api/mod.ts";
export * from "./whatsapp/mod.ts";
export * from "./voice/mod.ts";
export * from "./mcp/mod.ts";
export * from "./maintenance/mod.ts";
