/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
/** One speaker's consecutive messages: header, bodies, attachments and actions. @module */
// deno-lint-ignore verbatim-module-syntax -- classic JSX requires this runtime import.
import * as React from "react";
import { memo, useEffect, useState } from "react";
import {
  Check,
  Copy,
  Download,
  File,
  FileArchive,
  FileAudio,
  FileImage,
  FileText,
  FileVideo,
  Pencil,
  RotateCcw,
  X,
} from "lucide-react";
import {
  Badge,
  browser,
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  formatBytes,
  formatDateTime,
  formatWhen,
  Markdown,
  type MarkdownPlugin,
  Spinner,
  Textarea,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@copilotz/copilotz/web/kit";
import type {
  ChatActivity,
  ChatAttachment,
  ChatDeferredBody,
  ChatMessage,
  ChatMessageGroup,
} from "../../shared/chat-messages.ts";
import { AssistantActivity, type ToolPresentation } from "./activity.tsx";
import type { ActivityLabels } from "./activity.tsx";
import { SenderAvatar, senderColor } from "./identity.tsx";

/** Loads a persisted attachment body (from `adapters.core.feed.asset`). */
export type AssetLoader = (
  messageId: string,
  assetId: string,
  signal: AbortSignal,
) => Promise<Blob>;

export interface MessageGroupProps {
  group: ChatMessageGroup;
  imageOrigins?: readonly string[];
  markdownPlugins?: readonly MarkdownPlugin[];
  /** Rendered tool Views, by activity id. */
  tools?: ReadonlyMap<string, ToolPresentation>;
  labels?: ActivityLabels;
  /** The person chose "Show technical details" (see `ChatConfig`). */
  technical?: boolean;
  loadAsset?: AssetLoader;
  /** Read a tool's referenced JSON result, when its step or renderer shows. */
  onLoadResult?(item: ChatActivity): void;
  /** Read a message text body the window read deferred, when it shows. */
  onLoadBody?(messageId: string, assetId: string): void;
  onEdit?(messageId: string, text: string): Promise<void>;
  onRetry?(messageId: string): void;
  onDiscard?(messageId: string): void;
}

function attachmentKind(attachment: ChatAttachment): ChatAttachment["kind"] {
  if (attachment.kind !== "file") return attachment.kind;
  const type = attachment.mediaType;
  return type.startsWith("image/")
    ? "image"
    : type.startsWith("audio/")
    ? "audio"
    : type.startsWith("video/")
    ? "video"
    : "file";
}

function AttachmentIcon(
  { attachment, className }: { attachment: ChatAttachment; className?: string },
): React.ReactElement {
  const kind = attachmentKind(attachment);
  const name = `${attachment.name ?? ""} ${attachment.mediaType}`.toLowerCase();
  const Icon = kind === "image"
    ? FileImage
    : kind === "audio"
    ? FileAudio
    : kind === "video"
    ? FileVideo
    : /zip|gzip|tar|archive/.test(name)
    ? FileArchive
    : /json|text|markdown|csv|pdf/.test(name)
    ? FileText
    : File;
  return <Icon aria-hidden="true" className={cn("size-5", className)} />;
}

/** A body URL: the local preview, or the persisted asset loaded on demand. */
function useAttachmentUrl(
  attachment: ChatAttachment,
  messageId: string,
  loadAsset: AssetLoader | undefined,
  enabled: boolean,
): { url?: string; failed: boolean } {
  const [state, setState] = useState<{ url?: string; failed: boolean }>({
    url: attachment.url,
    failed: false,
  });
  useEffect(() => {
    if (attachment.url || !enabled || !attachment.assetId || !loadAsset) {
      setState({ url: attachment.url, failed: false });
      return;
    }
    const controller = new AbortController();
    let created: string | undefined;
    loadAsset(messageId, attachment.assetId, controller.signal).then(
      (blob) => {
        if (controller.signal.aborted) return;
        created = URL.createObjectURL(blob);
        setState({ url: created, failed: false });
      },
      () => {
        if (!controller.signal.aborted) setState({ failed: true });
      },
    );
    return () => {
      controller.abort();
      if (created) URL.revokeObjectURL(created);
    };
  }, [attachment.url, attachment.assetId, messageId, loadAsset, enabled]);
  return state;
}

function AttachmentMeta(
  { attachment }: { attachment: ChatAttachment },
): React.ReactElement {
  return (
    <span className="truncate text-xs">
      {[attachment.mediaType, formatBytes(attachment.size)].filter(Boolean)
        .join(" · ")}
    </span>
  );
}

function AttachmentView(
  { attachment, messageId, loadAsset }: {
    attachment: ChatAttachment;
    messageId: string;
    loadAsset?: AssetLoader;
  },
): React.ReactElement {
  const kind = attachmentKind(attachment);
  const visual = kind === "image" || kind === "audio" || kind === "video";
  const { url, failed } = useAttachmentUrl(
    attachment,
    messageId,
    loadAsset,
    visual,
  );
  const [open, setOpen] = useState(false);
  const label = attachment.name ?? attachment.mediaType;
  const card = (
    <span
      data-slot="attachment-card"
      className="bg-card text-foreground flex w-full min-w-0 max-w-sm items-center gap-3 rounded-lg border p-2.5 text-left"
    >
      <span
        data-slot="attachment-icon"
        className="bg-muted flex size-10 shrink-0 items-center justify-center rounded-md"
      >
        <AttachmentIcon attachment={attachment} />
      </span>
      <span className="grid min-w-0 flex-1">
        <span className="truncate text-sm font-medium">{label}</span>
        <span data-slot="attachment-meta" className="text-muted-foreground">
          <AttachmentMeta attachment={attachment} />
        </span>
      </span>
    </span>
  );
  if (kind === "audio" && url) {
    return (
      <audio
        className="w-full max-w-sm"
        controls
        preload="metadata"
        src={url}
        aria-label={label}
      />
    );
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <button
        type="button"
        aria-label={`Open ${label}`}
        className="focus-visible:ring-ring/45 block max-w-full rounded-lg outline-none focus-visible:ring-[3px]"
        onClick={() => setOpen(true)}
      >
        {kind === "image" && url && !failed
          ? (
            <img
              src={url}
              alt={label}
              loading="lazy"
              className="max-h-64 max-w-full rounded-lg border object-cover sm:max-w-sm"
            />
          )
          : kind === "video" && url
          ? (
            <video
              src={url}
              muted
              preload="metadata"
              className="max-h-64 max-w-full rounded-lg border sm:max-w-sm"
            />
          )
          : card}
      </button>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="truncate">{label}</DialogTitle>
          <DialogDescription>
            <AttachmentMeta attachment={attachment} />
          </DialogDescription>
        </DialogHeader>
        {kind === "image" && url
          ? (
            <img
              src={url}
              alt={label}
              className="mx-auto max-h-[65dvh] max-w-full rounded-lg object-contain"
            />
          )
          : kind === "video" && url
          ? (
            <video
              src={url}
              controls
              className="max-h-[65dvh] w-full rounded-lg"
            />
          )
          : (
            <div className="bg-muted/40 flex flex-col items-center gap-3 rounded-lg border p-8">
              <AttachmentIcon attachment={attachment} className="size-8" />
              <p className="max-w-full truncate text-sm font-medium">
                {label}
              </p>
            </div>
          )}
        <DialogFooter>
          <DownloadButton
            attachment={attachment}
            messageId={messageId}
            loadAsset={loadAsset}
            url={url}
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DownloadButton(
  { attachment, messageId, loadAsset, url }: {
    attachment: ChatAttachment;
    messageId: string;
    loadAsset?: AssetLoader;
    url?: string;
  },
): React.ReactElement | null {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  if (!url && !(attachment.assetId && loadAsset)) return null;
  const save = (href: string) => {
    const anchor = browser.document!.createElement("a");
    anchor.href = href;
    anchor.download = attachment.name ?? "attachment";
    anchor.click();
  };
  return (
    <Button
      type="button"
      disabled={busy}
      onClick={() => {
        if (url) return save(url);
        setBusy(true);
        setError(false);
        loadAsset!(messageId, attachment.assetId!, new AbortController().signal)
          .then((blob) => {
            const href = URL.createObjectURL(blob);
            save(href);
            setTimeout(() => URL.revokeObjectURL(href), 10_000);
          }, () => setError(true)).finally(() => setBusy(false));
      }}
    >
      {busy ? <Spinner className="text-primary-foreground" /> : <Download />}
      {error ? "Try again" : "Download"}
    </Button>
  );
}

function CopyButton({ text }: { text: string }): React.ReactElement | null {
  const [copied, setCopied] = useState(false);
  const clipboard = (globalThis as {
    navigator?: { clipboard?: { writeText(text: string): Promise<void> } };
  }).navigator?.clipboard;
  if (!clipboard || !text) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={copied ? "Copied" : "Copy message"}
          onClick={() =>
            clipboard.writeText(text).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1600);
            }, () => setCopied(false))}
        >
          {copied ? <Check className="text-success" /> : <Copy />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{copied ? "Copied" : "Copy"}</TooltipContent>
    </Tooltip>
  );
}

