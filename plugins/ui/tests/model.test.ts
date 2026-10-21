import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clampPanelWidth,
  defaultShellCodec,
  groupThreadsByRecency,
  groupThreadsBySpace,
  menuItems,
  resolveDarkMode,
  type ShellHistory,
  shellPreferences,
  shellState,
  shellUrlStorageAdapter,
  spaceDragScrollSpeed,
  spaceSections,
  touchSpaceDrag,
} from "../model.ts";

const thread = (id: string, spaceId?: string, updatedAt = "") => ({
  id,
  name: id,
  ...(spaceId ? { spaceId } : {}),
  updatedAt,
});

test("Space grouping puts each conversation in one bucket and keeps No Space last", () => {
  const groups = groupThreadsBySpace(
    [thread("a", "research"), thread("b"), thread("c", "missing")],
    [
      { id: "research", name: "Research" },
      { id: "empty", name: "Empty" },
    ],
  );
  assert.deepEqual(
    groups.map((group) => [group.key, group.threads.map((value) => value.id)]),
    [
      ["space:research", ["a"]],
      ["space:empty", []],
      ["space:unavailable:missing", ["c"]],
      ["space:none", ["b"]],
    ],
  );
  assert.equal(groups.at(-1)?.label, "No Space");
});

test("an archived Space still holding conversations stays visible and labeled", () => {
  const groups = groupThreadsBySpace(
    [thread("a", "old")],
    [{ id: "old", name: "Old", status: "archived" }],
  );
  assert.deepEqual(groups.map((group) => [group.key, group.label]), [
    ["space:archived:old", "Old (Archived)"],
  ]);
  assert.equal(groups[0].unavailable, true);
});

test("recency groups are Today, Yesterday, Previous 7 and 30 days, then months", () => {
  const now = new Date(2026, 9, 21, 12).getTime();
  const at = (days: number) => new Date(now - days * 86_400_000).toISOString();
  const groups = groupThreadsByRecency([
    thread("old", undefined, at(70)),
    thread("today", undefined, at(0)),
    thread("week", undefined, at(3)),
    thread("yesterday", undefined, at(1)),
    thread("month", undefined, at(12)),
  ], { now, locale: "en-US" });
  assert.deepEqual(groups.map((group) => group.label), [
    "Today",
    "Yesterday",
    "Previous 7 days",
    "Previous 30 days",
    "August",
  ]);
  assert.deepEqual(groups.map((group) => group.threads[0].id), [
    "today",
    "yesterday",
    "week",
    "month",
    "old",
  ]);
});

test("touch drag: a tap stays unarmed and only the owning pointer commits", () => {
  const drag = touchSpaceDrag();
  assert.equal(drag.start(1, "thread", "source", 10, 10), true);
  assert.equal(drag.start(2, "other", null, 0, 0), false);
  assert.equal(drag.update(2, 30, 30), false);
  assert.equal(drag.release(2, "target", ["target"]), null);
  assert.ok(drag.session);
  assert.equal(drag.update(1, 12, 12), false);
  assert.equal(drag.release(1, "target", ["target"]), null);
  assert.equal(drag.session, null);
});

test("touch drag: a release is consumed once; outside, original and ineligible targets never commit", () => {
  const drag = touchSpaceDrag();
  drag.start(1, "thread", "source", 0, 0);
  assert.equal(drag.update(1, 6, 0), true);
  assert.deepEqual(drag.release(1, "target", ["target"]), {
    threadId: "thread",
    spaceId: "target",
  });
  assert.equal(drag.release(1, "target", ["target"]), null);
  for (const target of [null, "source", "missing"]) {
    const next = touchSpaceDrag();
    next.start(7, "thread", "source", 0, 0);
    next.update(7, 8, 8);
    assert.equal(next.release(7, target, ["target", "source"]), null);
  }
});

test("touch drag edge scrolling is bounded and confined to the destination list", () => {
  const rect = { left: 10, right: 210, top: 100, bottom: 500, height: 400 };
  assert.equal(spaceDragScrollSpeed(100, 100, rect), -480);
  assert.equal(spaceDragScrollSpeed(100, 500, rect), 480);
  assert.equal(spaceDragScrollSpeed(100, 300, rect), 0);
  assert.equal(spaceDragScrollSpeed(0, 490, rect), 0);
  assert.equal(spaceDragScrollSpeed(50, 100, { ...rect, height: 0 }), 0);
});

test("theme: a choice wins; system follows the platform", () => {
  assert.equal(resolveDarkMode("dark", false), true);
  assert.equal(resolveDarkMode("light", true), false);
  assert.equal(resolveDarkMode("system", true), true);
  assert.equal(resolveDarkMode("system", false), false);
});

