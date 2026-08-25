/**
 * Defines the data-only Tool Resource for HTTP requests.
 *
 * @module
 */

import { defineTool } from "@copilotz/copilotz/tools";
import { httpRequestAction } from "../../actions/http-request/index.ts";

export const httpRequestTool = defineTool(
  "http_request",
  httpRequestAction,
  {
    name: "HTTP Request",
    description: "Make HTTP requests to external APIs and web services.",
  },
);
