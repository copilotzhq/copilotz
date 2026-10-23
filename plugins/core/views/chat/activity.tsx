/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
/**
 * The work behind a reply, calm by default. Background tools fold into one
 * quiet row ("Used 3 tools · 4s") that opens to plain-language steps, each
 * with its input and result one click away for whoever may read them. Live
 * tools (a terminal, a draft) draw in the message while they run and settle
 * into a compact card; inline ones (a question to another agent) are the
 * message.
 * @module
 */
import * as React from "react";
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Brain,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  LoaderCircle,
  Lock,
  TriangleAlert,
} from "lucide-react";
import { cn, Icon } from "@copilotz/copilotz/web/kit";
import type {
  ChatActivity,
  ChatActivityStatus,
} from "../../shared/chat-messages.ts";
import { ToolPayload } from "./tool-output.tsx";
import {
  type ToolDisplayMode,
  ToolDisplayProvider,
  useAdapts,
} from "./tool-display.tsx";

/**
 * Labels with `{{tool}}` and `{{count}}` placeholders; see
 * `resources.shell.labels`.
 */
export interface ActivityLabels {
  thinkingActive?: string;
  thinkingComplete?: string;
  toolActive?: string;
  toolComplete?: string;
  toolFailed?: string;
  failed?: string;
  /** The settled row for several tools: "Used {{count}} tools". */
  steps?: string;
  /** The row while the agent works: "Working…". */
  working?: string;
}

/** A tool call's presentation, from its app renderer (see `presentTools`). */
export type ToolPresentation = Readonly<{
  /** The renderer View, drawn inline, live, or in the step's details. */
  node?: React.ReactNode;
  /** The step's line in plain words, from the renderer's summary View. */
  summary?: React.ReactNode;
  /** The call is the message: it replaces its step (such as `ask`). */
  inline: boolean;
  /** Drawn live in the message, for this audience. */
  live?: "everyone" | "technical";
  /** A kit icon name for the settled live card (its summary says how it went). */
  icon?: string;
  /** The calls that read as this one step (a batched run), by id. */
  group?: readonly string[];
  /** The summary reads the result: it loads once the steps open. */
  summaryResult?: boolean;
}>;

const fill = (template: string, values: Record<string, string>) =>
  template.replace(/\{\{(\w+)\}\}/g, (match, key) => values[key] ?? match);

/** "shared_document" → "shared document"; ids stay recognizable. */
export function toolLabel(toolId: string | undefined): string {
  return (toolId ?? "tool").replace(/[_-]+/g, " ").replace(
    /([a-z])([A-Z])/g,
    "$1 $2",
  ).trim().toLowerCase();
}

/** A duration as people say it: "4s", "1m 12s"; nothing under a second. */
export function formatElapsed(ms: number | undefined): string | undefined {
  if (ms === undefined || !Number.isFinite(ms) || ms < 1000) return undefined;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return seconds % 60 ? `${minutes}m ${seconds % 60}s` : `${minutes}m`;
  }
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** From the first call to the last result, when both are known. */
function elapsed(items: readonly ChatActivity[]): number | undefined {
  const times = (field: "startedAt" | "endedAt") =>
    items.map((item) => Date.parse(item[field] ?? "")).filter(Number.isFinite);
  const starts = times("startedAt");
  const ends = times("endedAt");
  if (!starts.length || ends.length < items.length) return undefined;
  return Math.max(...ends) - Math.min(...starts);
}

/** What the viewer may not open: a status-only output. */
function restricted(item: ChatActivity): boolean {
  return item.withheld === true || item.resultStatus === "restricted";
}

function restrictedNote(item: ChatActivity): string {
  return item.readableBy
    ? `Only ${item.readableBy} can see these details`
    : "Output visible to the agent only";
}

/** A run of calls as one status: active while any runs, failed if any did. */
function runStatus(items: readonly ChatActivity[]): ChatActivityStatus {
  if (items.some((item) => item.status === "active")) return "active";
  return items.some((item) => item.status === "failed") ? "failed" : "complete";
}

/** Disclosure choices by call id, newest kept. */
type Remembered = Map<string, unknown>;
const REMEMBERED = 500;
const RememberedContext = createContext<Remembered | undefined>(undefined);

