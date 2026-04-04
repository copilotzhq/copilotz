/**
 * Utility for listing public agents from a Copilotz instance.
 *
 * @module
 */

import type { Agent } from "@/interfaces/index.ts";

/**
 * Returns a simplified list of agents suitable for public API responses.
 *
 * @param agents - Agent configurations (typically from copilotz.config.agents)
 * @returns Array of { id, name, description } objects
 */
export function listPublicAgents(
    agents: Agent[],
): Array<{ id: string; name: string; description: string | null }> {
    return agents
        .map((a) => ({
            id: (a.id ?? a.name ?? "") as string,
            name: (a.name ?? a.id ?? "Agent") as string,
            description: (a.description ?? null) as string | null,
        }))
        .filter((a) => a.id);
}
