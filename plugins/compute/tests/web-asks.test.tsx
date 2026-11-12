/**
 * What an agent asks to do on a computer, as chat's card shows it (kind
 * `computer.ask`, through chat's `askViews`): the agent as it's named, what
 * it wants to do on which computer, the command itself, what a write would
 * write, an app it would publish; asked in a side thread, it says so. The
 * card and its answers are chat's (see the agents plugin's asks-web test).
 */
import { assert, assertStringIncludes } from "@std/assert";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ViewContext } from "../../../runtime/mod.ts";
import type { Approval } from "../../agents/chat/contract.ts";
import { computersWeb } from "../computers/web.tsx";
import { askView } from "../computers/views/web/asks.tsx";
import { test } from "../../../testing/mod.ts";

const asking = (work: string, detail: string, more: Partial<Approval> = {}): Approval =>
  ({
    _id: `a-${work}`,
    owner: "ana",
    for: "ana",
    on: "d1",
    computer: "c1",
    name: "laptop",
    thread: "t1",
    agent: "east",
    work,
    detail,
    answers: ["once", "thread", "always", "deny"],
    status: "pending",
    at: "2026-11-03T21:00:00.000Z",
    ...more,
  }) as Approval;

/** The ask, as its card's content shows it with these hints. */
const shown = (a: Approval, hints: Record<string, unknown> = {}) => {
  const ctx = { name: "computer.ask", hints, resources: {} } as unknown as ViewContext<ReactNode>;
  return renderToStaticMarkup(<>{askView(a, ctx)}</>).replace(/<style[\s\S]*?<\/style>/g, "");
};

test("a command shows as the agent is named, on which computer, and as a command", () => {
  const html = shown(asking("terminal", "ls -la"), { agent: "East" });
  assertStringIncludes(html, "<b>East</b> wants to run");
  assertStringIncludes(html, "on laptop");
  assertStringIncludes(html, "ls -la");
  assert(!html.includes("in a side thread"), html);
  // Its answers are chat's card's, never its own.
  assert(!html.includes("Yes, this once") && !html.includes("Allow"), html);
});

test("asked in a side thread, it says so", () => {
  assertStringIncludes(shown(asking("jobs", "npm run dev"), { aside: true }), "in a side thread");
});

test("a write shows what it would write; publishing, the app and where it'd be", () => {
  const write = shown(asking("writes", "write src/a.ts", { preview: "# Plan\n- ship" }));
  assertStringIncludes(write, "wants to write");
  assertStringIncludes(write, "src/a.ts");
  assertStringIncludes(write, "# Plan");
  const publish = shown(
    asking("publish", "publish Shop from job web on port 3000", {
      preview: "https://shop.example.test",
      answers: ["once", "deny"],
    }),
  );
  assertStringIncludes(publish, "<b>Shop</b>");
  assertStringIncludes(publish, "shop.example.test");
  assertStringIncludes(publish, "port 3000");
});

test("each kind of work a computer asks about has its card's words and icon", () => {
  const views = computersWeb.resources?.askViews as Record<string, { view: string; icon: string }>;
  for (const work of ["terminal", "jobs", "writes", "publish", "destroy"]) {
    assert(views[work]?.view === "computer.ask" && views[work].icon, work);
  }
});
