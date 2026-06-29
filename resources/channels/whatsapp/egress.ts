import type { StreamEvent } from "@/runtime/index.ts";
import {
  type EgressAdapter,
  extractText,
  transformEgressDeliveryOutput,
} from "@/server/channels.ts";
import { getChannelContext } from "@/runtime/thread-metadata.ts";
import {
  callWhatsAppGraphAPI,
  debugWhatsAppChannel,
  normalizeWhatsAppActionPayload,
  resolveWhatsAppConfig,
  sendWhatsAppActionMessage,
  sendWhatsAppText,
  uploadWhatsAppMedia,
  type WhatsAppActionPayload,
  type WhatsAppConfig,
} from "./shared.ts";

export type WhatsAppTextDeliveryOutput = {
  kind: "text";
  to: string;
  text: string;
  event: StreamEvent;
};

export type WhatsAppMediaDeliveryOutput = {
  kind: "media";
  to: string;
  mediaType: string;
  mediaId: string;
  event: StreamEvent;
};

export type WhatsAppReplyButtonsDeliveryOutput = {
  kind: "reply_buttons";
  to: string;
  action: WhatsAppActionPayload;
  event: StreamEvent;
};

export type WhatsAppDeliveryOutput =
  | WhatsAppTextDeliveryOutput
  | WhatsAppMediaDeliveryOutput
  | WhatsAppReplyButtonsDeliveryOutput;

export function createWhatsAppEgressAdapter(
  config?: Partial<WhatsAppConfig>,
): EgressAdapter {
  return {
    async validateThreadContext(thread) {
      const channelContext = getChannelContext(thread?.metadata, "whatsapp");
      if (
        typeof channelContext?.recipientPhone !== "string" ||
        channelContext.recipientPhone.length === 0 ||
        typeof channelContext?.channelId !== "string" ||
        channelContext.channelId.length === 0
      ) {
        throw {
          status: 422,
          message:
            "Thread metadata is missing whatsapp recipient phone or inbound phone number id",
        };
      }
    },
    async deliver(context) {
      const channelContext = getChannelContext(
        context.thread?.metadata,
        "whatsapp",
      );
      const recipientPhone = channelContext?.recipientPhone as string;
      const channelId = channelContext?.channelId as string;
      const cfg = {
        ...resolveWhatsAppConfig(config, context.context),
        phoneId: channelId,
      };
      debugWhatsAppChannel("egress_delivery_started", {
        graphApiVersion: cfg.graphApiVersion,
        phoneId: cfg.phoneId || null,
        accessTokenConfigured: cfg.accessToken.length > 0,
      });

      let eventCount = 0;
      let agentMessageCount = 0;
      void context.handle.done.then(
        () => {
          debugWhatsAppChannel("run_handle_done", {
            status: "resolved",
            eventCount,
            agentMessageCount,
          });
        },
        (error: unknown) => {
          debugWhatsAppChannel("run_handle_done", {
            status: "rejected",
            eventCount,
            agentMessageCount,
            error: error instanceof Error ? error.message : String(error),
          });
        },
      );

      try {
        for await (
          const event of context.handle.events as AsyncIterable<StreamEvent>
        ) {
          eventCount += 1;
          const ep = event.payload as Record<string, unknown>;
          const sender = ep?.sender as Record<string, unknown> | undefined;
          debugWhatsAppChannel("egress_event_received", {
            eventType: event.type,
            senderType: typeof sender?.type === "string" ? sender.type : null,
          });

          switch (event.type) {
            case "NEW_MESSAGE": {
              if (sender?.type !== "agent") break;
              agentMessageCount += 1;
              const text = extractText(ep?.content);
              if (text) {
                const output = await transformEgressDeliveryOutput<
                  WhatsAppDeliveryOutput
                >(context, {
                  kind: "text",
                  to: recipientPhone,
                  text,
                  event,
                });
                if (output?.kind === "text" && output.text) {
                  await sendWhatsAppText(cfg, output.to, output.text);
                }
              }
              break;
            }
            case "ASSET_CREATED": {
              const by = ep?.by as string | undefined;
              if (by === "user") break;

              const dataUrl = ep?.dataUrl as string | undefined;
              const mime = ep?.mime as string | undefined;
              if (dataUrl && mime) {
                const uploaded = await uploadWhatsAppMedia(cfg, dataUrl);
                if (!uploaded) break;
                const output = await transformEgressDeliveryOutput<
                  WhatsAppDeliveryOutput
                >(context, {
                  kind: "media",
                  to: recipientPhone,
                  mediaType: uploaded.type,
                  mediaId: uploaded.id,
                  event,
                });
                if (output?.kind !== "media") break;
                await callWhatsAppGraphAPI(cfg, {
                  messaging_product: "whatsapp",
                  to: output.to,
                  type: output.mediaType,
                  [output.mediaType]: { id: output.mediaId },
                });
              }
              break;
            }
            case "ACTION": {
              const action = normalizeWhatsAppActionPayload(ep);
              if (!action) break;
              if (action.type === "reply_buttons") {
                const output = await transformEgressDeliveryOutput<
                  WhatsAppDeliveryOutput
                >(context, {
                  kind: "reply_buttons",
                  to: recipientPhone,
                  action,
                  event,
                });
                if (output?.kind !== "reply_buttons") break;
                await sendWhatsAppActionMessage(cfg, output.to, output.action);
              }
              break;
            }
          }
        }
      } finally {
        debugWhatsAppChannel("egress_delivery_finished", {
          eventCount,
          agentMessageCount,
        });
      }
    },
  };
}

export const whatsappEgressAdapter = createWhatsAppEgressAdapter();

export default whatsappEgressAdapter;
