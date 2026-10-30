/** Conversations in a numbered list: when, how long, the last message; ● marks the open one. */
import type { ReactNode } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import { accent, dim, short } from "../../../../../hosts/terminal/mod.ts";

export type Listed = { _id: string; at: string; messages?: number; last?: string };

export const threadsView = (
  l: { threads: Listed[]; open?: string },
  _ctx: ViewContext<ReactNode>,
) =>
  l.threads.map((t, i) =>
    `${
      dim(
        `[${i + 1}] ${t._id.slice(0, 8)} · ${new Date(t.at).toLocaleString()} · ${
          t.messages ?? 0
        } messages ·`,
      )
    } ${short(t.last ?? "", 60)}${t._id === l.open ? accent(" ●") : ""}`
  ).join("\n");
