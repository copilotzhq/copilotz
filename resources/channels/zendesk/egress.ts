import type { StreamEvent } from "@/runtime/index.ts";
import { type EgressAdapter, extractText } from "@/server/channels.ts";
import { getChannelContext } from "@/runtime/thread-metadata.ts";
import {
  callZendeskSmoochAPI,
  resolveZendeskConfig,
  sendZendeskActionMessage,
  sendZendeskTextMessage,
  uploadZendeskAttachment,
  type ZendeskConfig,
} from "./shared.ts";

export function createZendeskEgressAdapter(
  config?: Partial<ZendeskConfig>,
): EgressAdapter {
  const cfg = resolveZendeskConfig(config);

  return {
    async validateThreadContext(thread) {
      const channelContext = getChannelContext(thread?.metadata, "zendesk");
      if (
        typeof channelContext?.conversationId !== "string" ||
        channelContext.conversationId.length === 0
      ) {
        throw {
          status: 422,
          message:
            "Thread metadata is missing zendesk conversation routing information",
        };
      }
    },
    async deliver(context) {
      const channelContext = getChannelContext(
        context.thread?.metadata,
        "zendesk",
      );
      const conversationId = channelContext?.conversationId as string;

      for await (
        const event of context.handle.events as AsyncIterable<StreamEvent>
      ) {
        const ep = event.payload as Record<string, unknown>;
        const sender = ep?.sender as Record<string, unknown> | undefined;

        switch (event.type) {
          case "NEW_MESSAGE": {
            if (sender?.type !== "agent") break;
            const text = extractText(ep?.content);
            if (text) {
              await sendZendeskTextMessage(cfg, conversationId, text);
            }
            break;
          }
          case "ASSET_CREATED": {
            const by = ep?.by as string | undefined;
            if (by === "user") break;

            const dataUrl = ep?.dataUrl as string | undefined;
            const mime = ep?.mime as string | undefined;
            if (!dataUrl || !mime) break;

            const attachment = await uploadZendeskAttachment(
              cfg,
              conversationId,
              dataUrl,
            );
            if (!attachment) break;

            const mediaType = mime.startsWith("image/") ? "image" : "file";
            await callZendeskSmoochAPI(cfg, conversationId, {
              author: {
                type: "business",
                displayName: cfg.businessName,
                avatarUrl: cfg.businessLogo,
              },
              content: {
                type: mediaType,
                mediaUrl: attachment.mediaUrl,
              },
            });
            break;
          }
          case "ACTION": {
            const action = ep as Record<string, unknown>;
            if (action.type === "reply_buttons") {
              await sendZendeskActionMessage(cfg, conversationId, action);
            }
            break;
          }
        }
      }
    },
  };
}

export const zendeskEgressAdapter = createZendeskEgressAdapter();

export default zendeskEgressAdapter;
