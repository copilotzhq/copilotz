/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
// deno-lint-ignore verbatim-module-syntax -- classic JSX requires this runtime import.
import * as React from "react";
import { useState } from "react";
import { ChevronDown, Plus, Users } from "lucide-react";
import { defineView, type ViewDefinition } from "@copilotz/copilotz/views";
import type { BrowserViewContext } from "@copilotz/copilotz/web";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@copilotz/copilotz/web/kit";
import type { ChatSender } from "../../shared/chat-messages.ts";
import { readSenders } from "../chat/context.tsx";
import { readThread } from "../reads.ts";
import { SenderAvatar } from "../chat/identity.tsx";

type Available = Readonly<{
  key: string;
  name: string;
  description?: string;
  participant: Record<string, unknown>;
}>;

function available(ctx: BrowserViewContext): Available[] {
  const agents = (ctx.resources.chat as Record<string, unknown> | undefined)
    ?.agents;
  return (Array.isArray(agents) ? agents : []).flatMap((agent) => {
    if (!agent || typeof agent !== "object") return [];
    const value = agent as Record<string, unknown>;
    const key = String(value.agentId ?? value.externalId ?? value.id ?? "");
    if (!key) return [];
    return [{
      key,
      name: String(value.name ?? key),
      ...(typeof value.description === "string"
        ? { description: value.description }
        : {}),
      participant: value,
    }];
  });
}

function Selector(
  { agents, candidates, onAdd }: {
    agents: readonly (ChatSender & { description?: string })[];
    candidates: readonly Available[];
    onAdd?(candidate: Available): Promise<unknown>;
  },
): React.ReactElement | null {
  const [error, setError] = useState("");
  if (!agents.length && !candidates.length) return null;
  const shown = agents.slice(0, 3);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={`Agents in this conversation: ${
            agents.map((agent) => agent.name).join(", ") || "none"
          }`}
          className="gap-1.5 px-2"
        >
          {shown.length
            ? (
              <span className="flex -space-x-1.5">
                {shown.map((agent) => (
                  <SenderAvatar
                    key={agent.id}
                    sender={agent}
                    size="sm"
                    className="ring-background ring-2"
                  />
                ))}
              </span>
            )
            : <Users className="text-muted-foreground" />}
          <span className="hidden text-sm sm:inline">
            {agents.length === 1 ? agents[0].name : `${agents.length} agents`}
          </span>
          <ChevronDown className="text-muted-foreground size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuLabel>In this conversation</DropdownMenuLabel>
        {agents.map((agent) => (
          <div key={agent.id} className="flex items-center gap-2.5 px-2 py-1.5">
            <SenderAvatar sender={agent} size="sm" />
            <span className="grid min-w-0">
              <span className="truncate text-sm font-medium">
                {agent.name}
              </span>
              {agent.description && (
                <span className="text-muted-foreground truncate text-xs">
                  {agent.description}
                </span>
              )}
            </span>
          </div>
        ))}
        {!agents.length && (
          <p className="text-muted-foreground px-2 py-1.5 text-sm">
            No agents yet.
          </p>
        )}
        {onAdd && candidates.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Add an agent</DropdownMenuLabel>
            {candidates.map((candidate) => (
              <DropdownMenuItem
                key={candidate.key}
                onSelect={() =>
                  void onAdd(candidate).then(
                    () => setError(""),
                    (cause) => setError(String(cause?.message ?? cause)),
                  )}
              >
                <Plus />
                <span className="grid min-w-0">
                  <span className="truncate">{candidate.name}</span>
                  {candidate.description && (
                    <span className="text-muted-foreground truncate text-xs">
                      {candidate.description}
                    </span>
                  )}
                </span>
              </DropdownMenuItem>
            ))}
          </>
        )}
        {error && (
          <p role="alert" className="text-destructive px-2 py-1.5 text-xs">
            {error}
          </p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The header's agent control: who is in the conversation, and adding the
 * app's agents. Apps replace it by preferring their own `agentSelector` View.
 */
const view: ViewDefinition<
  { threadId: string },
  React.ReactNode,
  BrowserViewContext
> = defineView<{ threadId: string }, React.ReactNode, BrowserViewContext>({
  id: "core.agentSelector",
  shows: "agentSelector",
  renderer: "react",
  modes: ["full", "panel"],
  render({ threadId }, ctx) {
    const thread = readThread(ctx, threadId).value;
    const ids = Array.isArray(thread?.participantIds)
      ? thread.participantIds.map(String)
      : [];
    const agents = [...readSenders(ctx, ids).values()].filter((sender) =>
      sender.type === "agent"
    );
    const present = new Set(
      agents.flatMap((agent) => [agent.agentId, agent.externalId]),
    );
    const candidates = available(ctx).filter((candidate) =>
      !present.has(candidate.key)
    );
    return (
      <Selector
        agents={agents}
        candidates={candidates}
        onAdd={ctx.actions.chatAddAgent
          ? (candidate) =>
            ctx.actions.chatAddAgent({
              threadId,
              participant: candidate.participant,
            }).result()
          : undefined}
      />
    );
  },
});

export default view;
