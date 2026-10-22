/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
/** The agent's work timeline: thinking, tool calls and failures, each expandable. @module */
// deno-lint-ignore verbatim-module-syntax -- classic JSX requires this runtime import.
import * as React from "react";
import { memo, useEffect, useId, useState } from "react";
import {
  Brain,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  LoaderCircle,
  Lock,
  Wrench,
} from "lucide-react";
import { cn } from "@copilotz/copilotz/web/kit";
import type { ChatActivity } from "../../shared/chat-messages.ts";
import { ToolPayload } from "./tool-output.tsx";

/** Labels with `{{tool}}` placeholders; see `resources.shell.labels`. */
export interface ActivityLabels {
  thinkingActive?: string;
  thinkingComplete?: string;
  toolActive?: string;
  toolComplete?: string;
  toolFailed?: string;
  failed?: string;
  steps?: string;
}

/** A rendered tool View for one activity id, and whether it replaces the row. */
export type ToolPresentation = Readonly<{
  node: React.ReactNode;
  inline: boolean;
}>;

const fill = (template: string, tool: string) =>
  template.replaceAll("{{tool}}", tool);

/** "shared_document" → "shared document"; ids stay recognizable. */
export function toolLabel(toolId: string | undefined): string {
  return (toolId ?? "tool").replace(/[_-]+/g, " ").replace(
    /([a-z])([A-Z])/g,
    "$1 $2",
  ).trim().toLowerCase();
}

function label(item: ChatActivity, labels: ActivityLabels): string {
  const tool = toolLabel(item.toolId);
  if (item.kind === "failure") {
    return item.error ?? labels.failed ?? "The response could not be completed";
  }
  if (item.kind === "thinking") {
    return item.status === "active"
      ? labels.thinkingActive ?? "Thinking"
      : labels.thinkingComplete ?? "Thought through request";
  }
  if (item.status === "failed") {
    return fill(labels.toolFailed ?? "{{tool}} failed", tool);
  }
  if (item.status === "complete") {
    return fill(labels.toolComplete ?? "Used {{tool}}", tool);
  }
  return fill(labels.toolActive ?? "Using {{tool}}", tool);
}

function StepIcon({ item }: { item: ChatActivity }): React.ReactElement {
  const className = "size-4 shrink-0";
  if (item.status === "active") {
    return (
      <LoaderCircle
        aria-hidden="true"
        className={cn(className, "text-foreground animate-spin")}
      />
    );
  }
  if (item.status === "failed") {
    return (
      <CircleAlert
        aria-hidden="true"
        className={cn(className, "text-destructive")}
      />
    );
  }
  if (item.kind === "thinking") {
    return (
      <Brain
        aria-hidden="true"
        className={cn(className, "text-muted-foreground")}
      />
    );
  }
  return item.kind === "tool"
    ? (
      <CircleCheck
        aria-hidden="true"
        className={cn(className, "text-muted-foreground")}
      />
    )
    : <Wrench aria-hidden="true" className={className} />;
}

/** Text results show in full up to this many characters. */
const RESULT_PREVIEW = 20_000;

const resultNotes: Record<NonNullable<ChatActivity["resultStatus"]>, string> = {
  loading: "Loading the result…",
  "too-large": "The result is too large to show here.",
  unavailable: "The result couldn't be loaded.",
  restricted: "Output visible to the agent only.",
};

/** Reads a referenced JSON result once its renderer or step is on screen. */
function LoadResult(
  { item, onLoadResult }: {
    item: ChatActivity;
    onLoadResult?(item: ChatActivity): void;
  },
): null {
  const pending = Boolean(item.resultRef) && item.data === undefined &&
    !item.resultStatus;
  useEffect(() => {
    if (pending) onLoadResult?.(item);
  }, [pending, item.id]);
  return null;
}

