import type { StreamEvent } from "@/runtime/index.ts";
import {
  dataUrlToBlob,
  type EgressAdapter,
  extractText,
} from "@/server/channels.ts";
import {
  callDiscordAPI,
  getDiscordContext,
  resolveDiscordConfig,
  type DiscordConfig,
} from "./shared.ts";

export function createDiscordEgressAdapter(
  config?: Partial<DiscordConfig>,
): EgressAdapter {
  return {
    async validateThreadContext(thread) {
      const discordContext = getDiscordContext(thread?.metadata);
      if (!discordContext?.interactionToken) {
        throw {
          status: 422,
          message: "Thread metadata is missing discord interaction token",
        };
      }
    },
    async deliver(context) {
      const cfg = resolveDiscordConfig(config, context.context);
      const discordContext = getDiscordContext(context.thread?.metadata);
      if (!discordContext) return;

      const { interactionToken } = discordContext;
      let firstMessage = true;

      for await (
        const event of context.handle.events as AsyncIterable<StreamEvent>
      ) {
        const ep = event.payload as Record<string, unknown>;
        const sender = ep?.sender as Record<string, unknown> | undefined;

        if (event.type === "NEW_MESSAGE" && sender?.type === "agent") {
          const text = extractText(ep?.content);
          if (!text) continue;

          if (firstMessage) {
            // Edit the initial deferred response
            await callDiscordAPI(
              cfg,
              `/webhooks/${cfg.applicationId}/${interactionToken}/messages/@original`,
              {
                method: "PATCH",
                body: JSON.stringify({ content: text }),
              },
            );
            firstMessage = false;
          } else {
            // Send follow-up messages
            await callDiscordAPI(
              cfg,
              `/webhooks/${cfg.applicationId}/${interactionToken}`,
              {
                method: "POST",
                body: JSON.stringify({ content: text }),
              },
            );
          }
        }

        if (event.type === "ASSET_CREATED") {
          const dataUrl = ep?.dataUrl as string | undefined;
          const mime = ep?.mime as string | undefined;
          if (dataUrl && mime) {
            const blob = dataUrlToBlob(dataUrl);
            const formData = new FormData();
            
            // Discord multipart follow-up
            formData.append("payload_json", JSON.stringify({
              attachments: [{ id: 0, filename: `file.${mime.split("/")[1] || "bin"}` }]
            }));
            formData.append("files[0]", blob, `file.${mime.split("/")[1] || "bin"}`);

            await callDiscordAPI(
              cfg,
              `/webhooks/${cfg.applicationId}/${interactionToken}`,
              {
                method: "POST",
                body: formData,
              },
            );
          }
        }
      }
    },
  };
}

export const discordEgressAdapter = createDiscordEgressAdapter();
export default discordEgressAdapter;
