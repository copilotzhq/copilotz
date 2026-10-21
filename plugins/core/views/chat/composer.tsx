/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
"use client";
/**
 * The message composer: an auto-growing field, an attachment tray with
 * previews, drag and drop and paste, @mentions of the conversation's agents,
 * voice messages, and Send or Stop.
 * @module
 */
// deno-lint-ignore verbatim-module-syntax -- classic JSX requires this runtime import.
import * as React from "react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  AtSign,
  FileText,
  Mic,
  Paperclip,
  Square,
  UploadCloud,
  X,
} from "lucide-react";
import {
  Button,
  cn,
  dom,
  domEvent,
  formatBytes,
  mediaMatches,
  nextFrame,
  Spinner,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  transfer,
} from "@copilotz/copilotz/web/kit";
import { canRecordVoice, VoiceComposer } from "./voice.tsx";
import { SenderAvatar } from "./identity.tsx";
import type { ChatSender } from "../../shared/chat-messages.ts";

/** An agent the message may address with @mention. */
export type MentionTarget = Readonly<{
  /** The participant id used in `recipientIds`. */
  id: string;
  name: string;
  description?: string;
  sender: ChatSender;
}>;

export interface ComposerSubmit {
  text: string;
  files: readonly File[];
  /** Targets named by @mention; empty means no mention (the View then applies
   * the app's recipient policy). */
  recipientIds: readonly string[];
}

export interface ComposerLabels {
  placeholder?: string;
  help?: string;
  footer?: string;
}

type Attachment = { id: string; file: File; url?: string };

function kindOf(file: File): "image" | "audio" | "video" | "file" {
  const type = file.type;
  return type.startsWith("image/")
    ? "image"
    : type.startsWith("audio/")
    ? "audio"
    : type.startsWith("video/")
    ? "video"
    : "file";
}

/** The active `@query` before the caret, if any. */
export function activeMention(
  value: string,
  caret: number,
): { start: number; query: string } | null {
  const match = /(^|\s)@([\p{L}\p{N}_.-]*)$/u.exec(value.slice(0, caret));
  return match ? { start: caret - match[2].length - 1, query: match[2] } : null;
}

/** Participants named by `@Name` in a message, in order and once each. */
export function mentionedTargets(
  value: string,
  targets: readonly MentionTarget[],
): string[] {
  const named = [...value.matchAll(/(^|\s)@([\p{L}\p{N}_.-]+)/gu)].map((
    match,
  ) => match[2].toLowerCase());
  const ids: string[] = [];
  for (const name of named) {
    const target = targets.find((candidate) =>
      candidate.name.toLowerCase().replace(/\s+/g, "") === name ||
      candidate.id.toLowerCase() === name
    );
    if (target && !ids.includes(target.id)) ids.push(target.id);
  }
  return ids;
}

const coarse = () => mediaMatches("(pointer: coarse)");

