/** Browser leaves of the core plugin: chat Collections, intents and Views. @module */
import type {
  BrowserActionDefinition,
  BrowserPlugin,
  ClientCollectionDefinition,
} from "@copilotz/copilotz/web";
import thread from "./views/thread/index.tsx";
import threadLive from "./views/thread-live/index.tsx";
import composer from "./views/composer/index.tsx";
import newThread from "./views/new-thread/index.tsx";
import agentSelector from "./views/agent-selector/index.tsx";
import askToolCall from "./views/ask-tool/index.tsx";
import toolCall from "./views/tool-call/index.tsx";
import {
  type ChatIntentName,
  type ChatIntents,
  coreActionAliases,
  type CoreActionName,
  defaultIntents,
  intentActions,
  intentServerActions,
  loadMessageBody,
  loadToolResult,
} from "./views/chat/intents.ts";
import { THREAD_MESSAGE_LIMIT, THREAD_MESSAGE_MAX } from "./views/reads.ts";

type Commands = NonNullable<ClientCollectionDefinition["commands"]>;

export interface CoreWebOptions {
  /** Composition aliases of the server Actions, when the app renamed them. */
  actionAliases?: Partial<Record<CoreActionName, string>>;
  /**
   * Replace individual intents when the app's server Actions take other
   * inputs (for example an app-owned Space Action).
   */
  intents?: Partial<ChatIntents>;
  /** Extra pure commands for the server Collections' optimistic overlays. */
  commands?: Readonly<
    Partial<Record<"thread" | "message" | "participant" | "space", Commands>>
  >;
}

const set: Commands[string] = {
  mutate: ({ input }) => ({ set: { ...(input as Record<string, unknown>) } }),
};

const serverProxies: Readonly<
  Record<CoreActionName, BrowserActionDefinition>
> = {
  createThread: { id: "copilotz.core.thread.create", placement: "server" },
  createThreadMessage: {
    id: "copilotz.core.thread-message.create",
    placement: "server",
  },
  reviseMessage: { id: "copilotz.core.message.revise", placement: "server" },
  addThreadParticipant: {
    id: "copilotz.core.thread.addParticipant",
    placement: "server",
  },
  spaces: { id: "copilotz.core.spaces", placement: "server" },
  updateConversation: {
    id: "copilotz.core.conversation.update",
    placement: "server",
    optimistic: {
      collection: "thread",
      command: "patch",
      id: (input) => String((input as { threadId: string }).threadId),
      input: (input) => (input as { patch: unknown }).patch,
    },
  },
  deleteConversation: {
    id: "copilotz.core.conversation.delete",
    placement: "server",
  },
};

/** The core browser plugin for an app's composition and server aliases. */
export function createCoreWebPlugin(
  options: CoreWebOptions = {},
): BrowserPlugin {
  const aliases = { ...coreActionAliases, ...options.actionAliases };
  const intents = { ...defaultIntents(aliases), ...options.intents };
  const used = new Set(
    (Object.keys(intentServerActions) as ChatIntentName[]).flatMap((name) =>
      options.intents?.[name] ? [] : intentServerActions[name]
    ),
  );
  const server = (
    name: "thread" | "message" | "participant" | "space",
    commands: Commands = {},
  ): ClientCollectionDefinition => ({
    placement: "server",
    commands: { ...commands, ...options.commands?.[name] },
  });
  return {
    id: "@copilotz/core",
    collections: {
      thread: server("thread", { patch: set }),
      message: server("message"),
      participant: server("participant"),
      space: server("space", { patch: set }),
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
      // Messages written here show at once, then give way to the live record.
      outbox: { placement: "browser", initial: [], commands: { set } },
      // Live replies and running operations, from the thread feed.
      threadFeed: { placement: "browser", initial: [], commands: { set } },
      threadRun: { placement: "browser", initial: [], commands: { set } },
      threadOutputs: { placement: "browser", initial: [], commands: { set } },
      threadWindow: { placement: "browser", initial: [], commands: { set } },
      // JSON tool results read on demand, by tool call id.
      toolResult: { placement: "browser", initial: [], commands: { set } },
      // Message text bodies a window read deferred, read on demand by asset.
      messageBody: { placement: "browser", initial: [], commands: { set } },
      // Conversations started here and not yet confirmed created, by id.
      pendingThread: { placement: "browser", initial: [], commands: { set } },
    },
    actions: {
      // Server proxies only for Actions a default intent still in use calls.
      ...Object.fromEntries(
        [...used].map((name) => [aliases[name], serverProxies[name]]),
      ),
      setDraft: {
        id: "core.draft.set",
        placement: "browser",
        execute(input, ctx) {
          const draft = input as { threadId: string; text: string };
          ctx.command("draft", draft.threadId, "set", draft);
        },
      },
      chatLoadOlder: {
        id: "core.chat.loadOlder",
        placement: "browser",
        execute(input, ctx) {
          const { threadId } = input as { threadId: string };
          const current = Number(
            ctx.collections.threadWindow.get(threadId).value?.limit ??
              THREAD_MESSAGE_LIMIT,
          );
          ctx.command("threadWindow", threadId, "set", {
            limit: Math.min(current + THREAD_MESSAGE_LIMIT, THREAD_MESSAGE_MAX),
          });
        },
      },
      chatLoadToolResult: {
        id: "core.chat.loadToolResult",
        placement: "browser",
        execute: (input, ctx) =>
          loadToolResult(input as Parameters<typeof loadToolResult>[0], ctx),
      },
      chatLoadBody: {
        id: "core.chat.loadBody",
        placement: "browser",
        execute: (input, ctx) =>
          loadMessageBody(
            input as Parameters<typeof loadMessageBody>[0],
            ctx,
          ),
      },
      ...intentActions(intents),
    },
    views: {
      thread,
      threadLive,
      composer,
      newThread,
      agentSelector,
      askToolCall,
      toolCall,
    },
    resources: {
      toolRenderers: { ask: { view: "askToolCall", inline: true } },
    },
  };
}

