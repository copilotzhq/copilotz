import {
  blobToBase64,
  type IngressAdapter,
  type IngressEnvelope,
} from "@/server/channels.ts";
import { setChannelContext } from "@/runtime/thread-metadata.ts";
import {
  resolveDiscordConfig,
  type DiscordConfig,
  verifyDiscordSignature,
} from "./shared.ts";

export function createDiscordIngressAdapter(
  config?: Partial<DiscordConfig>,
): IngressAdapter {
  return {
    async handle(request) {
      const cfg = resolveDiscordConfig(config, request.context);
      
      const signature = request.headers["x-signature-ed25519"];
      const timestamp = request.headers["x-signature-timestamp"];

      if (!signature || !timestamp || !request.rawBody) {
        return {
          status: 401,
          response: { error: "Invalid request signature" },
          messages: [],
        };
      }

      const isValid = await verifyDiscordSignature(
        cfg.publicKey,
        signature,
        timestamp,
        request.rawBody,
      );

      if (!isValid) {
        return {
          status: 401,
          response: { error: "Invalid request signature" },
          messages: [],
        };
      }

      const interaction = request.body as any;

      // Handle Ping
      if (interaction.type === 1) {
        return {
          status: 200,
          response: { type: 1 },
          messages: [],
        };
      }

      // Handle Command/Interaction
      if (interaction.type === 2 || interaction.type === 3) {
        const user = interaction.member?.user || interaction.user;
        const userId = user.id;
        const userName = user.username;
        const channelId = interaction.channel_id;
        const guildId = interaction.guild_id;

        type ContentItem =
          | { type: "text"; text: string }
          | { type: "image"; dataBase64: string; mimeType: string }
          | { type: "file"; dataBase64: string; mimeType: string };

        const contentParts: ContentItem[] = [];

        if (interaction.type === 2) {
          // Slash command - extract options as content or use command name
          const options = interaction.data.options || [];
          const promptOpt = options.find((opt: any) => opt.name === "prompt" || opt.name === "message");
          if (promptOpt) {
            contentParts.push({ type: "text", text: promptOpt.value });
          } else if (!options.some((opt: any) => opt.type === 11)) {
             contentParts.push({ type: "text", text: `/${interaction.data.name}` });
          }

          // Handle attachments (Type 11)
          const attachments = options.filter((opt: any) => opt.type === 11);
          for (const attr of attachments) {
            const file = interaction.data.resolved.attachments[attr.value];
            if (file) {
              const res = await fetch(file.url);
              if (res.ok) {
                const blob = await res.blob();
                const type = file.content_type?.startsWith("image/") ? "image" as const : "file" as const;
                contentParts.push({
                  type,
                  dataBase64: await blobToBase64(blob),
                  mimeType: file.content_type || "application/octet-stream",
                });
              }
            }
          }
        } else if (interaction.type === 3) {
          // Component (button/select)
          contentParts.push({ type: "text", text: interaction.data.custom_id });
        }

        const content = contentParts.length === 1 && contentParts[0].type === "text"
          ? contentParts[0].text
          : contentParts;

        const messages: IngressEnvelope[] = [{
          message: {
            content,
            sender: {
              type: "user",
              id: userId,
              name: userName,
              externalId: userId,
              metadata: { discord: user },
            },
            thread: {
              externalId: channelId || userId,
            },
          },
          threadMetadataPatch: setChannelContext(undefined, "discord", {
            interactionId: interaction.id,
            interactionToken: interaction.token,
            channelId,
            guildId,
            userId,
            userName,
          }),
        }];

        // Discord expects an immediate response to the interaction.
        // We return DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE (type 5) to give the bot time to think.
        return {
          status: 200,
          response: { type: 5 },
          messages,
        };
      }

      return {
        status: 200,
        response: { status: "ok" },
        messages: [],
      };
    },
  };
}

export const discordIngressAdapter = createDiscordIngressAdapter();
export default discordIngressAdapter;
