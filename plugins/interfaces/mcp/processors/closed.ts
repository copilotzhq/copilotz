/**
 * Erasing an MCP conversation sticks. Its ids come from what names it
 * (ChatGPT's session, a handle), so the same session would otherwise come
 * back to the same contact and chat, made again. Instead, each is closed
 * for good (`mcp_closed`), and the conversation's next call says so:
 *
 * - **A contact erased** (`contact.deleted`, `contact.forget`): one that
 *   came by MCP (`via: "mcp"`).
 * - **A chat erased** (`thread.deleted`, `chat.erase`): an MCP chat (`mcp-…`).
 */
import type { Context, ProcessorDef } from "../../../../runtime/mod.ts";

const close = (ctx: Context, id: string) =>
  ctx.as().db.collection("mcp_closed").replaceOne(
    { _id: id },
    { at: new Date().toISOString() },
    { upsert: true },
  );

export const forgottenProcessor: ProcessorDef = {
  on: "contact.deleted",
  where: { "doc.via": "mcp" },
  key: (event) => String(event.data._id),
  run: async (ctx, event) => void await close(ctx, `contact:${event.data._id}`),
};

export const erasedProcessor: ProcessorDef = {
  on: "thread.deleted",
  key: (event) => String(event.data._id),
  run: async (ctx, event) => {
    const thread = String(event.data._id);
    if (thread.startsWith("mcp-")) await close(ctx, `thread:${thread}`);
  },
};