/** The core browser plugin with Core's standard composition aliases. */
export const coreWebPlugin: BrowserPlugin = createCoreWebPlugin();

export {
  messageReadSelection,
  PARTICIPANT_BATCH,
  readParticipants,
  readSpace,
  readSpaces,
  readSpaceThreads,
  readThread,
  readThreadMessages,
  readThreads,
  THREAD_LIST_LIMIT,
  THREAD_MESSAGE_LIMIT,
} from "./views/reads.ts";
export {
  type ThreadFeedAdapter,
  threadFeedAdapter,
} from "./views/chat/host.ts";
export type { UploadedContent } from "./views/chat/host.ts";
export {
  type ChatIntent,
  type ChatIntentInputs,
  type ChatIntentName,
  type ChatIntents,
  coreActionAliases,
  type CoreActionName,
  intentServerActions,
  MESSAGE_BODY_BYTES,
  titleFrom,
  TOOL_RESULT_BYTES,
} from "./views/chat/intents.ts";
export type {
  ChatConfig,
  ChatLabels,
  ToolAudience,
  ToolCallView,
  ToolRenderer,
  ToolSummaryView,
} from "./views/chat/context.tsx";
export {
  chatConfig,
  readSenders,
  technicalDetails,
  toolRenderers,
  withLoadedBodies,
  withLoadedResults,
} from "./views/chat/context.tsx";
export {
  type ToolDisplay,
  type ToolDisplayMode,
  ToolDisplayProvider,
  useToolDisplay,
} from "./views/chat/tool-display.tsx";
export { SenderAvatar, senderColor } from "./views/chat/identity.tsx";
export { draftKey } from "./views/composer/index.tsx";
export {
  type ChatActivity,
  type ChatAttachment,
  type ChatDeferredBody,
  type ChatMessage,
  type ChatMessageGroup,
  type ChatSender,
  chatSender,
  type ChatTextPart,
  finishedReplies,
  groupMessages,
  joinText,
  liveMessage,
  messageAttachments,
  messageText,
  messageTextParts,
  ownMessagePredicate,
  parseToolInput,
  projectMessages,
  settleFinished,
  toolReaderIds,
  type ToolResultRef,
  type ToolResultStatus,
} from "./shared/chat-messages.ts";
export {
  createFeedProjector,
  type FeedAttempt,
  type FeedFrame,
  type FeedState,
  type FeedToolDraft,
} from "./shared/chat-feed.ts";
export { MessageGroup, type MessageGroupProps } from "./views/chat/message.tsx";
export {
  type ActivityLabels,
  ActivityMemory,
  AssistantActivity,
  formatElapsed,
  toolLabel,
  type ToolPresentation,
} from "./views/chat/activity.tsx";
export {
  Composer,
  type ComposerSubmit,
  type MentionTarget,
} from "./views/chat/composer.tsx";
export {
  type LogItem,
  MessageLog,
  prependScrollTop,
} from "./views/chat/list.tsx";
export { canRecordVoice, VoiceComposer } from "./views/chat/voice.tsx";
export { startConversation } from "./views/chat/start.ts";
