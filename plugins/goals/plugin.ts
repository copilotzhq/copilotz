import { type CopilotzPlugin, definePlugin } from "@copilotz/copilotz/plugins";
import { corePlugin } from "@copilotz/copilotz/core";
import {
  acceptGoalMessageAction,
  advanceGoalAction,
  cancelGoalAction,
  failGoalAwaitedAction,
  startGoalAction,
} from "./actions.ts";
import { goalCollection } from "./collection.ts";
import {
  goalAdvanceLifecycleRecoveryProcessor,
  goalCancelInputProcessor,
  goalConfiguredActionLifecycleProcessor,
  goalEvaluationProcessor,
  goalLlmTerminalProcessor,
  goalMessageProcessor,
  goalResponseProcessor,
  goalStartInputProcessor,
  goalStopRequestProcessor,
} from "./processors.ts";
import { defineGoal } from "./resource.ts";
import type { GoalResource } from "./types.ts";

export const GOALS_PLUGIN_ID = "@copilotz/goals";
export const GOALS_PLUGIN_VERSION = "0.62.0";

export type CreateGoalsPluginOptions<
  TGoals extends Readonly<Record<string, GoalResource>> = Readonly<
    Record<string, GoalResource>
  >,
> = Readonly<{
  id?: string;
  version?: string;
  goals: TGoals;
}>;

function normalizedGoals<
  const TGoals extends Readonly<Record<string, GoalResource>>,
>(
  value: TGoals,
): Readonly<{ [K in keyof TGoals]: GoalResource }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Goals plugin resources.goals must be an alias map.");
  }
  const entries: [string, GoalResource][] = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !key.trim() || key !== key.trim()) {
      throw new TypeError(`Invalid Goal Resource alias '${String(key)}'.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new TypeError(
        `Goal Resource alias '${key}' must be an enumerable data property.`,
      );
    }
    entries.push([key, defineGoal(descriptor.value as GoalResource)]);
  }
  return Object.freeze(Object.fromEntries(entries)) as Readonly<
    {
      [K in keyof TGoals]: GoalResource;
    }
  >;
}

type EmptyPluginNamespaces = Readonly<Record<never, never>>;

export type GoalsPlugin<
  TGoals extends Readonly<Record<string, GoalResource>> = Readonly<
    Record<string, GoalResource>
  >,
> = CopilotzPlugin<
  string,
  string,
  readonly [typeof corePlugin],
  Readonly<{ goal: typeof goalCollection }>,
  Readonly<{
    startGoal: typeof startGoalAction;
    acceptGoalMessage: typeof acceptGoalMessageAction;
    advanceGoal: typeof advanceGoalAction;
    failGoalAwaited: typeof failGoalAwaitedAction;
    cancelGoal: typeof cancelGoalAction;
  }>,
  Readonly<{
    startGoalInput: typeof goalStartInputProcessor;
    cancelGoalInput: typeof goalCancelInputProcessor;
    evaluation: typeof goalEvaluationProcessor;
    stopRequest: typeof goalStopRequestProcessor;
    configuredActionLifecycle: typeof goalConfiguredActionLifecycleProcessor;
    advanceRecovery: typeof goalAdvanceLifecycleRecoveryProcessor;
    message: typeof goalMessageProcessor;
    response: typeof goalResponseProcessor;
    llmTerminal: typeof goalLlmTerminalProcessor;
  }>,
  Readonly<{
    goals: Readonly<{ [K in keyof TGoals]: GoalResource }>;
  }>,
  EmptyPluginNamespaces
>;

function composeGoalsPlugin<
  const TGoals extends Readonly<Record<string, GoalResource>>,
>(input: CreateGoalsPluginOptions<TGoals>): GoalsPlugin<TGoals> {
  const goals = normalizedGoals(input.goals);
  return definePlugin({
    id: input.id?.trim() || GOALS_PLUGIN_ID,
    version: input.version?.trim() || GOALS_PLUGIN_VERSION,
    plugins: [corePlugin] as const,
    collections: { goal: goalCollection },
    actions: {
      startGoal: startGoalAction,
      acceptGoalMessage: acceptGoalMessageAction,
      advanceGoal: advanceGoalAction,
      failGoalAwaited: failGoalAwaitedAction,
      cancelGoal: cancelGoalAction,
    },
    processors: {
      startGoalInput: goalStartInputProcessor,
      cancelGoalInput: goalCancelInputProcessor,
      evaluation: goalEvaluationProcessor,
      stopRequest: goalStopRequestProcessor,
      configuredActionLifecycle: goalConfiguredActionLifecycleProcessor,
      advanceRecovery: goalAdvanceLifecycleRecoveryProcessor,
      message: goalMessageProcessor,
      response: goalResponseProcessor,
      llmTerminal: goalLlmTerminalProcessor,
    },
    resources: { goals },
  });
}

/**
 * Composes Goals as one ordinary plugin. This factory runs only while an
 * application declares its immutable plugin/resource graph.
 */
export function createGoalsPlugin<
  const TGoals extends Readonly<Record<string, GoalResource>>,
>(input: CreateGoalsPluginOptions<TGoals>): GoalsPlugin<TGoals> {
  return composeGoalsPlugin(input);
}
