/**
 * The interfaces theme's contracts, for plugins built on it, in Copilotz or
 * outside it (`copilotz/plugins/interfaces/contract`): each plugin's
 * contract.ts (the web shell's resource kinds, its `orgs` slot and the
 * person's standing; the API's, MCP's, voice's, WhatsApp's and
 * maintenance's), and nothing else. Safe in the browser; plugins reach the
 * rest by name, through the runtime.
 */
export * from "./web/contract.ts";
export * from "./api/contract.ts";
export * from "./mcp/contract.ts";
export * from "./voice/contract.ts";
export * from "./whatsapp/contract.ts";
export * from "./maintenance/contract.ts";
// Both say `Section`: the sidebar's is the web shell's; a WhatsApp message's, WhatsApp's.
export type { Section } from "./web/contract.ts";
export type { Section as WhatsAppSection } from "./whatsapp/contract.ts";
