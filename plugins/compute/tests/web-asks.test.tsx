/**
 * What agents wait on you for, over where you type (`computer.asks`): an
 * agent's cards wait for its own turn to be over, never for another agent
 * still working in the conversation; and what's asked in a side thread shows
 * in the conversation too, saying so.
 */
import { assert, assertStringIncludes } from "@std/assert";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ViewContext } from "../../../runtime/mod.ts";
import type { Approval } from "../computers/collections/approval.ts";
import { asksView } from "../computers/views/web/asks.tsx";
import { test } from "../../../testing/mod.ts";

const asking = (agent: string, detail: string): Approval =>
  ({
    _id: `a-${agent}`,
    owner: "ana",
    for: "ana",
    desk: "d1",
    computer: "c1",
    name: "laptop",
    thread: "t1",
    agent,
    work: "terminal",
    detail,
    status: "pending",
    at: "2026-11-03T21:00:00.000Z",
  }) as Approval;

/** The cards, as they show with these hints. */
const shown = (pending: Approval[], hints: Record<string, unknown>) => {
  const ctx = {
    db: {
      collection: () => ({ query: () => ({ status: "ready", value: pending }) }),
    },
    resources: {
      agents: { east: { name: "East", instructions: "" }, south: { name: "South" } },
    },
    name: "computer.asks",
    hints,
    show: () => null,
    call: () => Promise.resolve({} as never),
    emit: () => Promise.resolve(),
  } as unknown as ViewContext<ReactNode>;
  return renderToStaticMarkup(<>{asksView({}, ctx)}</>).replace(/<style[\s\S]*?<\/style>/g, "");
};

test("an agent's OK shows once its turn is over, while another agent works on", () => {
  const east = asking("east", "ls -la");
  // East has said why and stopped; South is still working: East's card shows.
  const html = shown([east], { thread: "t1", working: true, busy: ["south"] });
  assertStringIncludes(html, "East");
  assertStringIncludes(html, "ls -la");
  // While East itself is still writing, its explanation comes first.
  assert(!shown([east], { thread: "t1", working: true, busy: ["east"] }).includes("ls -la"));
  // Each agent's by its own turn: South's waits, East's shows.
  const both = shown([east, asking("south", "rm -rf build")], {
    thread: "t1",
    working: true,
    busy: ["south"],
  });
  assert(both.includes("ls -la") && !both.includes("rm -rf build"), both);
  // Another conversation's asks don't show here.
  assert(!shown([east], { thread: "t2", busy: [] }).includes("ls -la"));
});

test("an OK asked in a side thread shows in its conversation, saying where it was asked", () => {
  const east = { ...asking("east", "df -h"), thread: "t1-side" };
  const html = shown([east], { thread: "t1", side: ["t1-side"], busy: [] });
  assertStringIncludes(html, "df -h");
  assertStringIncludes(html, "in a side thread");
  // Not another conversation's side thread.
  assert(!shown([east], { thread: "t1", side: ["t2-side"], busy: [] }).includes("df -h"));
  // Seen in the side thread itself, it's just here.
  assert(!shown([east], { thread: "t1-side", busy: [] }).includes("in a side thread"));
});
