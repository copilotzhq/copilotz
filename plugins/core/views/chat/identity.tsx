/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
/** Sender avatars and names, colored by identity. @module */
// deno-lint-ignore verbatim-module-syntax -- classic JSX requires this runtime import.
import * as React from "react";
import { Bot, User, Wrench } from "lucide-react";
import { markdownUrlPolicy } from "@copilotz/copilotz/web";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  cn,
  identityColor,
  initials,
} from "@copilotz/copilotz/web/kit";
import type { ChatSender } from "../../shared/chat-messages.ts";

function pageOrigin(): string | undefined {
  try {
    return globalThis.location?.origin;
  } catch {
    return undefined;
  }
}

/** An avatar image loads only where Markdown images may (same origin or allowlisted). */
export function avatarSource(
  url: string | undefined,
  imageOrigins: readonly string[] = [],
): string | undefined {
  if (!url) return undefined;
  const policy = markdownUrlPolicy({ origin: pageOrigin(), imageOrigins });
  return policy.loadsImage(url) ? url : undefined;
}

/** The color that marks an agent (or person) across names, avatars and mentions. */
export function senderColor(
  sender: Pick<ChatSender, "id" | "agentId">,
): string {
  return identityColor(sender.agentId ?? sender.id);
}

export function SenderAvatar(
  { sender, size = "md", imageOrigins, className, letters = 2 }: {
    sender: ChatSender;
    size?: "sm" | "md";
    imageOrigins?: readonly string[];
    className?: string;
    /** One letter suits overlapping stacks, where a second would be cut. */
    letters?: 1 | 2;
  },
): React.ReactElement {
  const source = avatarSource(sender.avatarUrl, imageOrigins);
  // An unread sender is neutral: no identity color, a plain person or bot.
  const agentLike = sender.type !== "human" && !sender.unknown;
  const color = agentLike ? senderColor(sender) : undefined;
  return (
    <Avatar
      className={cn(size === "sm" ? "size-6" : "size-8", className)}
      aria-hidden="true"
    >
      {source && <AvatarImage src={source} alt="" />}
      <AvatarFallback
        className={cn(
          "font-semibold",
          size === "sm" ? "text-[10px]" : "text-xs",
          agentLike ? "text-white" : "bg-secondary text-secondary-foreground",
        )}
        style={color ? { backgroundColor: color } : undefined}
      >
        {sender.type === "tool"
          ? <Wrench className="size-3.5" />
          : sender.type === "system" ||
              (sender.unknown && sender.type !== "human")
          ? <Bot className="size-3.5" />
          : sender.unknown
          ? <User className="size-3.5" />
          : initials(sender.name).slice(0, letters)}
      </AvatarFallback>
    </Avatar>
  );
}
