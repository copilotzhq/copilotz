/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
/**
 * A demo app on the chat shell: branding, Space sections, header and user
 * menu items, a terminal tool renderer, suggestions. Everything an app
 * contributes is plain data or a View.
 * @module
 */
// deno-lint-ignore verbatim-module-syntax -- classic JSX requires this runtime import.
import * as React from "react";
import { CircleCheck, LoaderCircle, Terminal } from "lucide-react";
import { defineView } from "@copilotz/copilotz/views";
import type { BrowserPlugin, BrowserViewContext } from "@copilotz/copilotz/web";
import type { ToolCallView } from "@copilotz/copilotz/core/web";
import {
  Badge,
  Button,
  cn,
  EmptyState,
  formatRelative,
  Frame,
  Input,
  ResourceHeader,
  ResourceList,
  ResourceRow,
  ResourceToolbar,
} from "@copilotz/copilotz/web/kit";
import { agents, sender } from "./fixtures.ts";

const now = Date.now();
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

type Section = { spaceId: string; threadId?: string | null };

const boards = defineView<Section, React.ReactNode, BrowserViewContext>({
  id: "demo.boards",
  shows: "demoBoards",
  renderer: "react",
  modes: ["full", "panel"],
  url: true,
  render(_value, ctx) {
    const panel = ctx.hints.mode === "panel";
    const stages = [
      { name: "Backlog", cards: ["Landing page v1"] },
      {
        name: "To do",
        cards: ["Define pricing test and control", "Agree sample size"],
      },
      { name: "Doing", cards: ["Write positioning brief"] },
      { name: "Done", cards: ["Collect Q3 funnel data"] },
    ];
    return (
      <div
        className={cn(
          "mx-auto grid w-full gap-4",
          panel ? "p-3" : "max-w-3xl p-4 sm:p-6",
        )}
      >
        <ResourceHeader
          title="Launch cycle 1"
          badge={<Badge variant="success">Active</Badge>}
          back={{ label: "Back to boards", onClick() {} }}
          description="First two-week work cycle for the Q4 launch."
        />
        {stages.map((stage) => (
          <section key={stage.name} className="grid gap-1.5">
            <h3 className="text-muted-foreground flex items-center gap-2 text-xs font-medium tracking-wide uppercase">
              {stage.name}
              <span className="bg-muted rounded px-1.5 py-0.5 text-[11px] tabular-nums">
                {stage.cards.length}
              </span>
            </h3>
            <ResourceList>
              {stage.cards.map((card) => (
                <ResourceRow key={card} title={card} onOpen={() => {}} />
              ))}
            </ResourceList>
          </section>
        ))}
      </div>
    );
  },
});

const documents = defineView<Section, React.ReactNode, BrowserViewContext>({
  id: "demo.documents",
  shows: "demoDocuments",
  renderer: "react",
  modes: ["full", "panel"],
  url: true,
  render(_value, ctx) {
    const panel = ctx.hints.mode === "panel";
    const docs = [
      ["Positioning brief", "Audience, problem, promise and proof.", 20],
      ["Launch FAQ", "Answers for support and sales.", 300],
      ["Pricing memo", "Tiers, anchors and the test plan.", 1_600],
    ] as const;
    return (
      <div
        className={cn(
          "mx-auto grid w-full gap-3",
          panel ? "p-3" : "max-w-3xl p-4 sm:p-6",
        )}
      >
        <ResourceToolbar
          search=""
          onSearch={() => {}}
          searchLabel="Search documents"
        >
          <Button type="button" size="sm">New</Button>
        </ResourceToolbar>
        <ResourceList label="Documents">
          {docs.map(([title, summary, minutes]) => (
            <ResourceRow
              key={title}
              title={title}
              subtitle={summary}
              meta={formatRelative(ago(minutes))}
              onOpen={() => {}}
            />
          ))}
        </ResourceList>
      </div>
    );
  },
});

const placeholder = (id: string, shows: string, title: string, text: string) =>
  defineView<Section, React.ReactNode, BrowserViewContext>({
    id,
    shows,
    renderer: "react",
    modes: ["full", "panel"],
    url: true,
    render(_value, ctx) {
      return (
        <div
          className={ctx.hints.mode === "panel"
            ? "p-3"
            : "mx-auto max-w-3xl p-6"}
        >
          <EmptyState title={title}>{text}</EmptyState>
        </div>
      );
    },
  });

