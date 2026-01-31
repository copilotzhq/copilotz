import type { API } from "@/interfaces/index.ts";

export function getToolNames(openApiSchema: API["openApiSchema"]): string[] {
    if (!openApiSchema || typeof openApiSchema !== "object") {
        return [];
    }

    const paths = (openApiSchema as { paths?: Record<string, Record<string, { operationId?: string }>> }).paths;
    if (!paths || typeof paths !== "object") {
        return [];
    }

    return Object.keys(paths).flatMap((path) => {
        const pathObj = paths[path];
        if (!pathObj || typeof pathObj !== "object") return [];

        const operationIds: string[] = [];
        ["get", "post", "put", "delete", "patch"].forEach((method) => {
            const operation = (pathObj as Record<string, { operationId?: string }>)[method];
            if (operation?.operationId) {
                operationIds.push(operation.operationId);
            }
        });

        return operationIds;
    });
}