function Details(
  { item, tool, onLoadResult }: {
    item: ChatActivity;
    tool?: ToolPresentation;
    onLoadResult?(item: ChatActivity): void;
  },
): React.ReactElement | null {
  if (tool) {
    return (
      <div className="pt-1.5 pb-1">
        <LoadResult item={item} onLoadResult={onLoadResult} />
        {tool.node}
      </div>
    );
  }
  const reasoning = item.reasoning
    ? (
      <p className="text-muted-foreground leading-relaxed whitespace-pre-wrap">
        {item.reasoning}
      </p>
    )
    : null;
  const parts: React.ReactNode[] = [];
  if (item.input && Object.keys(item.input).length) {
    parts.push(
      <ToolPayload
        key="input"
        label="Input"
        value={item.input}
        describe={false}
      />,
    );
  } else if (item.rawInput) {
    // Arguments still being written: text until they parse.
    parts.push(
      <ToolPayload
        key="input"
        label="Input"
        text={item.rawInput}
        describe={false}
      />,
    );
  }
  // A failed call's text is its error, shown once as the error.
  const resultText = item.status === "failed" && item.result === item.error
    ? undefined
    : item.result;
  if (item.data !== undefined) {
    parts.push(<ToolPayload key="result" label="Result" value={item.data} />);
  } else if (resultText !== undefined) {
    parts.push(
      <ToolPayload
        key="result"
        label="Result"
        text={resultText.length > RESULT_PREVIEW
          ? `${resultText.slice(0, RESULT_PREVIEW)}\n…`
          : resultText}
      />,
    );
  } else if (item.resultRef || item.resultStatus === "restricted") {
    const status = item.resultStatus ?? "loading";
    parts.push(
      <ToolPayload key="result" label="Result">
        <p
          role="status"
          className="text-muted-foreground flex items-center gap-2 text-xs"
        >
          {status === "loading" && (
            <LoaderCircle aria-hidden="true" className="size-3 animate-spin" />
          )}
          {status === "restricted" && (
            <Lock aria-hidden="true" className="size-3 shrink-0" />
          )}
          {resultNotes[status]}
          {status === "unavailable" && onLoadResult && (
            <button
              type="button"
              className="hover:text-foreground focus-visible:ring-ring/45 rounded underline underline-offset-4 outline-none focus-visible:ring-[3px]"
              onClick={() => onLoadResult(item)}
            >
              Try again
            </button>
          )}
        </p>
      </ToolPayload>,
    );
  }
  if (item.error && item.kind !== "failure") {
    parts.push(
      <ToolPayload key="error" label="Error" text={item.error} tone="error" />,
    );
  }
  const load = <LoadResult item={item} onLoadResult={onLoadResult} />;
  if (!parts.length) {
    return reasoning
      ? (
        <div className="pt-1 pb-1.5 text-sm">
          {load}
          {reasoning}
        </div>
      )
      : load;
  }
  return (
    <div className="grid gap-2 pt-1.5 pb-1 text-sm">
      {load}
      {reasoning}
      <div
        data-slot="tool-details"
        className={cn(
          "bg-muted/35 divide-border grid min-w-0 divide-y overflow-hidden rounded-lg border",
          item.status === "failed" && "border-destructive/30",
        )}
      >
        {parts}
      </div>
    </div>
  );
}

function hasDetails(item: ChatActivity, tool?: ToolPresentation): boolean {
  return Boolean(
    tool || item.reasoning || item.rawInput || item.result ||
      item.data !== undefined || item.resultRef ||
      item.resultStatus === "restricted" ||
      (item.input && Object.keys(item.input).length) ||
      (item.error && item.kind !== "failure"),
  );
}

