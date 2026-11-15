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
import { foldLabel } from "../shared/sidebar.ts";
import { Me } from "../views/me.tsx";
import { defaultView } from "../views/default.tsx";
import { PanelSheet, PanelToggle, SidePanel, usePanel } from "../views/panel.tsx";
import { Rail, useSidebar } from "../views/rail.tsx";

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

/** The sidebar folded to a rail, with the person's face at its foot. */
function Rails(): ReactNode {
  const state = useSidebar("ana", { sidebar: "rail" }, "fold");
  return (
    <Rail
      brand="Harbor"
      mac={false}
      state={state}
      button="fold"
      sidebar="side"
      rails={["spaces.rail"]}
      hints={{}}
      me={<Me rail name="Ana" call={noCall} />}
    />
  );
}

function draw(): string {
  const parts: ReactNode[] = [];
  parts.push(
    <Me
      name="Ana"
      email="ana@example.com"
      menu={[{ label: "Connected accounts", href: "/accounts" }]}
      call={noCall}
    />,
    <Me name="Ana" call={noCall} />,
    <Me email="ana@example.com" call={noCall} />,
    <Panels />,
    <Rails />,
    <Me rail call={noCall} />,
    defaultView({ _id: "x" }, ctx({ of: "note" })),
    defaultView({ _id: "x", title: "Plan", body: "Hi" }, ctx({ of: "note" })),
  );
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
    foldLabel(true),
    foldLabel(false),
  ]);
}

test("with every word replaced, no English of the shell is left", () => {
  const restore = setWords(pseudoWords("shell"));
  try {
    const markup = draw();
    assertEquals(englishLeft(shown(markup), "shell"), []);
    for (
      const key of [
        "signedIn",
        "yourAccount",
        "signOut",
        "nothingToShow",
        "panelWidth",
        "expandSidebar",
        "homeOf",
        "search",
      ]
    ) {
      assert(markup.includes(`«shell.${key}»`), key);
    }
    assertEquals(englishLeft(sayings(), "shell"), []);
    assertStringIncludes(sayings(), "«shell.roleOwnerLets»");
    assertStringIncludes(sayings(), "«shell.hidePanelTitled»");
    assertStringIncludes(sayings(), "«shell.collapseSidebar»");
  } finally {
    restore();
  }
});

test("with none given, the shell says what it always did", () => {
  const markup = draw();
  for (
    const phrase of [
      "Your account",
      "Sign out",
      "Nothing to show",
      "Panel width",
      'aria-label="Expand sidebar"',
      'aria-label="Harbor: home"',
    ]
  ) {
    assertStringIncludes(markup, phrase);
  }
  assertEquals(toggleLabel(true, "Space"), "Hide the space panel");
  assertEquals(toggleLabel(false), "Show the panel");
  assertEquals(orgRoleName("admin"), "Admin");
  assertEquals(foldLabel(false), "Collapse sidebar");
});

test("in another language a plural and a blank follow that language", () => {
  const restore = setWords({
    "shell.showPanelTitled": "Mostrar o painel {title}",
    "shell.collapseSidebar": "Recolher a barra lateral",
    "shell.expandSidebar": "Expandir a barra lateral",
  });
  try {
    assertEquals(toggleLabel(false, "Espaço"), "Mostrar o painel espaço");
    assertEquals(foldLabel(false), "Recolher a barra lateral");
    assertEquals(foldLabel(true), "Expandir a barra lateral");
  } finally {
    restore();
  }
});
