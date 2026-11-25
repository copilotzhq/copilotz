/**
 * A chat's header as rc.64 drew it, pinned before archiving was built: given
 * no `archive`, it draws the same page and offers the same menu (rename, move,
 * a new chat), in the same order.
 */
import { assertEquals } from "@std/assert";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Menu, type MenuItem } from "../../../hosts/web/mod.ts";
import { test } from "../../../testing/mod.ts";
import { Header } from "../chat/views/web/header.tsx";

const call = () => Promise.resolve({} as never);

/**
 * What a component draws, without what the toolkit draws inside it (its stylesheets and its
 * icons' paths, which change apart) and with React's ids alike.
 */
const drawn = (node: ReactNode) =>
  renderToStaticMarkup(<>{node}</>)
    .replace(/<style[^>]*>[\s\S]*?<\/style>/g, "")
    .replace(/<svg[^>]*>[\s\S]*?<\/svg>/g, "<svg/>")
    .replace(/_R_\w+_/g, "_R_");

/** The first element of `type` in what a component drew, looking through its children. */
function find(node: ReactNode, type: unknown): ReactElement | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = find(child, type);
      if (found) return found;
    }
    return undefined;
  }
  if (!isValidElement(node)) return undefined;
  if (node.type === type) return node;
  return find((node.props as { children?: ReactNode }).children, type);
}

const header = () =>
  Header({
    title: "Plan the week",
    thread: "t1",
    space: { _id: "s1", name: "Launch", kind: "shared" },
    people: [{ name: "Maya", agent: true, icon: "🦊" }, { name: "Ana", agent: false }],
    fresh: "/?in=s1",
    call,
  });

test("a chat's header, without archive, draws as rc.64 did", () => {
  assertEquals(drawn(header()), MARKUP);
  const menu = find(header(), Menu)!;
  const items = (menu.props as { items: (MenuItem | "separator")[] }).items;
  assertEquals(
    items.map((item) =>
      item === "separator" ? item : [item.label, item.icon, "href" in item ? item.href : undefined]
    ),
    [
      ["Rename…", "pencil", undefined],
      ["Move to another space…", "move", undefined],
      ["New chat", "compose", "/?in=s1"],
    ],
  );
});

const MARKUP = [
  '<header class="chat-head">',
  '<div class="chat-head-text">',
  '<h1 title="Plan the week">Plan the week</h1>',
  '<a class="copilotz-chip copilotz-chip-sm chat-space" title="Open Launch" href="/space/s1">',
  '<span class="copilotz-avatar copilotz-avatar-space" style="--hue:188;--size:14px" aria-hidden="true">L</span>Launch</a>',
  "</div>",
  '<div class="chat-people" role="img" aria-label="In this chat: Maya, Ana">',
  '<span class="copilotz-avatar copilotz-avatar-agent copilotz-avatar-icon" style="--hue:275;--size:26px" title="Maya" aria-hidden="true">🦊</span>',
  '<span class="copilotz-avatar copilotz-avatar-person" style="--hue:165;--size:26px" title="Ana" aria-hidden="true">A</span>',
  "</div>",
  '<span class="copilotz-tooltip-for">',
  '<a href="/?in=s1" class="copilotz-icon-button chat-head-new" aria-label="New chat">',
  "<svg/>",
  "</a>",
  "</span>",
  '<span class="copilotz-tooltip-for">',
  '<button type="button" popoverTarget="_R_-menu" aria-haspopup="menu" aria-expanded="false" aria-controls="_R_-menu" class="copilotz-icon-button" aria-label="This chat: more">',
  "<svg/>",
  "</button>",
  "</span>",
  '<div id="_R_-menu" popover="auto" role="menu" aria-label="This chat: more" class="copilotz-menu copilotz-anchored">',
  '<button type="button" role="menuitem" tabindex="-1" class="copilotz-menu-item">',
  "<svg/>",
  '<span class="copilotz-menu-label">Rename…</span>',
  "</button>",
  '<button type="button" role="menuitem" tabindex="-1" class="copilotz-menu-item">',
  "<svg/>",
  '<span class="copilotz-menu-label">Move to another space…</span>',
  "</button>",
  '<a role="menuitem" tabindex="-1" class="copilotz-menu-item" href="/?in=s1">',
  "<svg/>",
  '<span class="copilotz-menu-label">New chat</span>',
  "</a>",
  "</div>",
  "</header>",
].join("");
