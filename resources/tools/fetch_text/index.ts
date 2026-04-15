interface FetchTextParams {
    url: string;
    timeout?: number;
}

export default {
    key: "fetch_text",
    name: "Fetch Text",
    description: "Fetch text content from a URL (simplified version of http_request).",
    inputSchema: {
        type: "object",
        properties: {
            url: { type: "string", description: "URL to fetch text from." },
            timeout: {
                type: "number",
                description: "Timeout in seconds.",
                default: 15,
                minimum: 1,
                maximum: 60
            },
        },
        required: ["url"],
    },
    execute: async ({ url, timeout = 15 }: FetchTextParams) => {
        try {
            new URL(url); // Validate URL
            
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeout * 1000);
            
            const response = await fetch(url, {
                signal: controller.signal,
                headers: { "User-Agent": "AgentV2/1.0" }
            });
            
            clearTimeout(timeoutId);
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            
            const text = await response.text();
            
            return {
                url,
                content: text,
                length: text.length,
                contentType: response.headers.get("content-type") || "unknown",
                status: response.status
            };
        } catch (error) {
            if ((error as Error).name === "AbortError") {
                throw new Error(`Request timeout after ${timeout} seconds`);
            }
            throw new Error(`Failed to fetch text: ${(error as Error).message}`);
        }
    },
}
