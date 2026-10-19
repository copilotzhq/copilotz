/** Owner-created synchronous invocation linkage; never reconstructed from metadata. */
import type { ActionInvocationFrame } from "./invoker.ts";
const parents = new WeakMap<
  object,
  Readonly<{
    actionId: string;
    actionRunId: string;
    parentId: string;
    parentRunId: string;
  }>
>();
export function bindActionInvocationParent<T extends ActionInvocationFrame>(
  frame: T,
  parent: ActionInvocationFrame | undefined,
): T {
  if (parent) {
    parents.set(
      frame,
      Object.freeze({
        actionId: frame.actionId,
        actionRunId: frame.actionRunId,
        parentId: parent.actionId,
        parentRunId: parent.actionRunId,
      }),
    );
  }
  return frame;
}
export function actionInvocationParent(frame: object) {
  return parents.get(frame);
}
/** Owner metadata snapshots preserve, but cannot select or replace, the original linkage. */
export function inheritActionInvocationParent<T extends ActionInvocationFrame>(
  source: ActionInvocationFrame,
  target: T,
): T {
  const parent = parents.get(source);
  if (parent) {
    if (
      target.actionId !== parent.actionId ||
      target.actionRunId !== parent.actionRunId ||
      target.parentActionRunId !== parent.parentRunId
    ) {
      throw new Error("Action parent binding cannot be replaced.");
    }
    parents.set(target, parent);
  }
  return target;
}
