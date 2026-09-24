/** Data-only Tool presentation for bounded historical Tool result reads. @module */

import {
  defineTool,
  type ToolResource,
} from "../../../authoring/define-tool/index.ts";
import { readToolResultAction } from "../../../actions/read-tool-result/index.ts";

export const readToolResultTool: ToolResource<"readToolResult"> = defineTool(
  "readToolResult",
  readToolResultAction,
  {
    name: "Read Tool Result",
    description:
      "Read a bounded byte range from a Tool result omitted from conversation history. Use the Message ID from its marker; offset and limit are UTF-8 byte counts, and search is plain literal text.",
    history: { visibility: "requester_only" },
  },
);

export default readToolResultTool;
