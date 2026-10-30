/** What an agent would be sent, zone by zone (`/prompt`). */
import type { ReactNode } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import { accent, dim, short } from "../../../../../hosts/terminal/mod.ts";
import type { Prompt } from "../../shared/types.ts";

export const agentPromptView = (p: Prompt & { agent: string }, _ctx: ViewContext<ReactNode>) =>
  [
    accent(`── tools · ${p.agent}`),
    p.tools.map((t) => t.name).join(", ") || dim("(none)"),
    accent("── system (cached across turns)"),
    p.system.join("\n\n"),
    accent("── history (cached as it grows)"),
    ...p.history.map((m) => {
      const text = m.role === "assistant" && m.toolCalls
        ? `${m.text ? `${m.text} ` : ""}⟨${
          m.toolCalls.map((c) => `${c.name}(${short(JSON.stringify(c.input), 50)})`).join(", ")
        }⟩`
        : "text" in m
        ? m.text ?? ""
        : "";
      return `${dim(m.role.padEnd(9))} ${short(text, 160)}`;
    }),
    accent("── turn (new every turn)"),
    p.turn.length ? p.turn.join("\n") : dim("(nothing)"),
  ].join("\n");
