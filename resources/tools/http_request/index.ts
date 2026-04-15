interface HttpRequestParams {
    url: string;
    method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    headers?: Record<string, string>;
    body?: string;
    timeout?: number;
}

export default {
    key: "http_request",
    name: "HTTP Request",
    description: "Make HTTP requests to external APIs and web services.",
    inputSchema: {
        type: "object",
        properties: {
            url: { type: "string", description: "The URL to make the request to." },
            method: { 
                type: "string", 
                description: "HTTP method to use.",
                enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
                default: "GET"
            },
            headers: { 
                type: "object", 
                description: "HTTP headers to include.",
                default: {}
            },
            body: { 
                type: "string", 
                description: "Request body (JSON string for JSON APIs)." 
            },
            timeout: { 
                type: "number", 
                description: "Timeout in seconds.",
                default: 30,
                minimum: 1,
                maximum: 120
            },
        },
        required: ["url"],
    },
    execute: async ({ url, method = "GET", headers = {}, body, timeout = 30 }: HttpRequestParams) => {
        try {
            // Validate URL
            new URL(url);
            
            // Prepare headers with user agent
            const requestHeaders: Record<string, string> = {
                "User-Agent": "AgentV2/1.0",
                ...headers
            };
            
            // Add content type for JSON if body provided and no content type set
            if (body && !requestHeaders["Content-Type"]) {
                requestHeaders["Content-Type"] = "application/json";
            }
            
            // Create abort controller for timeout
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeout * 1000);
            
            const startTime = Date.now();
            const response = await fetch(url, {
                method,
                headers: requestHeaders,
                body: method !== "GET" ? body : undefined,
                signal: controller.signal
            });
            
            clearTimeout(timeoutId);
            
            // Get response content
            const contentType = response.headers.get("content-type") || "";
            let responseBody;
            
            if (contentType.includes("application/json")) {
                responseBody = await response.json();
            } else {
                responseBody = await response.text();
            }
            
            return {
                success: response.ok,
                status: response.status,
                statusText: response.statusText,
                headers: Object.fromEntries(response.headers.entries()),
                body: responseBody,
                responseTime: Date.now() - startTime
            };
        } catch (error) {
            if ((error as Error).name === "AbortError") {
                throw new Error(`Request timeout after ${timeout} seconds`);
            }
            throw new Error(`HTTP request failed: ${(error as Error).message}`);
        }
    },
}
