import type { StreamEvent } from "@/runtime/index.ts";
import { type EgressAdapter, extractText } from "@/server/channels.ts";
import { getChannelContext } from "@/runtime/thread-metadata.ts";
import {
  callWhatsAppGraphAPI,
  resolveWhatsAppConfig,
  sendWhatsAppText,
  uploadWhatsAppMedia,
  type WhatsAppConfig,
} from "./shared.ts";

export function createWhatsAppEgressAdapter(
  config?: Partial<WhatsAppConfig>,
): EgressAdapter {
  const cfg = resolveWhatsAppConfig(config);

  return {
    async validateThreadContext(thread) {
      const channelContext = getChannelContext(thread?.metadata, "whatsapp");
      if (
        typeof channelContext?.recipientPhone !== "string" ||
        channelContext.recipientPhone.length === 0
      ) {
        throw {
          status: 422,
          message:
            "Thread metadata is missing whatsapp recipient routing information",
        };
      }
    },
    async deliver(context) {
      const channelContext = getChannelContext(
        context.thread?.metadata,
        "whatsapp",
      );
      const recipientPhone = channelContext?.recipientPhone as string;

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
              await sendWhatsAppText(cfg, recipientPhone, text);
            }
            break;
          }
          case "ASSET_CREATED": {
            const dataUrl = ep?.dataUrl as string | undefined;
            const mime = ep?.mime as string | undefined;
            if (dataUrl && mime) {
              const uploaded = await uploadWhatsAppMedia(cfg, dataUrl);
              if (uploaded) {
                await callWhatsAppGraphAPI(cfg, {
                  messaging_product: "whatsapp",
                  to: recipientPhone,
                  type: uploaded.type,
                  [uploaded.type]: { id: uploaded.id },
                });
              }
            }
            break;
          }
        }
      }
    },
  };
}

export const whatsappEgressAdapter = createWhatsAppEgressAdapter();

export default whatsappEgressAdapter;
