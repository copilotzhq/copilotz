/**
 * An operation's tool (`<api>_<operation>`, in chat's `tools` resource): it
 * calls the operation's Action, so a retried turn gets the call it already
 * made back rather than calling the API twice; keeps the files in what came
 * back out of the prompt (see files.ts); and gives the agent the rest, if it
 * isn't more than the API's `maxBytes`.
 */
import type { Tool, ToolContext } from "../../chat/contract.ts";
import { withFiles } from "../shared/files.ts";
import { settingsOf, sized } from "../shared/settings.ts";

export function operationTool(
  api: string,
  operation: string,
  input: Record<string, unknown>,
  description: string,
): Tool {
  return {
    description,
    input,
    run: async (given: Record<string, unknown>, ctx: ToolContext) => {
      const settings = settingsOf(ctx, api);
      const result = await ctx.call(`${api}.${operation}`, given);
      const shown = await withFiles(ctx, settings, operation, result);
      if (shown === null || shown === undefined || shown === "") {
        return "Done: the API answered with no content.";
      }
      const text = typeof shown === "string" ? shown : JSON.stringify(shown);
      const bytes = new TextEncoder().encode(text).byteLength;
      if (bytes > settings.maxBytes) {
        throw new Error(
          `The response is ${sized(bytes)}, more than the ${sized(settings.maxBytes)} an agent ` +
            "is given (the API's maxBytes): ask for less, such as a filter or a smaller page",
        );
      }
      return text;
    },
  };
}
