/**
 * What a new key does, in a click (the `apiPresets` resource, which the API
 * plugin's front end offers): talking with the space's agents, or reading
 * its conversations. Each is a scope; its role follows (editor when it calls
 * or writes). An app adds its own (`notes: { title, description, scope }`),
 * or takes one away (`read: null`).
 */
import type { ApiPreset } from "../contract.ts";

export const presets: Record<string, ApiPreset> = {
  chat: {
    title: "Chat",
    description:
      "Send messages (and files) to the agents here, stop a reply, and read the conversations.",
    scope: {
      call: ["chat.send", "chat.attach", "chat.stop"],
      query: ["thread.recent", "message.conversation"],
    },
    order: 10,
  },
  read: {
    title: "Read only",
    description: "Read the conversations here, and change nothing.",
    scope: { query: ["thread.recent", "message.conversation", "message.history"] },
    order: 20,
  },
};
