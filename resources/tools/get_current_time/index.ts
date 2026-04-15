interface GetCurrentTimeParams {
    format?: "iso" | "readable" | "timestamp" | "date-only" | "time-only";
    timezone?: string;
}

export default {
    key: "get_current_time",
    name: "Get Current Time",
    description: "Get the current date and time in various formats.",
    inputSchema: {
        type: "object",
        properties: {
            format: {
                type: "string",
                description: "Output format for the date/time.",
                enum: ["iso", "readable", "timestamp", "date-only", "time-only"],
                default: "iso"
            },
            timezone: {
                type: "string",
                description: "Timezone (e.g., 'UTC', 'America/New_York'). Default is local time.",
                default: "local"
            },
        },
    },
    execute: async ({ format = "iso", timezone = "local" }: GetCurrentTimeParams) => {
        const now = new Date();
        
        let result: string | number;
        switch (format) {
            case "readable":
                result = now.toLocaleString();
                break;
            case "timestamp":
                result = now.getTime();
                break;
            case "date-only":
                result = now.toISOString().split('T')[0];
                break;
            case "time-only":
                result = now.toTimeString().split(' ')[0];
                break;
            case "iso":
            default:
                result = now.toISOString();
                break;
        }
        
        return {
            current_time: result,
            format,
            timezone: timezone === "local" ? Intl.DateTimeFormat().resolvedOptions().timeZone : timezone,
            timestamp: now.getTime(),
            iso: now.toISOString()
        };
    },
}
