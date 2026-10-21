/** Private planning seam for owner capabilities that share Collection commit order. */
import { createAsyncContextStorage } from "../../dependencies/async-hooks.ts";
type Stage = (key: string, commit: () => Promise<unknown>) => void;
const planning = /* @__PURE__ */ createAsyncContextStorage<Stage>();
export const withTransactionEffects = <T>(stage: Stage, run: () => T) =>
  planning.run(stage, run);
export function stageTransactionEffect(
  key: string,
  commit: () => Promise<unknown>,
): boolean {
  const stage = planning.getStore();
  if (!stage) return false;
  stage(key, commit);
  return true;
}
