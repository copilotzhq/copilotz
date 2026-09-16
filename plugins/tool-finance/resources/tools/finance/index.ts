import type { ToolDefinition } from "@copilotz/copilotz/core";
import { financeAction } from "../../../actions/finance/index.ts";
/**
 * Defines the data-only Finance Tool Resource for an existing Finance Action.
 *
 * @module
 */

import { defineTool } from "@copilotz/copilotz/core";
import {
  FINANCE_TOOL_DESCRIPTION,
  FINANCE_TOOL_NAME,
} from "../../../actions/index.ts";

/** Creates the presentation resource bound to the composed `finance` Action. */
export const financeToolResource: ToolDefinition<typeof financeAction> =
  defineTool({
    ...financeAction,
    ...{
      name: FINANCE_TOOL_NAME,
      description: FINANCE_TOOL_DESCRIPTION,
    },
  });

export default financeToolResource;