export function Composer(
  {
    value,
    onChange,
    onSubmit,
    onStop,
    generating = false,
    stopping = false,
    disabledReason,
    targets = [],
    attachments: allowAttachments = true,
    voice: allowVoice = true,
    maxAttachments = 6,
    maxFileSize = 20 * 1024 * 1024,
    accept,
    labels = {},
    autoFocus = false,
  }: {
    value: string;
    onChange(value: string): void;
    onSubmit(message: ComposerSubmit): Promise<void> | void;
    onStop?(): void;
    generating?: boolean;
    stopping?: boolean;
    /** Why sending is unavailable (for example "Sign in to send messages."). */
    disabledReason?: string;
    targets?: readonly MentionTarget[];
    attachments?: boolean;
    voice?: boolean;
    maxAttachments?: number;
    maxFileSize?: number;
    accept?: string;
    labels?: ComposerLabels;
    autoFocus?: boolean;
  },
): React.ReactElement {
  const field = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const depth = useRef(0);
  const [files, setFiles] = useState<Attachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const [recording, setRecording] = useState(false);
  const [notice, setNotice] = useState("");
  const [mention, setMention] = useState<
    { start: number; query: string } | null
  >(null);
  const [highlight, setHighlight] = useState(0);
  const disabled = Boolean(disabledReason);
  const voice = allowVoice && canRecordVoice();

  const options = useMemo(() => {
    if (!mention) return [];
    const query = mention.query.toLowerCase();
    return targets.filter((target) =>
      target.name.toLowerCase().includes(query) ||
      target.id.toLowerCase().startsWith(query)
    ).slice(0, 6);
  }, [mention, targets]);

  useLayoutEffect(() => {
    if (!field.current) return;
    const element = dom(field.current);
    element.style.height = "auto";
    const max = 240;
    element.style.height = `${Math.min(element.scrollHeight, max)}px`;
    element.style.overflowY = element.scrollHeight > max ? "auto" : "hidden";
  }, [value]);

  useEffect(() => () => {
    for (const item of files) if (item.url) URL.revokeObjectURL(item.url);
  }, []);

  const add = (list: readonly File[]) => {
    if (!allowAttachments || disabled) return;
    const room = maxAttachments - files.length;
    const accepted: Attachment[] = [];
    const refused: string[] = [];
    for (const file of list) {
      if (accepted.length >= room) {
        refused.push(`${file.name}: at most ${maxAttachments} attachments`);
      } else if (file.size > maxFileSize) {
        refused.push(`${file.name} is over ${formatBytes(maxFileSize)}`);
      } else {
        accepted.push({
          id: crypto.randomUUID(),
          file,
          ...(kindOf(file) === "image"
            ? { url: URL.createObjectURL(file) }
            : {}),
        });
      }
    }
    setNotice(refused.join(". "));
    if (accepted.length) setFiles((current) => [...current, ...accepted]);
  };

  const remove = (id: string) => {
    setFiles((current) => {
      const item = current.find((candidate) => candidate.id === id);
      if (item?.url) URL.revokeObjectURL(item.url);
      return current.filter((candidate) => candidate.id !== id);
    });
  };

  const canSend = !disabled && (value.trim().length > 0 || files.length > 0);
  const submit = (extra: readonly File[] = []) => {
    if (disabled) return;
    const text = value.trim();
    const all = [...files.map((item) => item.file), ...extra];
    if (!text && !all.length) return;
    const recipientIds = mentionedTargets(text, targets);
    setFiles([]);
    setMention(null);
    setNotice("");
    for (const item of files) if (item.url) URL.revokeObjectURL(item.url);
    void Promise.resolve(onSubmit({ text, files: all, recipientIds })).catch(
      (cause) =>
        setNotice(cause instanceof Error ? cause.message : String(cause)),
    );
  };

  const choose = (target: MentionTarget) => {
    if (!mention) return;
    const name = target.name.replace(/\s+/g, "");
    const caret = dom(field.current).selectionStart ?? value.length;
    const next = `${value.slice(0, mention.start)}@${name} ${
      value.slice(caret)
    }`;
    onChange(next);
    setMention(null);
    const position = mention.start + name.length + 2;
    nextFrame(() => {
      const element = dom(field.current);
      element.focus();
      element.setSelectionRange?.(position, position);
    });
  };

  const track = (text: string, caret: number) => {
    const next = targets.length ? activeMention(text, caret) : null;
    setMention(next);
    setHighlight(0);
  };

  const hasFiles = (event: React.DragEvent) =>
    Array.from(transfer(event.dataTransfer)?.types ?? []).includes("Files");

  return (
    <div className="mx-auto w-full max-w-3xl px-3 pb-[max(env(safe-area-inset-bottom),0.75rem)] sm:px-6">
      <form
        aria-label="Message composer"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        onDragEnter={(event) => {
          if (!allowAttachments || !hasFiles(event)) return;
          event.preventDefault();
          depth.current++;
          setDragging(true);
        }}
        onDragOver={(event) => {
          if (!allowAttachments || !hasFiles(event)) return;
          event.preventDefault();
          transfer(event.dataTransfer).dropEffect = "copy";
        }}
        onDragLeave={(event) => {
          if (!allowAttachments || !hasFiles(event)) return;
          depth.current = Math.max(0, depth.current - 1);
          if (!depth.current) setDragging(false);
        }}
        onDrop={(event) => {
          if (!allowAttachments || !hasFiles(event)) return;
          event.preventDefault();
          depth.current = 0;
          setDragging(false);
          add(Array.from(transfer(event.dataTransfer).files));
        }}
        className={cn(
          "bg-card relative flex flex-col rounded-2xl border shadow-soft transition-[border-color,box-shadow]",
          "focus-within:border-ring/60 focus-within:ring-ring/15 focus-within:ring-[3px]",
          dragging && "border-primary/50 ring-primary/15 ring-[3px]",
        )}
      >
        {dragging && (
          <div className="bg-background/85 pointer-events-none absolute inset-0 z-20 flex flex-col items-center justify-center gap-1.5 rounded-2xl border-2 border-dashed border-primary/50 backdrop-blur-[1px]">
            <UploadCloud aria-hidden="true" className="size-5" />
            <p className="text-sm font-medium">Drop files to attach</p>
            <p className="text-muted-foreground text-xs">
              Up to {Math.max(0, maxAttachments - files.length)} more
            </p>
          </div>
        )}
        {files.length > 0 && (
          <ul
            aria-label="Attachments"
            className="flex gap-2 overflow-x-auto border-b px-3 pt-3 pb-2.5"
          >
            {files.map((item) => (
              <li
                key={item.id}
                className="group/file bg-background relative flex h-16 shrink-0 items-center gap-2.5 overflow-hidden rounded-lg border pr-8"
              >
                {item.url
                  ? (
                    <img
                      src={item.url}
                      alt=""
                      className="h-full w-16 object-cover"
                    />
                  )
                  : (
                    <span className="bg-muted ml-2.5 flex size-10 items-center justify-center rounded-md">
                      {kindOf(item.file) === "audio"
                        ? <Mic aria-hidden="true" className="size-4" />
                        : <FileText aria-hidden="true" className="size-4" />}
                    </span>
                  )}
                <span className="grid max-w-40 min-w-0 py-1">
                  <span className="truncate text-xs font-medium">
                    {item.file.name}
                  </span>
                  <span className="text-muted-foreground truncate text-[11px]">
                    {formatBytes(item.file.size)}
                  </span>
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${item.file.name}`}
                  onClick={() => remove(item.id)}
                  className="bg-background/90 hover:bg-accent focus-visible:ring-ring/45 absolute top-1 right-1 flex size-6 items-center justify-center rounded-full border outline-none focus-visible:ring-[3px]"
                >
                  <X aria-hidden="true" className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
        {recording
          ? (
            <div className="p-2">
              <VoiceComposer
                disabled={disabled}
                onClose={() => setRecording(false)}
                onSend={(file) => {
                  setRecording(false);
                  submit([file]);
                }}
              />
            </div>
          )
          : (
            <>
              <div className="relative">
                <textarea
                  ref={field}
                  rows={1}
                  value={value}
                  autoFocus={autoFocus}
                  disabled={disabled}
                  aria-label="Message"
                  aria-autocomplete={targets.length ? "list" : undefined}
                  aria-expanded={options.length > 0 || undefined}
                  aria-controls={options.length
                    ? "composer-mentions"
                    : undefined}
                  placeholder={disabledReason ??
                    labels.placeholder ?? "Message…"}
                  className="placeholder:text-muted-foreground block max-h-60 min-h-12 w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-[15px] leading-6 outline-none disabled:cursor-not-allowed"
                  onChange={(event) => {
                    const element = event.target as unknown as {
                      value: string;
                      selectionStart: number | null;
                    };
                    onChange(element.value);
                    track(
                      element.value,
                      element.selectionStart ?? element.value.length,
                    );
                  }}
                  onPaste={(event) => {
                    const pasted = Array.from(
                      transfer(event.clipboardData)?.files ?? [],
                    );
                    if (pasted.length && allowAttachments) {
                      event.preventDefault();
                      add(pasted);
                    }
                  }}
                  onKeyDown={(event) => {
                    if (options.length) {
                      if (
                        event.key === "ArrowDown" || event.key === "ArrowUp"
                      ) {
                        event.preventDefault();
                        const step = event.key === "ArrowDown" ? 1 : -1;
                        setHighlight((index) =>
                          (index + step + options.length) % options.length
                        );
                        return;
                      }
                      if (event.key === "Enter" || event.key === "Tab") {
                        event.preventDefault();
                        choose(options[highlight] ?? options[0]);
                        return;
                      }
                      if (event.key === "Escape") {
                        event.preventDefault();
                        setMention(null);
                        return;
                      }
                    }
                    if (
                      event.key === "Enter" && !event.shiftKey &&
                      !domEvent(event.nativeEvent).isComposing && !coarse()
                    ) {
                      event.preventDefault();
                      submit();
                    }
                  }}
                />
                {options.length > 0 && (
                  <ul
                    id="composer-mentions"
                    role="listbox"
                    aria-label="Mention an agent"
                    className="bg-popover absolute bottom-full left-2 z-30 mb-2 w-72 overflow-hidden rounded-lg border p-1 shadow-float"
                  >
                    {options.map((target, index) => (
                      <li
                        key={target.id}
                        role="option"
                        aria-selected={index === highlight}
                        onMouseDown={(event) => {
                          event.preventDefault();
                          choose(target);
                        }}
                        className={cn(
                          "flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5",
                          index === highlight && "bg-accent",
                        )}
                      >
                        <SenderAvatar sender={target.sender} size="sm" />
                        <span className="grid min-w-0">
                          <span className="truncate text-sm font-medium">
                            {target.name}
                          </span>
                          {target.description && (
                            <span className="text-muted-foreground truncate text-xs">
                              {target.description}
                            </span>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="flex items-center gap-1 px-2 pb-2">
                {allowAttachments && (
                  <>
                    <input
                      ref={picker}
                      type="file"
                      multiple
                      hidden
                      accept={accept}
                      onChange={(event) => {
                        const input = event.target as unknown as {
                          files: ArrayLike<File> | null;
                          value: string;
                        };
                        add(Array.from(input.files ?? []));
                        input.value = "";
                      }}
                    />
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label="Attach files"
                          disabled={disabled || files.length >= maxAttachments}
                          onClick={() => dom(picker.current).click()}
                        >
                          <Paperclip />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Attach files</TooltipContent>
                    </Tooltip>
                  </>
                )}
                {targets.length > 0 && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Mention an agent"
                        disabled={disabled}
                        onClick={() => {
                          if (!field.current) return;
                          const element = dom(field.current);
                          const caret = element.selectionStart ?? value.length;
                          const before = value.slice(0, caret);
                          const prefix = before && !/\s$/.test(before)
                            ? " "
                            : "";
                          const next = `${before}${prefix}@${
                            value.slice(caret)
                          }`;
                          onChange(next);
                          const position = caret + prefix.length + 1;
                          setMention({ start: position - 1, query: "" });
                          nextFrame(() => {
                            element.focus();
                            element.setSelectionRange?.(position, position);
                          });
                        }}
                      >
                        <AtSign />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Mention an agent</TooltipContent>
                  </Tooltip>
                )}
                <div className="flex-1" />
                {voice && !value.trim() && !generating && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Record a voice message"
                        disabled={disabled}
                        onClick={() => setRecording(true)}
                      >
                        <Mic />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Voice message</TooltipContent>
                  </Tooltip>
                )}
                {generating && onStop && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="secondary"
                        size="icon-sm"
                        className="rounded-full"
                        aria-label={stopping ? "Stopping" : "Stop the response"}
                        disabled={stopping}
                        onClick={onStop}
                      >
                        {stopping
                          ? <Spinner />
                          : <Square className="size-3.5 fill-current" />}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      {stopping ? "Stopping…" : "Stop"}
                    </TooltipContent>
                  </Tooltip>
                )}
                {(!generating || canSend) && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="submit"
                        size="icon-sm"
                        className="rounded-full"
                        aria-label="Send message"
                        disabled={!canSend}
                      >
                        <ArrowUp />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Send</TooltipContent>
                  </Tooltip>
                )}
              </div>
            </>
          )}
      </form>
      {notice && (
        <p role="alert" className="text-destructive mt-1.5 px-2 text-xs">
          {notice}
        </p>
      )}
      <p className="text-muted-foreground mt-1.5 hidden px-2 text-center text-[11px] sm:block [@media(pointer:coarse)]:hidden">
        {[
          labels.help ?? "Enter to send · Shift+Enter for a new line",
          labels.footer,
        ].filter(Boolean).join(" · ")}
      </p>
    </div>
  );
}
