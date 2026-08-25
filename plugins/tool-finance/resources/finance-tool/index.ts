/**
 * Defines the data-only Finance Tool Resource for an existing Finance Action.
 *
 * @module
 */

import type { ActionDefinition } from "@copilotz/copilotz/actions";
import { defineTool, type ToolResource } from "@copilotz/copilotz/tools";
import {
  FINANCE_TOOL_DESCRIPTION,
  FINANCE_TOOL_NAME,
  type FinanceActionInput,
} from "../../actions/index.ts";

/** Creates the presentation resource bound to the composed `finance` Action. */
export function financeToolResource(
  action: ActionDefinition<FinanceActionInput, unknown>,
): ToolResource<"finance"> {
  return defineTool("finance", action, {
    name: FINANCE_TOOL_NAME,
    description: FINANCE_TOOL_DESCRIPTION,
  });
}