function Step(
  { item, tool, last, labels, onLoadResult }: {
    item: ChatActivity;
    tool?: ToolPresentation;
    last: boolean;
    labels: ActivityLabels;
    onLoadResult?(item: ChatActivity): void;
  },
): React.ReactElement {
  // A running tool with its own renderer starts open, so its live output shows.
  const [open, setOpen] = useState(
    Boolean(tool) && item.kind === "tool" && item.status === "active",
  );
  const id = useId();
  const expandable = hasDetails(item, tool);
  const text = label(item, labels);
  return (
    <li className="relative grid grid-cols-[1rem_minmax(0,1fr)] gap-x-2.5">
      {!last && (
        <span
          aria-hidden="true"
          className="bg-border absolute top-6 bottom-0 left-[7.5px] w-px"
        />
      )}
      <span className="relative z-10 flex h-6 items-center">
        <StepIcon item={item} />
      </span>
      <div className="min-w-0">
        {expandable
          ? (
            <button
              type="button"
              aria-expanded={open}
              aria-controls={id}
              onClick={() => setOpen((value) => !value)}
              className={cn(
                "focus-visible:ring-ring/45 group/step -mx-1 inline-flex h-6 max-w-full items-center gap-1 rounded-md px-1 text-left text-sm outline-none focus-visible:ring-[3px]",
                item.status === "active"
                  ? "text-foreground"
                  : item.status === "failed"
                  ? "text-destructive"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <span
                className={cn(
                  "truncate",
                  item.status === "active" && "shimmer-text",
                )}
              >
                {text}
              </span>
              <ChevronRight
                aria-hidden="true"
                className={cn(
                  "size-3.5 shrink-0 transition-transform",
                  open && "rotate-90",
                )}
              />
            </button>
          )
          : (
            <p
              className={cn(
                "flex h-6 items-center truncate text-sm",
                item.status === "active"
                  ? "shimmer-text"
                  : item.status === "failed"
                  ? "text-destructive"
                  : "text-muted-foreground",
              )}
            >
              {text}
            </p>
          )}
        {expandable && open && (
          <div id={id}>
            <Details item={item} tool={tool} onLoadResult={onLoadResult} />
          </div>
        )}
      </div>
    </li>
  );
}

/**
 * The work behind a reply. Inline tool renderers (such as `ask`) replace
 * their row; a long settled timeline folds into one summary row.
 */
export const AssistantActivity: React.NamedExoticComponent<{
  items: readonly ChatActivity[];
  tools?: ReadonlyMap<string, ToolPresentation>;
  labels?: ActivityLabels;
  /** Read a referenced JSON result when its step opens. */
  onLoadResult?(item: ChatActivity): void;
}> = memo(function AssistantActivity(
  { items, tools, labels = {}, onLoadResult }: {
    items: readonly ChatActivity[];
    tools?: ReadonlyMap<string, ToolPresentation>;
    labels?: ActivityLabels;
    onLoadResult?(item: ChatActivity): void;
  },
): React.ReactElement | null {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  if (!items.length) return null;
  const settled = items.every((item) => item.status !== "active");
  const steps = items.filter((item) => !tools?.get(item.id)?.inline);
  const inline = items.filter((item) => tools?.get(item.id)?.inline);
  const folded = settled && steps.length > 3 && !expanded;
  const failed = steps.some((item) => item.status === "failed");
  return (
    <div data-slot="assistant-activity" className="grid gap-2">
      {inline.map((item) => (
        <div key={item.id} data-tool={item.toolId}>
          <LoadResult item={item} onLoadResult={onLoadResult} />
          {tools!.get(item.id)!.node}
        </div>
      ))}
      {steps.length > 0 && (folded
        ? (
          <button
            type="button"
            aria-expanded={false}
            aria-controls={id}
            onClick={() => setExpanded(true)}
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/45 -mx-1 inline-flex h-6 w-fit items-center gap-1.5 rounded-md px-1 text-sm outline-none focus-visible:ring-[3px]"
          >
            {failed
              ? (
                <CircleAlert
                  aria-hidden="true"
                  className="text-destructive size-4"
                />
              )
              : <CircleCheck aria-hidden="true" className="size-4" />}
            {(labels.steps ?? "Worked through {{count}} steps").replace(
              "{{count}}",
              String(steps.length),
            )}
            <ChevronRight aria-hidden="true" className="size-3.5" />
          </button>
        )
        : (
          <ol id={id} className="grid gap-0.5">
            {steps.map((item, index) => (
              <Step
                key={item.id}
                item={item}
                tool={tools?.get(item.id)}
                last={index === steps.length - 1}
                labels={labels}
                onLoadResult={onLoadResult}
              />
            ))}
          </ol>
        ))}
    </div>
  );
});
