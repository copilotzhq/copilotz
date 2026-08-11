// The MCP SDK requires a consumer-owned zod peer. Keep it isolated from the
// older exact zod version used internally by Ominipg.
import "npm:zod@3.25.76";

export * from "npm:@modelcontextprotocol/sdk@1.29.0/client";
