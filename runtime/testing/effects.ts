/** Standalone plugin fixture permit. Durable protocol tests use the real owner. */
import type { ActionEffect } from "../actions/types.ts";
export const testEffect: ActionEffect = {
  begin: () => Promise.resolve({ status: "proceed" }),
  inspect: () => Promise.resolve({ status: "none" }),
  confirm: () => Promise.resolve(),
  confirmOutput: () => Promise.resolve(),
  notStarted: () =>
    Promise.reject(new Error("No no-start proof in this fixture.")),
};
