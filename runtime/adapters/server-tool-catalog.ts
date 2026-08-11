import type { API } from "../resources/index.ts";
import {
  createWorkflowToolCatalog,
  type GenerateApiWorkflowTools,
  isWorkflowTool,
  type WorkflowToolCatalog,
} from "../workflows/index.ts";
import { createMcpWorkflowToolGenerator } from "./mcp-tools.ts";
import type { CreateServerWorkflowToolCatalogOptions } from "./types.ts";

/** Web-fetch OpenAPI generator, loaded only when API resources are present. */
export function createOpenApiWorkflowToolGenerator(): GenerateApiWorkflowTools {
  return async (apis: readonly API[]) => {
    if (!apis.length) return Object.freeze([]);
    const { generateApiTools } = await import("./openapi-tools.ts");
    return Object.freeze(
      apis.flatMap((api) => generateApiTools(api)).filter(isWorkflowTool),
    );
  };
}

/**
 * Composes Web-fetch OpenAPI with an optional injected MCP transport. The
 * generic adapter entry point stays portable; stdio is an explicit host-only
 * subpath.
 */
export function createServerWorkflowToolCatalog(
  options: CreateServerWorkflowToolCatalogOptions = {},
): WorkflowToolCatalog {
  const openApi = options.openApi !== false;
  return createWorkflowToolCatalog({
    ...(openApi
      ? {
        generateApiTools: options.generateApiTools ??
          createOpenApiWorkflowToolGenerator(),
      }
      : {}),
    ...(options.connectMcp
      ? {
        generateMcpTools: createMcpWorkflowToolGenerator({
          connect: options.connectMcp,
        }),
      }
      : {}),
  });
}
