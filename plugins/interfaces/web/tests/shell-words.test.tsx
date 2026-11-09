/**
 * The web shell's words are the app's to change: drawn with every word replaced by its key
 * nothing English is left; drawn with none given the English is as it was; and in another
 * language a plural and a blank follow that language.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "../../../../testing/mod.ts";
import type { ViewContext } from "../../../../runtime/mod.ts";
import { setWords } from "../../../../hosts/web/words.ts";
import { englishLeft, pseudoWords } from "../../../../testing/words.ts";
import { ORG_ROLES, orgRoleName } from "../shared/orgs.ts";
import { toggleLabel } from "../shared/panel.ts";
import { Me } from "../views/me.tsx";
import { defaultView } from "../views/default.tsx";
import { PanelSheet, PanelToggle, SidePanel, usePanel } from "../views/panel.tsx";

const noCall = () => Promise.resolve({} as never);

const ctx = (hints: Record<string, unknown> = {}): ViewContext<ReactNode> => ({
  db: {
    collection: () => ({
      query: () => ({ status: "ready", value: undefined }),
      find: () => ({ status: "ready", value: [] }),
      findOne: () => ({ status: "ready", value: { _id: "x" } }),
    }),
  } as unknown as ViewContext<ReactNode>["db"],
  resources: {},
  name: "test",
  viewer: { name: "ana" },
  hints,
  show: () => null,
  call: noCall,
  emit: () => Promise.resolve(),
});

/** Only what a person reads or hears: text, and the attributes read aloud or shown on hover. */
const shown = (markup: string) =>
  markup.replace(/<([a-z0-9]+)((?:\s+[\w:-]+(?:="[^"]*")?)*)\s*\/?>/g, (_, tag, attributes) => {
    const kept = [
      ...attributes.matchAll(/\s((?:aria-label|aria-valuetext|title|placeholder|alt)="[^"]*")/g),
    ];
    return tag === "code" ? "<c>" : `<${tag}${kept.map((k) => ` ${k[1]}`).join("")}>`;
  }).replace(/<\/code>/g, "</c>").replace(/ aria-label="Close"/g, ""); // the toolkit dialog's own button: the toolkit's word

function Panels(): ReactNode {
  const state = usePanel("ana", "/", false);
  const offered = { view: "space.panel", title: "Space", space: "launch" };
  return (
    <>
      <PanelToggle panel={offered} state={state} id="p" narrow={false} />
      <SidePanel panel={offered} state={state} id="p" />
      <PanelSheet panel={{ view: "space.panel", space: "launch" }} state={state} id="p" />
    </>
  );
}

function draw(): string {
  const parts: ReactNode[] = [
    <Me
      name="Ana"
      email="ana@example.com"
      menu={[{ label: "Connected accounts", href: "/accounts" }]}
    />,
    <Me name="Ana" />,
    <Panels />,
    defaultView({ _id: "x" }, ctx({ of: "note" })),
    defaultView({ _id: "x", title: "Plan", body: "Hi" }, ctx({ of: "note" })),
  ];
  return parts.map((node) => renderToStaticMarkup(<>{node}</>)).join("\n")
    .replace(/<style[\s\S]*?<\/style>/g, "");
}

/** What the plain functions say: roles and labels. */
function sayings(): string {
  return JSON.stringify([
    ORG_ROLES.map((r) => [r.label, r.lets]),
    orgRoleName("owner"),
    toggleLabel(true, "Space"),
    toggleLabel(false),
  ]);
}

test("with every word replaced, no English of the shell is left", () => {
  const restore = setWords(pseudoWords("shell"));
  try {
    const markup = draw();
    assertEquals(englishLeft(shown(markup), "shell"), []);
    for (const key of ["signedIn", "yourAccount", "signOut", "nothingToShow", "panelWidth"]) {
      assert(markup.includes(`«shell.${key}»`), key);
    }
    assertEquals(englishLeft(sayings(), "shell"), []);
    assertStringIncludes(sayings(), "«shell.roleOwnerLets»");
    assertStringIncludes(sayings(), "«shell.hidePanelTitled»");
  } finally {
    restore();
  }
});

test("with none given, the shell says what it always did", () => {
  const markup = draw();
  for (const phrase of ["Your account", "Sign out", "Nothing to show", "Panel width"]) {
    assertStringIncludes(markup, phrase);
  }
  assertEquals(toggleLabel(true, "Space"), "Hide the space panel");
  assertEquals(toggleLabel(false), "Show the panel");
  assertEquals(orgRoleName("admin"), "Admin");
});

test("in another language a plural and a blank follow that language", () => {
  const restore = setWords({ "shell.showPanelTitled": "Mostrar o painel {title}" });
  try {
    assertEquals(toggleLabel(false, "Espaço"), "Mostrar o painel espaço");
  } finally {
    restore();
  }
});
