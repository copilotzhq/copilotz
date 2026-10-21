/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
// deno-lint-ignore verbatim-module-syntax -- classic JSX requires this runtime import.
import * as React from "react";
import { defineView, type ViewDefinition } from "@copilotz/copilotz/views";
import type { BrowserViewContext } from "@copilotz/copilotz/web";
import { chatConfig } from "../chat/context.tsx";
import { startConversation } from "../chat/start.ts";
import { readSpace } from "../reads.ts";
import { ConversationStart } from "../thread/index.tsx";

/** A new conversation: a welcome, suggestions, and the composer. */
const view: ViewDefinition<
  { spaceId?: string } | null,
  React.ReactNode,
  BrowserViewContext
> = defineView<
  { spaceId?: string } | null,
  React.ReactNode,
  BrowserViewContext
>({
  id: "core.newThread",
  shows: "newThread",
  renderer: "react",
  modes: ["full", "panel"],
  url: true,
  render(value, ctx) {
    const config = chatConfig(ctx);
    const spaceId = value?.spaceId;
    const space = spaceId ? readSpace(ctx, spaceId).value : undefined;
    return (
      <section
        aria-label="New conversation"
        className="flex h-full min-h-0 flex-col"
      >
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ConversationStart
            title={config.labels.emptyTitle ??
              (space?.name
                ? `New conversation in ${String(space.name)}`
                : config.branding.title
                ? `What can ${config.branding.title} do for you?`
                : "How can we help?")}
            hint={config.labels.emptyHint ?? config.branding.subtitle}
            suggestions={config.suggestions}
            logoUrl={config.branding.logoUrl}
            onSuggestion={config.self && ctx.actions.chatCreateThread
              ? (text) =>
                void startConversation(ctx, {
                  text,
                  ...(spaceId ? { spaceId } : {}),
                }).catch(() => {})
              : undefined}
          />
        </div>
        {ctx.show({
          shows: "composer",
          value: spaceId ? { spaceId } : {},
        }, { mode: ctx.hints.mode }) as React.ReactNode}
      </section>
    );
  },
});

export default view;
