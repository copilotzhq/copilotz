import type { ToolDefinition } from "@copilotz/copilotz/core";
/**
 * Defines the data-only Tool Resource for HTTP requests.
 *
 * @module
 */

import { defineTool } from "@copilotz/copilotz/core";
import { httpRequestAction } from "../../../actions/http-request/index.ts";

export const httpRequestTool: ToolDefinition<typeof httpRequestAction> =
  defineTool({
    ...httpRequestAction,
    ...{
      name: "HTTP Request",
      description: "Make HTTP requests to external APIs and web services.",
    },
  });

export default httpRequestTool;
