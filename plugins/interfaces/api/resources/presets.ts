/**
 * What a new key does, in a click (the `apiPresets` resource, which the API
 * plugin's front end offers): talking with the space's agents, or reading
 * its conversations. An app adds its own (`notes: { title, description,
 * actions, queries }`), or takes one away (`read: null`).
 */
import type { ApiPreset } from "../contract.ts";

export const presets: Record<string, ApiPreset> = {
  chat: {
    title: "Chat",
    description: "Send messages to the agents here, stop a reply, and read the conversations.",
    actions: ["chat.send", "chat.stop"],
    queries: ["thread.recent", "message.conversation"],
    order: 10,
  },
  read: {
    title: "Read only",
    description: "Read the conversations here, and change nothing.",
    queries: ["thread.recent", "message.conversation", "message.history"],
    order: 20,
  },
};
