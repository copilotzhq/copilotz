/**
 * A deterministic model for offline runs and tests. It calls the first tool it
 * is given when the user asks for it by name, then answers with the result.
 * Files it's shown (images and PDFs, when its model choice says it reads
 * them: `{ model: "fake/echo", input: ["image"] }`) it names: "[saw a.png]".
 */
import type { LlmAdapter } from "../../shared/types.ts";

export function fake(options: { delayMs?: number } = {}): LlmAdapter {
  const delay = options.delayMs ?? 15;
  const wait = () => delay > 0 ? new Promise((resolve) => setTimeout(resolve, delay)) : undefined;
  return {
    media: ["image", "pdf"],
    async *generate({ messages, tools = [] }) {
      // What was said last, past what contexts add each turn.
      const last = messages.findLast((m) => !("text" in m && m.text?.startsWith("<context")))!;
      if (last.role === "tool") {
        for (const word of `The tool says: ${last.text}`.split(/(?<= )/)) {
          await wait();
          yield { type: "text", text: word };
        }
        return;
      }
      const shown = last.role === "user" ? last.files ?? [] : [];
      const text = ("text" in last ? last.text ?? "" : "") +
        shown.map((file) => ` [saw ${file.name}]`).join("");
      const tool = tools.find((t) => text.toLowerCase().includes(t.name.replace(/_/g, " ")));
      if (tool) {
        yield { type: "tool_call", call: { id: crypto.randomUUID(), name: tool.name, input: {} } };
        return;
      }
      for (const word of `You said: ${text}`.split(/(?<= )/)) {
        await wait();
        yield { type: "text", text: word };
      }
    },
  };
}