/**
 * Keeps which steps and live views the reader opened for as long as the
 * conversation is on screen: a reply's group re-keys when its agent writes
 * again, and the virtualized log unmounts rows offscreen, yet what was open
 * stays open. Without it, each component keeps its own.
 */
export function ActivityMemory(
  { children }: { children?: React.ReactNode },
): React.ReactElement {
  const memory = useRef<Remembered>(new Map());
  return (
    <RememberedContext.Provider value={memory.current}>
      {children}
    </RememberedContext.Provider>
  );
}

function useRemembered<T>(
  key: string,
  initial: T,
): [T, (next: T | ((previous: T) => T)) => void] {
  const memory = useContext(RememberedContext);
  const [value, setValue] = useState<T>(() =>
    memory?.has(key) ? memory.get(key) as T : initial
  );
  const set = useCallback((next: T | ((previous: T) => T)) => {
    setValue((previous) => {
      const value = typeof next === "function"
        ? (next as (previous: T) => T)(previous)
        : next;
      if (memory) {
        memory.delete(key);
        memory.set(key, value);
        if (memory.size > REMEMBERED) {
          memory.delete(memory.keys().next().value!);
        }
      }
      return value;
    });
  }, [key, memory]);
  return [value, set];
}

/** One line of the reply's work: its thinking, or a tool call (or a run). */
type Step = Readonly<{
  key: string;
  kind: "thinking" | "tool";
  items: readonly ChatActivity[];
  status: ChatActivityStatus;
  tool?: ToolPresentation;
}>;

function backgroundSteps(
  items: readonly ChatActivity[],
  tools: ReadonlyMap<string, ToolPresentation> | undefined,
): Step[] {
  const steps: Step[] = [];
  const taken = new Set<string>();
  for (const item of items) {
    if (item.kind === "failure" || taken.has(item.id)) continue;
    const tool = tools?.get(item.id);
    if (tool?.inline || tool?.live) continue;
    const run = tool?.group
      ? items.filter((other) => tool.group!.includes(other.id))
      : [item];
    for (const call of run) taken.add(call.id);
    steps.push({
      key: item.id,
      kind: item.kind === "thinking" ? "thinking" : "tool",
      items: run,
      status: runStatus(run),
      ...(tool ? { tool } : {}),
    });
  }
  return steps;
}

/** The generic line when a tool has no summary: "Used web search". */
function genericLine(step: Step, labels: ActivityLabels): string {
  const item = step.items[0];
  if (step.kind === "thinking") {
    return step.status === "active"
      ? labels.thinkingActive ?? "Thinking"
      : labels.thinkingComplete ?? "Thought through the request";
  }
  const tool = toolLabel(item.toolId);
  const times = step.items.length > 1 ? ` · ${step.items.length} times` : "";
  if (step.status === "active") {
    return `${fill(labels.toolActive ?? "Using {{tool}}", { tool })}…`;
  }
  if (step.status === "failed") {
    const stopped = step.items.every((call) =>
      call.status !== "failed" || call.error === "Cancelled."
    );
    return stopped
      ? `${fill(labels.toolComplete ?? "Used {{tool}}", { tool })} · stopped`
      : fill(labels.toolFailed ?? "Used {{tool}} · failed", { tool });
  }
  return fill(labels.toolComplete ?? "Used {{tool}}", { tool }) + times;
}

/** A summary View that fails to draw gives way to the generic line. */
class SummaryBoundary extends React.Component<
  { fallback: React.ReactNode; children?: React.ReactNode },
  { failed: boolean }
