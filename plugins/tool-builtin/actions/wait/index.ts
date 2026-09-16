import type { ActionContext } from "@copilotz/copilotz/actions";
import type { ActionDefinition } from "@copilotz/copilotz/actions";
import { defaultSleep } from "./sleep.ts";
/** Built-in Action that waits with cancellation support.
 *
 * @module
 */

import { defineAction } from "@copilotz/copilotz/actions";
import { record } from "../../shared/input.ts";

export const waitAction: ActionDefinition<
  unknown,
  { requested: number; actual: number },
  ActionContext
> = defineAction({
  id: "copilotz.tools.builtin.wait",
  inputSchema: {
    type: "object",
    properties: {
      seconds: { type: "number", minimum: 0.1, maximum: 60, default: 1 },
    },
  },
  async execute(raw, context) {
    const clock = context.adapters.clock?.default as {
      sleep?: typeof defaultSleep;
    } | undefined;
    const sleep = clock?.sleep ?? defaultSleep;
    const seconds = Number(record(raw).seconds ?? 1);
    if (!Number.isFinite(seconds) || seconds < 0.1 || seconds > 60) {
      throw new TypeError("seconds must be between 0.1 and 60.");
    }
    const startedAt = Date.now();
    await sleep(seconds * 1_000, context.signal);
    return { requested: seconds, actual: (Date.now() - startedAt) / 1_000 };
  },
});
