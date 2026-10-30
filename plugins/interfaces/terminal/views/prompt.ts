/** Where you type: who you are, and what's open. */
import type { ViewContext } from "../../../../runtime/mod.ts";
import { dim, type ShellState } from "../../../../hosts/terminal/contract.ts";

export const promptView = (p: { state: ShellState; me: string }, _ctx: ViewContext) => {
  const id = p.state.open?.item._id;
  return `${p.me}${typeof id === "string" ? dim(` · ${id.slice(0, 8)}`) : ""} › `;
};