> {
  override state: { failed: boolean } = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  override render(): React.ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** A step's line: the renderer's summary, or the generic one. */
function StepLine(
  { step, labels }: { step: Step; labels: ActivityLabels },
): React.ReactElement {
  const fallback = genericLine(step, labels);
  return step.tool?.summary !== undefined
    ? (
      <SummaryBoundary fallback={fallback}>
        <span
          data-slot="tool-summary"
          className="[&_code]:bg-muted [&_code]:text-foreground/90 [&_code]:rounded [&_code]:px-1 [&_code]:py-px [&_code]:font-mono [&_code]:text-[0.86em]"
        >
          {step.tool.summary}
        </span>
      </SummaryBoundary>
    )
    : <>{fallback}</>;
}

function StatusIcon(
  { status, kind = "tool", className }: {
    status: ChatActivityStatus;
    kind?: ChatActivity["kind"];
    className?: string;
  },
): React.ReactElement {
  const base = cn("size-4 shrink-0", className);
  if (status === "active") {
    return (
      <LoaderCircle
        aria-hidden="true"
        className={cn(base, "text-muted-foreground animate-spin")}
      />
    );
  }
  if (status === "failed") {
    return kind === "failure"
      ? (
        <CircleAlert
          aria-hidden="true"
          className={cn(base, "text-destructive")}
        />
      )
      : (
        <TriangleAlert
          aria-hidden="true"
          className={cn(base, "text-warning")}
        />
      );
  }
  return kind === "thinking"
    ? <Brain aria-hidden="true" className={cn(base, "text-muted-foreground")} />
    : (
      <CircleCheck
        aria-hidden="true"
        className={cn(base, "text-muted-foreground/80")}
      />
    );
}

/** Reads a referenced result once its step, details or live view shows. */
function LoadResult(
  { item, onLoadResult }: {
    item: ChatActivity;
    onLoadResult?(item: ChatActivity): void;
  },
): null {
  const pending = Boolean(item.resultRef) && item.data === undefined &&
    item.result === undefined && !item.resultStatus;
  useEffect(() => {
    if (pending) onLoadResult?.(item);
  }, [pending, item.id]);
  return null;
}

/** Text results show in full up to this many characters. */
const RESULT_PREVIEW = 20_000;

const resultNotes: Record<NonNullable<ChatActivity["resultStatus"]>, string> = {
  loading: "Loading the result…",
  "too-large": "The result is too large to show here.",
  unavailable: "The result couldn't be loaded.",
  restricted: "Output visible to the agent only.",
};

function hasPayload(item: ChatActivity): boolean {
  return Boolean(
    item.rawInput || item.result || item.data !== undefined ||
      item.resultRef || item.resultStatus ||
      (item.input && Object.keys(item.input).length) || item.error,
  );
}

/** A call's input and result as the tree, read when it opens. */
function ToolDetails(
  { item, onLoadResult }: {
    item: ChatActivity;
    onLoadResult?(item: ChatActivity): void;
  },
): React.ReactElement {
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
  } else if (item.resultRef || item.resultStatus) {
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
          {status === "restricted" && item.readableBy
            ? `Only ${item.readableBy} can see the result.`
            : resultNotes[status]}
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
  return (
    <div
      data-slot="tool-details"
      className={cn(
        "bg-muted/35 divide-border grid min-w-0 divide-y overflow-hidden rounded-lg border text-sm",
        item.status === "failed" && "border-warning/40",
      )}
    >
      <LoadResult item={item} onLoadResult={onLoadResult} />
      {parts.length
        ? parts
        : (
          <p className="text-muted-foreground px-3 py-2 text-xs italic">
            Nothing to show for this call.
          </p>
        )}
    </div>
  );
}

/** A quiet text button: "View details", "Watch". */
function QuietButton(
  { className, ...props }: React.ComponentProps<"button">,
): React.ReactElement {
  return (
    <button
      type="button"
      className={cn(
        "text-muted-foreground hover:text-foreground focus-visible:ring-ring/45 inline-flex shrink-0 items-center gap-1 rounded-md text-xs font-medium whitespace-nowrap outline-none focus-visible:ring-[3px]",
        className,
      )}
      {...props}
    />
  );
}

function StepItem(
  {
    step,
    last = true,
    labels,
    tools,
    onLoadResult,
    standalone = false,
    lead,
    duration,
    reasoning,
  }: {
    step: Step;
    last?: boolean;
    labels: ActivityLabels;
    tools?: ReadonlyMap<string, ToolPresentation>;
    onLoadResult?(item: ChatActivity): void;
    /**
     * The reply's only step, as its quiet row: no timeline, muted, with
     * what came before it (`lead`, such as "Working…") and how long it took.
     */
    standalone?: boolean;
    lead?: React.ReactNode;
    duration?: string;
    /** The reply's thinking, shown first in this step's details. */
    reasoning?: string;
  },
): React.ReactElement {
  const [open, setOpen] = useRemembered(`${step.key}:details`, false);
  const id = useId();
  const first = step.items[0];
  const thinking = step.kind === "thinking";
  const hidden = !thinking && step.items.some(restricted) && !open;
  const thought = thinking ? first.reasoning : reasoning;
  const openable = thinking ? Boolean(first.reasoning) : Boolean(reasoning) ||
    step.items.some((item) => hasPayload(item) || tools?.get(item.id)?.node);
  const Item = standalone ? "div" : "li";
  return (
    <Item
      data-slot="activity-step"
      data-status={step.status}
      className="relative grid grid-cols-[1rem_minmax(0,1fr)] gap-x-2.5"
    >
      {!last && (
        <span
          aria-hidden="true"
          className="bg-border absolute top-[1.375rem] -bottom-1 left-[7.5px] w-px"
        />
      )}
      <span className="relative z-10 flex h-7 items-center">
        <StatusIcon status={step.status} kind={first.kind} />
      </span>
      <div className="min-w-0">
        <div className="flex min-h-7 flex-wrap items-center gap-x-3 gap-y-0.5 py-1">
          <span
            className={cn(
              "flex min-w-0 items-baseline gap-1.5 text-sm leading-5",
              standalone
                ? "text-muted-foreground"
                : step.status === "active"
                ? "text-foreground"
                : "text-foreground/80",
            )}
          >
            {lead}
            <span
              className={cn(
                "min-w-0 [overflow-wrap:anywhere]",
                standalone && !lead && step.status === "active" &&
                  "shimmer-text",
              )}
            >
              <StepLine step={step} labels={labels} />
              {duration && (
                <span className="text-muted-foreground/70 text-xs tabular-nums whitespace-nowrap">
                  {` · ${duration}`}
                </span>
              )}
            </span>
          </span>
          {hidden
            ? (
              <span className="text-muted-foreground/90 inline-flex shrink-0 items-center gap-1 text-xs sm:ml-auto">
                <Lock aria-hidden="true" className="size-3" />
                {restrictedNote(step.items.find(restricted) ?? first)}
              </span>
            )
            : openable && (
              <QuietButton
                aria-expanded={open}
                aria-controls={id}
                className="sm:ml-auto"
                onClick={() => setOpen((value) => !value)}
              >
                {thinking
                  ? open ? "Hide thinking" : "View thinking"
                  : open
                  ? "Hide details"
                  : "View details"}
                <ChevronDown
                  aria-hidden="true"
                  className={cn(
                    "size-3 transition-transform",
                    open && "rotate-180",
                  )}
                />
              </QuietButton>
            )}
        </div>
        {step.tool?.summaryResult && !step.items.some(restricted) &&
          step.items.map((item) => (
            <LoadResult
              key={item.id}
              item={item}
              onLoadResult={onLoadResult}
            />
          ))}
        {open && (
          <div id={id} className="grid gap-2 pt-0.5 pb-2.5">
            {thought && (
              <p className="text-muted-foreground border-border border-l-2 pl-3 text-sm leading-relaxed whitespace-pre-wrap">
                {thought}
              </p>
            )}
            {!thinking && step.items.map((item, index) => {
              const node = tools?.get(item.id)?.node;
              return (
                <div key={item.id} className="grid min-w-0 gap-1">
                  {step.items.length > 1 && (
                    <p className="text-muted-foreground text-xs">
                      Call {index + 1} of {step.items.length}
                    </p>
                  )}
                  {node
                    ? (
                      <>
                        <LoadResult item={item} onLoadResult={onLoadResult} />
                        {node}
                      </>
                    )
                    : <ToolDetails item={item} onLoadResult={onLoadResult} />}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Item>
  );
}

/**
 * The reply's background work as one quiet row: "Working… Searching memory"
 * while it runs, "Used 3 tools · 4s" once done, opening to its steps.
 */
function ActivityRow(
  { steps, labels, technical, tools, onLoadResult }: {
    steps: readonly Step[];
    labels: ActivityLabels;
    technical: boolean;
    tools?: ReadonlyMap<string, ToolPresentation>;
    onLoadResult?(item: ChatActivity): void;
  },
): React.ReactElement {
  const [open, setOpen] = useRemembered(`${steps[0].key}:steps`, technical);
  const preference = useRef(technical);
  useEffect(() => {
    // Follow the preference when it changes, not on every render.
    if (preference.current !== technical) setOpen(technical);
    preference.current = technical;
  }, [technical]);
  const id = useId();
  const working = steps.some((step) => step.status === "active");
  const toolSteps = steps.filter((step) => step.kind === "tool");
  const calls = toolSteps.flatMap((step) => step.items);
  const failed = calls.filter((item) => item.status === "failed").length;
  const duration = working ? undefined : formatElapsed(elapsed(calls));
  // One step (or only the thinking): the row is that step, its details one
  // click away, the thinking first among them.
  if (toolSteps.length <= 1) {
    const step = toolSteps[0] ?? steps[0];
    const thinking = steps.find((other) => other.kind === "thinking");
    return (
      <div data-slot="activity" data-state={working ? "working" : "done"}>
        <StepItem
          standalone
          step={step}
          labels={labels}
          tools={tools}
          onLoadResult={onLoadResult}
          {...(duration ? { duration } : {})}
          {...(working && step.kind === "tool"
            ? {
              lead: (
                <span className="shimmer-text shrink-0">
                  {labels.working ?? "Working…"}
                </span>
              ),
            }
            : {})}
          {...(step.kind === "tool" && thinking?.items[0].reasoning
            ? { reasoning: thinking.items[0].reasoning }
            : {})}
        />
      </div>
    );
  }
  let icon: React.ReactNode;
  let text: React.ReactNode;
  if (working) {
    const current = [...toolSteps].reverse().find((step) =>
      step.status === "active"
    ) ?? toolSteps.at(-1)!;
    icon = <StatusIcon status="active" />;
    text = (
      <>
        <span className="shimmer-text shrink-0">
          {labels.working ?? "Working…"}
        </span>
        <span className="truncate">
          <StepLine step={current} labels={labels} />
        </span>
      </>
    );
  } else {
    icon = <StatusIcon status={failed ? "failed" : "complete"} />;
    text = (
      <span className="truncate">
        {fill(labels.steps ?? "Used {{count}} tools", {
          count: String(calls.length),
        })}
        {failed > 0 && ` · ${failed} failed`}
      </span>
    );
  }
  const row = (
    <>
      {icon}
      <span className="flex min-w-0 items-center gap-1.5">{text}</span>
      {duration && (
        <span className="text-muted-foreground/70 shrink-0 text-xs tabular-nums">
          {/* The leading space collapses on screen and spaces the read name. */}
          {` · ${duration}`}
        </span>
      )}
    </>
  );
  return (
    <div data-slot="activity" data-state={working ? "working" : "done"}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/45 -mx-1.5 flex h-7 w-fit max-w-[calc(100%+0.75rem)] min-w-0 items-center gap-2 rounded-md px-1.5 text-sm transition-colors outline-none focus-visible:ring-[3px]"
      >
        {row}
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "size-3.5 shrink-0 transition-transform",
            open && "rotate-90",
          )}
        />
      </button>
      {open && (
        <ol id={id} className="mt-0.5 grid">
          {steps.map((step, index) => (
            <StepItem
              key={step.key}
              step={step}
              last={index === steps.length - 1}
              labels={labels}
              tools={tools}
              onLoadResult={onLoadResult}
            />
          ))}
        </ol>
      )}
    </div>
  );
}

/** Seconds since a time, ticking while a call runs. */
function Elapsed({ since }: { since: number }): React.ReactElement | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const text = formatElapsed(now - since);
  return text
    ? (
      <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
        {text}
      </span>
    )
    : null;
}

/** Past this height a renderer that draws all of its run is clipped. */
const CARD_HEIGHT = 256;

/**
 * A settled card's body. A renderer that reads its display draws its own
 * card; one that draws everything is clipped, with "Show all".
 */
function CardClip(
  { children, onExpand }: { children: React.ReactNode; onExpand(): void },
): React.ReactElement {
  const content = useRef<HTMLDivElement>(null);
  const { adapts, Provider } = useAdapts();
  const [over, setOver] = useState(false);
  useEffect(() => {
    const element = content.current as unknown as
      | { scrollHeight: number }
      | null;
    if (!element || adapts.current) return;
    const check = () => setOver(element.scrollHeight > CARD_HEIGHT + 2);
    check();
    const Observer = (globalThis as {
      ResizeObserver?: new (callback: () => void) => {
        observe(target: unknown): void;
        disconnect(): void;
      };
    }).ResizeObserver;
    if (!Observer) return;
    const observer = new Observer(check);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <div className="relative">
      <div
        className={over ? "overflow-hidden" : undefined}
        style={over ? { maxHeight: CARD_HEIGHT } : undefined}
      >
        <div ref={content}>
          <Provider value={adapts}>{children}</Provider>
        </div>
      </div>
      {over && (
        <div className="from-card absolute inset-x-0 bottom-0 flex h-14 items-end justify-center bg-gradient-to-t to-transparent pb-2">
          <QuietButton
            className="bg-background/95 text-foreground hover:bg-background rounded-full border px-2.5 py-1 shadow-xs"
            onClick={onExpand}
          >
            Show all
            <ChevronDown aria-hidden="true" className="size-3" />
          </QuietButton>
        </div>
      )}
    </div>
  );
}

/**
 * A live tool in the message: streaming while it runs, then a compact card
 * that expands to the full run. A technical one (a terminal) is a slim strip
 * until the reader watches it, or chose "Show technical details". A viewer
 * who may not read the output sees its status alone.
 */
function LiveTool(
  { item, tool, technical, agent, labels, onLoadResult }: {
    item: ChatActivity;
    tool: ToolPresentation;
    technical: boolean;
    agent: string;
    labels: ActivityLabels;
    onLoadResult?(item: ChatActivity): void;
  },
): React.ReactElement {
  const running = item.status === "active";
  const audience = tool.live ?? "everyone";
  const [open, setOpen] = useRemembered(
    `${item.id}:open`,
    audience === "everyone" || technical,
  );
  const preference = useRef(technical);
  useEffect(() => {
    if (audience === "technical" && preference.current !== technical) {
      setOpen(technical);
    }
    preference.current = technical;
  }, [technical]);
  const [full, setFull] = useRemembered(`${item.id}:full`, false);
  const [details, setDetails] = useRemembered(`${item.id}:raw`, false);
  // A run that finishes while watched settles into its card.
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running) setFull(false);
    wasRunning.current = running;
  }, [running]);
  const mode: ToolDisplayMode = running ? "live" : full ? "full" : "card";
  const display = useMemo(
    () => ({ mode, framed: true, expand: () => setFull(true) }),
    [mode],
  );
  const id = useId();
  const step: Step = {
    key: item.id,
    kind: "tool",
    items: [item],
    status: item.status,
    tool,
  };
  const since = Date.parse(item.startedAt ?? "");
  const duration = running ? undefined : formatElapsed(elapsed([item]));
  // Status alone: the output is someone else's to read.
  if (
    item.withheld || (item.resultStatus === "restricted" && !item.resultRef)
  ) {
    const name = toolLabel(item.toolId);
    return (
      <div
        data-slot="live-tool"
        data-tool={item.toolId}
        data-status-only=""
        className="text-muted-foreground flex min-h-9 flex-wrap items-center gap-x-2.5 gap-y-1 rounded-lg border border-dashed px-3 py-1.5 text-sm"
      >
        {item.status === "complete" && tool.icon
          ? (
            <Icon
              name={tool.icon}
              className="size-4 shrink-0"
              fallback={<StatusIcon status={item.status} />}
            />
          )
          : <StatusIcon status={item.status} />}
        <span className={cn("min-w-0", running && "shimmer-text")}>
          {running
            ? `${agent} is using the ${name}…`
            : `${agent} used the ${name} · ${
              item.status !== "failed"
                ? "Done"
                : item.error === "Cancelled."
                ? "Cancelled"
                : "Failed"
            }`}
        </span>
        <span className="text-muted-foreground/90 inline-flex items-center gap-1 text-xs sm:ml-auto">
          <Lock aria-hidden="true" className="size-3" />
          {restrictedNote(item)}
        </span>
      </div>
    );
  }
  return (
    <section
      data-slot="live-tool"
      data-tool={item.toolId}
      data-audience={audience}
      data-mode={open ? mode : "closed"}
      aria-label={toolLabel(item.toolId)}
      className={cn(
        "bg-card min-w-0 overflow-hidden border transition-shadow",
        open ? "rounded-xl shadow-xs" : "rounded-lg",
      )}
    >
      {tool.summaryResult && !open && (
        <LoadResult item={item} onLoadResult={onLoadResult} />
      )}
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "group/live hover:bg-muted/40 focus-visible:ring-ring/45 flex w-full min-w-0 items-center gap-2.5 px-3 text-left text-sm transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-inset",
          open ? "min-h-10 py-2" : "min-h-9 py-1.5",
        )}
      >
        {item.status === "complete" && tool.icon
          ? (
            <Icon
              name={tool.icon}
              className="text-muted-foreground size-4 shrink-0"
              fallback={<StatusIcon status={item.status} />}
            />
          )
          : <StatusIcon status={item.status} />}
        <span
          className={cn(
            "min-w-0 flex-1 truncate",
            running ? "text-foreground" : "text-foreground/85",
          )}
        >
          <StepLine step={step} labels={labels} />
        </span>
        {running && Number.isFinite(since) && <Elapsed since={since} />}
        {duration && (
          <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
            {duration}
          </span>
        )}
        <span className="text-muted-foreground group-hover/live:text-foreground inline-flex shrink-0 items-center gap-1 text-xs font-medium">
          {open ? "Hide" : running ? "Watch" : "Show"}
          <ChevronDown
            aria-hidden="true"
            className={cn(
              "size-3.5 transition-transform",
              open && "rotate-180",
            )}
          />
        </span>
      </button>
      {open && (
        <div id={id} data-slot="live-tool-body" className="border-t">
          <LoadResult item={item} onLoadResult={onLoadResult} />
          <ToolDisplayProvider value={display}>
            {mode === "card"
              ? <CardClip onExpand={() => setFull(true)}>{tool.node}</CardClip>
              : tool.node}
          </ToolDisplayProvider>
          {!running && (full || technical) && (
            <div className="flex items-center justify-end gap-4 border-t px-3 py-1.5">
              {full && (
                <QuietButton onClick={() => setFull(false)}>
                  Show less
                </QuietButton>
              )}
              {technical && (
                <QuietButton
                  aria-expanded={details}
                  onClick={() => setDetails((value) => !value)}
                >
                  {details ? "Hide details" : "View details"}
                </QuietButton>
              )}
            </div>
          )}
          {details && !running && (
            <div className="border-t p-2.5">
              <ToolDetails item={item} onLoadResult={onLoadResult} />
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * The work behind a reply: one quiet row for background tools (and the
 * thinking), the live and inline tools in the message, and a failed reply
 * said plainly.
 */
export const AssistantActivity: React.NamedExoticComponent<{
  items: readonly ChatActivity[];
  tools?: ReadonlyMap<string, ToolPresentation>;
  labels?: ActivityLabels;
  /** The person chose "Show technical details". */
  technical?: boolean;
  /** Who did the work, for status lines ("North is using the terminal…"). */
  agent?: string;
  /** Read a referenced result when its step, details or live view shows. */
  onLoadResult?(item: ChatActivity): void;
}> = memo(function AssistantActivity(
  {
    items,
    tools,
    labels = {},
    technical = false,
    agent = "The agent",
    onLoadResult,
  }: {
    items: readonly ChatActivity[];
    tools?: ReadonlyMap<string, ToolPresentation>;
    labels?: ActivityLabels;
    technical?: boolean;
    agent?: string;
    onLoadResult?(item: ChatActivity): void;
  },
): React.ReactElement | null {
  if (!items.length) return null;
  const steps = backgroundSteps(items, tools);
  const shown = items.filter((item) => {
    const tool = tools?.get(item.id);
    return item.kind === "tool" && (tool?.inline || tool?.live);
  });
  const failures = items.filter((item) => item.kind === "failure");
  return (
    <div data-slot="assistant-activity" className="grid min-w-0 gap-2">
      {steps.length > 0 && (
        <ActivityRow
          steps={steps}
          labels={labels}
          technical={technical}
          tools={tools}
          onLoadResult={onLoadResult}
        />
      )}
      {shown.map((item) => {
        const tool = tools!.get(item.id)!;
        return tool.live
          ? (
            <LiveTool
              key={item.id}
              item={item}
              tool={tool}
              technical={technical}
              agent={agent}
              labels={labels}
              onLoadResult={onLoadResult}
            />
          )
          : (
            <div key={item.id} data-tool={item.toolId}>
              <LoadResult item={item} onLoadResult={onLoadResult} />
              {tool.node}
            </div>
          );
      })}
      {failures.map((item) => (
        <p
          key={item.id}
          role="alert"
          className="text-destructive flex min-h-7 items-center gap-2 text-sm"
        >
          <StatusIcon status="failed" kind="failure" />
          {item.error ?? labels.failed ?? "The response could not be completed"}
        </p>
      ))}
    </div>
  );
});
