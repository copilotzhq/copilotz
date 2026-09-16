/** Default bounded goal policy. Applications override it through final context Resources. @module */
import type {
  GoalDecision,
  GoalDecisionContext,
} from "../../../actions/run-goal/index.ts";
export type GoalPolicy = {
  maxTurns: number;
  adapter?: string;
  decide?: (
    context: GoalDecisionContext,
  ) => GoalDecision | Promise<GoalDecision>;
};
export const defaultGoalPolicy: GoalPolicy = { maxTurns: 20 };
export default defaultGoalPolicy;
