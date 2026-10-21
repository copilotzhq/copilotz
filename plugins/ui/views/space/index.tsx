/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
// deno-lint-ignore verbatim-module-syntax -- classic JSX requires this runtime import.
import * as React from "react";
import { useId } from "react";
import { Maximize2, X } from "lucide-react";
import { defineView, type ViewDefinition } from "@copilotz/copilotz/views";
import type { BrowserViewContext } from "@copilotz/copilotz/web";
import { readSpace, readThreadMessages } from "@copilotz/copilotz/core/web";
import {
  Button,
  ReadStatus,
  showSafely,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@copilotz/copilotz/web/kit";
import { shellState, spaceSections } from "../../model.ts";
import { SpaceTabs } from "../../components/space-tabs.tsx";
import { SpaceMark } from "../../components/space-mark.tsx";
import { navReference } from "../shell/index.tsx";

/**
 * Sections whose tools an agent used in this session (a dot, never a
 * switch). A tool that failed marks nothing: its result says so (Core's tool
 * result messages, from the same window the conversation reads).
 */
function marked(
  ctx: BrowserViewContext,
  threadId: string | null,
  sections: ReturnType<typeof spaceSections>,
): Set<string> {
  const result = new Set<string>();
  if (!threadId || !ctx.collections.threadFeed) return result;
  const attempts = ctx.collections.threadFeed.get(threadId).value?.attempts;
  if (!Array.isArray(attempts)) return result;
  // A reply that failed ran none of its tools; a call whose result failed or
  // was cancelled did nothing to the section either.
  const calls = (attempts as {
    status?: string;
    tools?: { name?: string; toolCallId?: string }[];
  }[]).flatMap((attempt) =>
    attempt.status === "failed" ? [] : attempt.tools ?? []
  ).filter((tool) => tool.name);
  if (!calls.length) return result;
  const failed = new Set(
    readThreadMessages(ctx, threadId).value.flatMap((row) => {
      const metadata = (row.metadata ?? {}) as Record<string, unknown>;
      const invocation = metadata.toolInvocation as
        | { id?: unknown }
        | undefined;
      return typeof invocation?.id === "string" &&
          (metadata.toolStatus === "failed" ||
            metadata.toolStatus === "cancelled")
        ? [invocation.id]
        : [];
    }),
  );
  const used = new Set(
    calls.filter((tool) => !tool.toolCallId || !failed.has(tool.toolCallId))
      .map((tool) => tool.name!),
  );
  for (const section of sections) {
    if (section.tools.some((tool) => used.has(tool))) result.add(section.id);
  }
  return result;
}

/**
 * A Space: its sections as tabs (built-in Overview, Chats and Members, plus
 * app sections). The same View fills the main area and the right panel.
 */
const view: ViewDefinition<
  { spaceId: string; threadId?: string | null },
  React.ReactNode,
  BrowserViewContext
> = defineView<
  { spaceId: string; threadId?: string | null },
  React.ReactNode,
  BrowserViewContext
>({
  id: "ui.space",
  shows: "space",
  renderer: "react",
  modes: ["full", "panel"],
  url: true,
  render({ spaceId, threadId = null }, ctx) {
    const panel = ctx.hints.mode === "panel";
    const nav = shellState(ctx.collections.shell?.get("main").value);
    const space = readSpace(ctx, spaceId);
    const sections = spaceSections(ctx.resources.spaceSections);
    const selected = sections.find((section) => section.id === nav.section) ??
      sections[0];
    const name = String(space.value?.name ?? "") || "Space";
    const dots = panel ? marked(ctx, threadId, sections) : new Set<string>();
    if (space.status !== "ready" || !space.value || !selected) {
      return (
        <div className="mx-auto grid w-full max-w-3xl gap-3 p-6">
          <ReadStatus
            state={space.status === "ready"
              ? { value: undefined, status: "missing", pending: false }
              : space}
            noun="Space"
          />
        </div>
      );
    }
    return (
      <SpaceLayout
        panel={panel}
        name={name}
        spaceId={spaceId}
        tabs={
          <SpaceTabs
            sections={sections}
            selected={selected.id}
            marked={dots}
            panelId={`space-section-${spaceId}`}
            onSelect={(section) => ctx.actions.shellSection?.({ section })}
          />
        }
        onExpand={panel
          ? () =>
            ctx.actions.shellOpenSpace?.({ spaceId, section: selected.id })
          : undefined}
        onClose={panel
          ? () => ctx.actions.shellPanel?.({ open: false })
          : undefined}
      >
        {showSafely(
          ctx,
          navReference({
            shows: selected.view,
            value: { spaceId, threadId },
          }, nav.origin),
          { mode: panel ? "panel" : "full" },
          selected.label,
        )}
      </SpaceLayout>
    );
  },
});

function SpaceLayout(
  { panel, name, spaceId, tabs, children, onExpand, onClose }: {
    panel: boolean;
    name: string;
    spaceId: string;
    tabs: React.ReactNode;
    children: React.ReactNode;
    onExpand?(): void;
    onClose?(): void;
  },
): React.ReactElement {
  const id = useId();
  return (
    <section
      aria-label={`${name} Space`}
      data-density={panel ? "panel" : "full"}
      className="flex h-full min-h-0 flex-col"
    >
      {panel && (
        <div className="flex h-12 shrink-0 items-center gap-2 border-b pr-1.5 pl-3">
          <SpaceMark id={spaceId} name={name} />
          <h2 id={id} className="min-w-0 flex-1 truncate text-sm font-semibold">
            {name}
          </h2>
          {onExpand && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Open ${name} in the main area`}
                  onClick={onExpand}
                >
                  <Maximize2 />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Open Space</TooltipContent>
            </Tooltip>
          )}
          {onClose && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Close the side panel"
                  onClick={onClose}
                >
                  <X />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Close panel</TooltipContent>
            </Tooltip>
          )}
        </div>
      )}
      <div
        className={panel
          ? "border-b px-2 py-1.5"
          : "border-b px-3 py-2 sm:px-5"}
      >
        {tabs}
      </div>
      <div
        id={`space-section-${spaceId}`}
        role="tabpanel"
        className="min-h-0 flex-1 overflow-y-auto"
      >
        {children}
      </div>
    </section>
  );
}

export default view;