test("preferences default to Spaces, auto sidebar and a sane panel width", () => {
  assert.deepEqual(shellPreferences({}), {
    sidebar: "auto",
    groupBy: "space",
    panelWidth: 420,
    theme: "system",
    archived: false,
    expanded: [],
    collapsed: [],
  });
  assert.equal(shellPreferences({ panelWidth: 12 }).panelWidth, 420);
  assert.equal(shellPreferences({ groupBy: "date" }).groupBy, "date");
  assert.equal(clampPanelWidth(900, 600), 600);
  assert.equal(clampPanelWidth(100, 600), 280);
});

test("shell state keeps identifiers only", () => {
  assert.deepEqual(
    shellState({
      threadId: "t-1",
      spaceId: { nested: true },
      section: "a b",
      panel: "yes",
    }),
    {
      threadId: "t-1",
      spaceId: null,
      section: null,
      panel: false,
      newIn: null,
      page: null,
      origin: "app",
    },
  );
});

function history(href: string, own = false) {
  const writes: { href: string; mode: string }[] = [];
  let current = new URL(href);
  const host: ShellHistory = {
    read: () => new URL(current),
    write(url, mode) {
      current = new URL(url);
      writes.push({ href: url.href, mode });
    },
    own: () => own,
  };
  return { host, writes };
}

test("the URL adapter restores link state as url origin and keeps other parameters", async () => {
  const { host, writes } = history(
    "https://app.example/?chat=t1&space=s1&section=boards&panel=1&ref=mail",
  );
  const adapter = shellUrlStorageAdapter(host);
  const [row] = await adapter.load("shell") ?? [];
  assert.deepEqual(row, {
    id: "main",
    threadId: "t1",
    spaceId: "s1",
    section: "boards",
    panel: true,
    newIn: null,
    page: null,
    origin: "url",
  });
  await adapter.save("shell", [{ ...row, spaceId: null, origin: "app" }]);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].mode, "push");
  const url = new URL(writes[0].href);
  assert.equal(url.searchParams.get("ref"), "mail");
  assert.equal(url.searchParams.get("space"), null);
  await adapter.save("shell", [{
    ...row,
    spaceId: null,
    panel: false,
    origin: "app",
  }]);
  assert.equal(writes.at(-1)?.mode, "replace", "panel changes replace");
});

test("entries the app wrote restore as app origin", async () => {
  const { host } = history("https://app.example/?chat=t1", true);
  const [row] = await shellUrlStorageAdapter(host).load("shell") ?? [];
  assert.equal(row.origin, "app");
});

test("a page round-trips through the URL and pushes history", async () => {
  const { host, writes } = history("https://app.example/?page=adminOverview");
  const adapter = shellUrlStorageAdapter(host);
  const [row] = await adapter.load("shell") ?? [];
  assert.equal(row.page, "adminOverview");
  await adapter.save("shell", [{ ...row, page: null, origin: "app" }]);
  assert.equal(writes.at(-1)?.mode, "push");
  assert.equal(new URL(writes.at(-1)!.href).searchParams.get("page"), null);
});

test("the default codec drops values that are not identifiers", () => {
  const decoded = defaultShellCodec.decode(
    new URL("https://app.example/?chat=%3Cscript%3E&space=ok&new=s2"),
  )!;
  assert.equal(decoded.threadId, null);
  assert.equal(decoded.spaceId, "ok");
  assert.equal(decoded.newIn, "s2");
});

test("sections and menu items sort by order, then label; malformed entries drop", () => {
  const sections = spaceSections({
    members: { label: "Members", view: "m", order: 90 },
    boards: { label: "Boards", view: "b", order: 20, tools: ["kanban", 3] },
    overview: { label: "Overview", view: "o", order: 0 },
    hidden: null,
    broken: { label: "No view" },
  });
  assert.deepEqual(sections.map((section) => section.id), [
    "overview",
    "boards",
    "members",
  ]);
  assert.deepEqual(sections[1].tools, ["kanban"]);
  const items = menuItems({
    b: { label: "Beta", action: "beta" },
    a: { label: "Alpha", dialog: "alpha", order: 10, requires: "thread" },
    c: { label: "No target" },
    d: { label: "Settings", page: "settings", order: 99 },
  });
  assert.deepEqual(items.map((item) => item.id), ["a", "b", "d"]);
  assert.equal(items[0].requires, "thread");
  assert.equal(items[2].page, "settings");
});

test("sections declare the URL parameters they own; the codec drops the ones to clear", () => {
  const [boards] = spaceSections({
    boards: {
      label: "Boards",
      view: "b",
      params: ["board", "card", "bad key"],
    },
  });
  assert.deepEqual(boards.params, ["board", "card"]);
  const url = new URL("https://app.example/?board=b1&card=c1&ref=mail");
  defaultShellCodec.encode(
    url,
    shellState({ threadId: "t1", clear: ["board", "card", "<x>"] }),
  );
  assert.equal(url.searchParams.get("board"), null);
  assert.equal(url.searchParams.get("card"), null);
  assert.equal(url.searchParams.get("ref"), "mail");
  assert.equal(url.searchParams.get("chat"), "t1");
});
