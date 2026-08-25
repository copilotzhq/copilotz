// The MCP SDK requires a consumer-owned zod peer. Keep it isolated from the
// older exact zod version used internally by Ominipg.
import "zod";

export * from "@modelcontextprotocol/sdk/client";
