/**
 * Barrel module for the bundled admin agent.
 *
 * Uses fetch() with import.meta.url so instructions.md loads
 * from both local filesystems and JSR HTTPS URLs.
 *
 * @module
 */

import adminConfig from "./config.ts";

/** Load admin agent instructions via fetch. */
export async function loadAdminAgent(): Promise<{ instructions: string; config: typeof adminConfig }> {
    const url = new URL("./instructions.md", import.meta.url).href;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to load admin instructions: ${res.status}`);
    const instructions = await res.text();
    return { instructions, config: adminConfig };
}