const terminal = defineView<ToolCallView, React.ReactNode, BrowserViewContext>({
  id: "demo.terminalTool",
  shows: "terminalToolCall",
  renderer: "react",
  modes: ["inline"],
  render(call) {
    const command = String(call.input?.stdin ?? "");
    const running = call.status === "running" || call.status === "streaming";
    const output = call.output?.stdout ?? call.result ?? "";
    return (
      <div className="overflow-hidden rounded-lg border border-(--code-border) bg-(--code-background) text-(--code-foreground)">
        <div className="flex items-center gap-2 border-b border-(--code-border) px-3 py-1.5 text-xs">
          <Terminal aria-hidden="true" className="size-3.5 opacity-70" />
          <span className="font-mono opacity-80">terminal</span>
          <span className="ml-auto flex items-center gap-1.5 opacity-80">
            {running
              ? (
                <>
                  <LoaderCircle
                    aria-hidden="true"
                    className="size-3 animate-spin"
                  />{" "}
                  Running
                </>
              )
              : (
                <>
                  <CircleCheck aria-hidden="true" className="size-3" /> Done
                </>
              )}
          </span>
        </div>
        <pre className="max-h-56 overflow-auto p-3 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap">
          <span className="opacity-60">$</span> {`${command}\n${output}`}
        </pre>
      </div>
    );
  },
});

const invite = defineView<Section, React.ReactNode, BrowserViewContext>({
  id: "demo.invite",
  shows: "demoInvite",
  renderer: "react",
  modes: ["dialog"],
  render(_value, ctx) {
    return (
      <Frame
        ctx={ctx}
        title="Invite someone"
        description="They join this conversation and can read its history."
      >
        <Input type="email" placeholder="name@example.com" aria-label="Email" />
        <div className="flex justify-end">
          <Button
            type="button"
            onClick={() => ctx.actions.shellDialog({ reference: null })}
          >
            Send invite
          </Button>
        </div>
      </Frame>
    );
  },
});

/** The demo app's single browser plugin. */
export const demoApp: BrowserPlugin = {
  id: "demo-app",
  views: {
    boards,
    documents,
    computers: placeholder(
      "demo.computers",
      "demoComputers",
      "Launch workspace is ready",
      "Files and apps from the Space's computer show here.",
    ),
    jobs: placeholder(
      "demo.jobs",
      "demoJobs",
      "Daily stand-up summary",
      "Weekdays at 09:00 · next run in 10 hours.",
    ),
    terminal,
    invite,
  },
  actions: {
    threadFork: { id: "demo.thread.fork", placement: "server" },
    signOut: { id: "demo.session.end", placement: "server" },
  },
  resources: {
    shell: {
      branding: { title: "Copilotz", subtitle: "Multi-agent workspace" },
      suggestions: [
        "Let the team debate the goal, scope and first milestone.",
        "Turn this rough idea into a practical kickoff plan.",
        "Map the unknowns, risks and decisions from different angles.",
        "Create a first shared board for the work cycle.",
      ],
      labels: {
        footer: "Agents can make mistakes. Review important work.",
      },
    },
    chat: {
      sender,
      agents: agents.map((agent) => ({
        externalId: agent.externalId,
        agentId: agent.agentId,
        participantType: "agent",
        name: agent.name,
        description: agent.metadata.description,
      })),
    },
    spaceSections: {
      boards: {
        label: "Boards",
        icon: "kanban",
        order: 20,
        view: "demoBoards",
        tools: ["kanban"],
      },
      documents: {
        label: "Docs",
        icon: "file",
        order: 30,
        view: "demoDocuments",
        tools: ["shared_document"],
      },
      computers: {
        label: "Computers",
        icon: "laptop",
        order: 40,
        view: "demoComputers",
        tools: ["terminal"],
      },
      jobs: { label: "Jobs", icon: "calendar", order: 50, view: "demoJobs" },
    },
    headerMenu: {
      invite: {
        label: "Invite someone",
        icon: "user-plus",
        dialog: "demoInvite",
        requires: "thread",
      },
      fork: {
        label: "Fork conversation",
        icon: "git-branch",
        action: "threadFork",
        requires: "thread",
      },
    },
    userMenu: {
      signOut: {
        label: "Sign out",
        icon: "logout",
        action: "signOut",
        destructive: true,
      },
    },
    toolRenderers: { terminal: { view: "terminalToolCall" } },
  },
};
