/**
 * The frame and the `orgs` slot: where a front end fills it and its hook answers, the top of the
 * sidebar is its switcher beside the app's mark, its overlay is drawn, and what the hook lists
 * joins the person's menu (their email under their name); until it answers, or with one org, the
 * top is the app's whole logo, as with no slot at all.
 *
 * And the sidebar folded to a rail: whole unless the app starts it as a rail (the `shell`
 * resource), with the button that folds it at its top; as a rail, the app's mark (and under it,
 * where the app serves many orgs, the `orgs` slot's rail View), the button that unfolds it,
 * Search, a place for each section's rail View, and the person's face.
 */
import { assert, assertEquals, assertFalse, assertMatch, assertStringIncludes } from "@std/assert";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "../../../../testing/mod.ts";
import type { OrgsShown } from "../shared/orgs.ts";
import type { ShellSettings } from "../shared/sidebar.ts";
import { Frame, type Orgs } from "../views/frame.tsx";

const noCall = () => Promise.resolve({} as never);

const draw = (orgs?: Orgs, settings?: ShellSettings) =>
  renderToStaticMarkup(
    <Frame
      path="/"
      brand="Harbor"
      viewer="ana"
      label="Ana"
      sidebar={<i id="sidebar" />}
      rails={["new-thread.rail", "spaces.rail"]}
      hints={{ in: "launch", path: "/" }}
      {...(settings ? { settings } : {})}
      menu={[{ label: "Connected accounts", href: "/accounts" }]}
      call={noCall}
      palette={{ sources: [], hints: {} }}
      {...(orgs ? { orgs } : {})}
    >
      <i id="page" />
    </Frame>,
  ).replace(/<style[\s\S]*?<\/style>/g, "");

const slot = (shown: OrgsShown | undefined): Orgs => ({
  switcher: <i id="switcher" /> as ReactNode,
  overlay: <i id="overlay" /> as ReactNode,
  use: () => shown,
});

test("the orgs slot answered: its switcher beside the mark, its overlay, the person's email", () => {
  const markup = draw(slot({
    email: "ana@example.com",
    menu: [{ label: "Organization settings", href: "/org" }],
    palette: [],
  }));
  assertStringIncludes(markup, 'data-orgs=""');
  assertStringIncludes(markup, '<i id="switcher">');
  assertStringIncludes(markup, '<i id="overlay">');
  assertStringIncludes(markup, "ana@example.com");
  assertStringIncludes(markup, '<i id="page">');
});

test("the orgs slot not answering: the app's whole logo, no switcher, the overlay all the same", () => {
  const markup = draw(slot(undefined));
  assertFalse(markup.includes("data-orgs"));
  assertFalse(markup.includes('id="switcher"'));
  assertStringIncludes(markup, '<i id="overlay">');
  assertFalse(markup.includes("ana@example.com"));
});

test("no orgs slot: nothing of orgs", () => {
  const markup = draw();
  assertFalse(markup.includes("data-orgs"));
  assertFalse(markup.includes('id="switcher"') || markup.includes('id="overlay"'));
  assert(markup.includes('<i id="sidebar">'));
});

/** The attributes of the element whose `aria-label` is `label`. */
const named = (markup: string, label: string) =>
  new RegExp(`<[a-z]+[^>]*aria-label="${label}"[^>]*>`).exec(markup)?.[0] ?? "";

test("whole by default: the sidebar's sections, and the button that folds it, at its top", () => {
  const markup = draw();
  assertFalse(markup.includes("data-sidebar") || markup.includes("data-rail"));
  assert(markup.includes('<i id="sidebar">'));
  assertFalse(markup.includes("copilotz-rail"));
  const fold = named(markup, "Collapse sidebar");
  assertStringIncludes(fold, 'aria-expanded="true"');
  assertStringIncludes(fold, "aria-controls=");
  // ⌘B where it runs on a Mac, Ctrl+B elsewhere.
  assertMatch(fold, /aria-keyshortcuts="(Meta|Control)\+B"/);
  // It controls the sidebar.
  const controls = /aria-controls="([^"]+)"/.exec(fold)?.[1];
  assertStringIncludes(markup, `<aside id="${controls}"`);
  assertEquals(draw(undefined, { sidebar: "full" }), markup);
});

test("started as a rail: the mark, unfolding, Search, each section's rail, and the person", () => {
  const markup = draw(undefined, { sidebar: "rail" });
  assertStringIncludes(markup, 'data-sidebar="rail"');
  assertStringIncludes(markup, "data-rail");
  // The sidebar's sections wait, whole, for it to unfold.
  assertFalse(markup.includes('<i id="sidebar">'));
  assertStringIncludes(named(markup, "Harbor: home"), 'href="/"');
  const unfold = named(markup, "Expand sidebar");
  assertStringIncludes(unfold, 'aria-expanded="false"');
  assertMatch(unfold, /aria-keyshortcuts="(Meta|Control)\+B"/);
  assert(named(markup, "Search"));
  // A place for each section's rail View (read only while it shows: nothing yet, on a server).
  assertEquals(markup.match(/class="copilotz-rail-section"/g)?.length, 2);
  // The person, by their face, with their menu.
  assertStringIncludes(named(markup, "Ana"), 'aria-haspopup="menu"');
  assertStringIncludes(markup, "copilotz-me-rail");
  assertFalse(markup.includes("copilotz-me-button"));
});

test("on the rail, where the app serves many orgs: the switcher's own under the mark, once it answers", () => {
  const rail = { sidebar: "rail" } as const;
  const shown = { email: "ana@example.com", palette: [] };
  const markup = draw({ ...slot(shown), rail: "orgs.rail" }, rail);
  // A place for the slot's rail View (read only while the rail shows: nothing yet, on a server),
  // after the app's mark and before the button that unfolds the sidebar.
  const head = /<div class="copilotz-rail-head">[\s\S]*?<\/div><nav/.exec(markup)?.[0] ?? "";
  const order = ["Harbor: home", "copilotz-rail-org", "Expand sidebar", "Search"]
    .map((mark) => head.indexOf(mark));
  assert(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1])), String(order));
  // The whole switcher waits for the sidebar to unfold.
  assertFalse(markup.includes('id="switcher"'));
  // Until the slot's hook answers (or with one org), or with no rail View, the mark alone.
  assertFalse(draw({ ...slot(undefined), rail: "orgs.rail" }, rail).includes("copilotz-rail-org"));
  assertFalse(draw(slot(shown), rail).includes("copilotz-rail-org"));
});
