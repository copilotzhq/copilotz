/**
 * Oxian.js Adapters Configuration
 * 
 * This file configures how requests are handled, including:
 * - Database configuration per isolate
 * - Isolate management and load balancing
 * - Authentication and permissions
 * - Upgrade management
 */

import type { OxianConfig as BaseOxianConfig } from "jsr:@oxian/oxian-js/config";

export default function defaultAdapters(config: BaseOxianConfig): BaseOxianConfig {
    // Default configuration
    return {
        ...config,
        // Enhanced database configuration
        database: {
            enabled: true,
            // url: env.DATABASE_URL,
            // syncUrl: env.DATABASE_URL,
            lwwColumn: 'updated_at',
            edgeId: 'local',
        },
        // Isolate configuration
        isolateType: 'subprocess', // or 'worker'
    };
}

