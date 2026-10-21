/** Browser leaves of the core plugin; no server execute closures. @module */
import type { BrowserPlugin } from "@copilotz/copilotz/web";
import thread from "./views/thread/index.tsx";
import message from "./views/message/index.tsx";
import composer from "./views/composer/index.tsx";
import threads from "./views/threads/index.tsx";
export const coreWebPlugin: BrowserPlugin = {
  id: "@copilotz/core",
  collections: {
    thread: { placement: "server" },
    message: { placement: "server" },
    participant: { placement: "server" },
    draft: {
      placement: "browser",
      initial: [],
      commands: {
        set: {
          mutate: ({ input }) => ({
            set: { text: String((input as { text: string }).text) },
          }),
        },
      },
    },
  },
  actions: {
    createThread: { id: "copilotz.core.thread.create", placement: "server" },
    createThreadMessage: {
      id: "copilotz.core.thread-message.create",
      placement: "server",
    },
    reviseMessage: { id: "copilotz.core.message.revise", placement: "server" },
    deleteThreadMessages: {
      id: "copilotz.core.thread.deleteMessages",
      placement: "server",
    },
    setDraft: {
      id: "core.draft.set",
      placement: "browser",
      execute(input, ctx) {
        const draft = input as { threadId: string; text: string };
        ctx.command("draft", draft.threadId, "set", draft);
      },
    },
  },
  views: { thread, message, composer, threads },
  resources: {
    navigation: {
      conversations: {
        label: "Conversations",
        shows: { list: "thread" },
        value: null,
      },
    },
  },
};

export { messageReadSelection, readThreadMessages } from "./views/reads.ts";
