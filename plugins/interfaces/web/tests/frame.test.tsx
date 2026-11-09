/**
 * The frame and the `orgs` slot: where a front end fills it and its hook answers, the top of the
 * sidebar is its switcher beside the app's mark, its overlay is drawn, and what the hook lists
 * joins the person's menu (their email under their name); until it answers, or with one org, the
 * top is the app's whole logo, as with no slot at all.
 */
import { assert, assertFalse, assertStringIncludes } from "@std/assert";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "../../../../testing/mod.ts";
import type { OrgsShown } from "../shared/orgs.ts";
import { Frame, type Orgs } from "../views/frame.tsx";

const noCall = () => Promise.resolve({} as never);

const draw = (orgs?: Orgs) =>
  renderToStaticMarkup(
    <Frame
      path="/"
      brand="Harbor"
      viewer="ana"
      label="Ana"
      sidebar={<i id="sidebar" />}
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
