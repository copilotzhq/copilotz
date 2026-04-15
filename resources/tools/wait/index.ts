interface WaitParams {
    seconds?: number;
}

export default {
    key: "wait",
    name: "Wait",
    description: "Wait for a specified amount of time.",
    inputSchema: {
        type: "object",
        properties: {
            seconds: {
                type: "number",
                description: "Number of seconds to wait.",
                minimum: 0.1,
                maximum: 60,
                default: 1
            },
        },
    },
    execute: async ({ seconds = 1 }: WaitParams) => {
        const startTime = Date.now();
        await new Promise(resolve => setTimeout(resolve, seconds * 1000));
        const actualWait = Date.now() - startTime;
        
        return {
            requested: seconds,
            actual: actualWait / 1000,
            message: `Waited for ${actualWait}ms`
        };
    },
}