function Editor(
  { initial, onSave, onCancel }: {
    initial: string;
    onSave(text: string): Promise<void>;
    onCancel(): void;
  },
): React.ReactElement {
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const changed = text.trim() && text.trim() !== initial.trim();
  return (
    <form
      className="bg-card grid w-full max-w-2xl gap-2 rounded-xl border p-2 shadow-soft"
      onSubmit={(event) => {
        event.preventDefault();
        if (!changed || busy) return;
        setBusy(true);
        setError("");
        onSave(text.trim()).then(onCancel, (cause) =>
          setError(
            cause instanceof Error ? cause.message : "The edit was not saved.",
          )).finally(() => setBusy(false));
      }}
    >
      <Textarea
        aria-label="Edit message"
        autoFocus
        value={text}
        className="min-h-24 resize-y border-0 shadow-none focus-visible:ring-0"
        onKeyDown={(event) => {
          if (event.key === "Escape") onCancel();
        }}
        onChange={(event) =>
          setText((event.target as unknown as { value: string }).value)}
      />
      {error && (
        <p role="alert" className="text-destructive px-1 text-sm">{error}</p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!changed || busy}>
          {busy ? "Saving…" : "Save and resend"}
        </Button>
      </div>
    </form>
  );
}

/**
 * Text the window read deferred (over its budget): read when it shows, with
 * a calm note while it loads, if it is too long, or if it failed.
 */
function DeferredText(
  { message, onLoadBody }: {
    message: ChatMessage;
    onLoadBody?(messageId: string, assetId: string): void;
  },
): React.ReactElement | null {
  const waiting = (message.pending ?? []).filter((
    part,
  ): part is ChatDeferredBody => "assetId" in part);
  const signature = waiting.map((part) => `${part.assetId}:${part.status}`)
    .join(" ");
  useEffect(() => {
    for (const part of waiting) {
      if (!part.status) onLoadBody?.(message.id, part.assetId);
    }
  }, [message.id, signature]);
  if (!waiting.length) return null;
  const retry = () => {
    for (const part of waiting) onLoadBody?.(message.id, part.assetId);
  };
  return (
    <p
      role="status"
      data-slot="deferred-text"
      className="text-muted-foreground flex items-center gap-2 text-sm"
    >
      {waiting.some((part) => part.status === "unavailable")
        ? (
          <>
            This message couldn't be loaded.
            {onLoadBody && (
              <button
                type="button"
                onClick={retry}
                className="hover:text-foreground focus-visible:ring-ring/45 rounded underline underline-offset-4 outline-none focus-visible:ring-[3px]"
              >
                Try again
              </button>
            )}
          </>
        )
        : waiting.some((part) => part.status === "too-large")
        ? "This message is too long to show here."
        : (
          <>
            <Spinner className="size-3" /> Loading this message…
          </>
        )}
    </p>
  );
}

function Body(
  { message, bubble, imageOrigins, markdownPlugins, onLoadBody }: {
    message: ChatMessage;
    bubble: boolean;
    imageOrigins?: readonly string[];
    markdownPlugins?: readonly MarkdownPlugin[];
    onLoadBody?(messageId: string, assetId: string): void;
  },
): React.ReactElement | null {
  const deferred = message.pending
    ? <DeferredText message={message} onLoadBody={onLoadBody} />
    : null;
  if (!message.text) return deferred;
  return (
    <>
      <Markdown
        variant="chat"
        imageOrigins={imageOrigins}
        plugins={markdownPlugins}
        streaming={message.status === "streaming"}
        className={bubble ? "prose-chat" : undefined}
      >
        {message.text}
      </Markdown>
      {deferred}
    </>
  );
}

/** One speaker's run of messages under one name and avatar. */
export const MessageGroup: React.NamedExoticComponent<MessageGroupProps> = memo(
  function MessageGroup(
    {
      group,
      imageOrigins,
      markdownPlugins,
      tools,
      labels,
      technical,
      loadAsset,
      onLoadResult,
      onLoadBody,
      onEdit,
      onRetry,
      onDiscard,
    }: MessageGroupProps,
  ): React.ReactElement {
    const [editing, setEditing] = useState<string | null>(null);
    const first = group.messages[0];
    const human = group.role === "user";
    const own = group.own;
    const color = human || group.sender.unknown
      ? undefined
      : senderColor(group.sender);
    const time = first.createdAt;
    return (
      <article
        data-slot="message-group"
        data-own={own || undefined}
        aria-label={`${group.sender.name}${
          time ? `, ${formatDateTime(time)}` : ""
        }`}
        className={cn(
          "group/message flex gap-3",
          own && "flex-row-reverse",
        )}
      >
        <SenderAvatar
          sender={group.sender}
          imageOrigins={imageOrigins}
          className="mt-0.5"
        />
        <div
          className={cn(
            "flex min-w-0 flex-1 flex-col gap-1.5",
            own && "items-end",
          )}
        >
          <header
            className={cn(
              "flex h-6 items-baseline gap-2",
              own && "flex-row-reverse",
            )}
          >
            <span
              className="text-sm font-semibold"
              style={color ? { color } : undefined}
            >
              {group.sender.name}
            </span>
            {time && (
              <time
                dateTime={time}
                title={formatDateTime(time)}
                className="text-muted-foreground text-xs opacity-0 transition-opacity group-focus-within/message:opacity-100 group-hover/message:opacity-100"
              >
                {formatWhen(time)}
              </time>
            )}
            {group.messages.some((message) => message.edited) && (
              <Badge variant="outline" className="font-normal">edited</Badge>
            )}
          </header>
          {group.messages.map((message) => {
            const attachments = message.attachments.length > 0 && (
              <div
                className={cn(
                  "flex flex-wrap gap-2",
                  own && "justify-end",
                )}
              >
                {message.attachments.map((attachment, index) => (
                  <AttachmentView
                    key={`${attachment.assetId ?? attachment.url}:${index}`}
                    attachment={attachment}
                    messageId={message.id}
                    loadAsset={loadAsset}
                  />
                ))}
              </div>
            );
            if (editing === message.id && onEdit) {
              return (
                <Editor
                  key={message.id}
                  initial={message.text}
                  onSave={(text) => onEdit(message.id, text)}
                  onCancel={() => setEditing(null)}
                />
              );
            }
            return (
              <div
                key={message.id}
                data-message-id={message.id}
                tabIndex={-1}
                // Full width, so a bubble's max width is a share of the
                // column, not of its own text (which would wrap any text).
                className={cn(
                  "outline-none",
                  "group/body flex w-full min-w-0 flex-col gap-2",
                  human && "items-end",
                  human && !own && "items-start",
                )}
              >
                {!human && message.activity.length > 0 && (
                  <AssistantActivity
                    items={message.activity}
                    tools={tools}
                    labels={labels}
                    technical={technical}
                    agent={group.sender.name}
                    onLoadResult={onLoadResult}
                  />
                )}
                {human
                  ? (message.text || message.pending || attachments) && (
                    <div
                      data-slot="message-bubble"
                      className={cn(
                        "flex max-w-[min(42rem,88%)] min-w-0 flex-col gap-2 rounded-2xl px-3.5 py-2.5",
                        own
                          ? "bubble bg-bubble text-bubble-foreground rounded-tr-md"
                          : "bg-muted rounded-tl-md",
                        message.status === "sending" && "opacity-70",
                        message.status === "failed" &&
                          "ring-destructive/50 ring-1",
                      )}
                    >
                      <Body
                        message={message}
                        bubble
                        imageOrigins={imageOrigins}
                        markdownPlugins={markdownPlugins}
                        onLoadBody={onLoadBody}
                      />
                      {attachments}
                    </div>
                  )
                  : (
                    <>
                      <Body
                        message={message}
                        bubble={false}
                        imageOrigins={imageOrigins}
                        markdownPlugins={markdownPlugins}
                        onLoadBody={onLoadBody}
                      />
                      {attachments}
                    </>
                  )}
                {message.status === "sending" && (
                  <p
                    role="status"
                    className="text-muted-foreground flex items-center gap-1.5 text-xs"
                  >
                    <Spinner className="size-3" /> Sending…
                  </p>
                )}
                {message.status === "failed" && (
                  <div
                    role="alert"
                    className="text-destructive flex flex-wrap items-center gap-2 text-xs"
                  >
                    <span>{message.error ?? "Not sent."}</span>
                    {onRetry && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        onClick={() => onRetry(message.id)}
                      >
                        <RotateCcw /> Retry
                      </Button>
                    )}
                    {onDiscard && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        onClick={() => onDiscard(message.id)}
                      >
                        <X /> Discard
                      </Button>
                    )}
                  </div>
                )}
                {message.status === "sent" && (message.text || own) && (
                  <div
                    className={cn(
                      "text-muted-foreground flex h-7 items-center gap-0.5 opacity-0 transition-opacity group-focus-within/body:opacity-100 group-hover/body:opacity-100",
                      own && "flex-row-reverse",
                    )}
                  >
                    <CopyButton text={message.text} />
                    {own && onEdit && message.text && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-xs"
                            aria-label="Edit message"
                            onClick={() => setEditing(message.id)}
                          >
                            <Pencil />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Edit</TooltipContent>
                      </Tooltip>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </article>
    );
  },
);
