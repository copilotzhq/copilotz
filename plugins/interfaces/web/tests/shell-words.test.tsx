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
import { englishLeft, pseudoWords } from "../../../../hosts/web/tests/pseudo.ts";
import type { ConsoleOrg, GiftCode, Orgs } from "../../../access/directory/contract.ts";
import { codeStatus, dayOf, dollarsOf, newCodeOf, statusOf } from "../shared/codes.ts";
import { ORG_ROLES, orgRoleName, standingName } from "../shared/orgs.ts";
import { toggleLabel } from "../shared/panel.ts";
import { Me } from "../views/me.tsx";
import { defaultView } from "../views/default.tsx";
import { orgView } from "../views/org.tsx";
import { NewOrg, orgsPalette, OrgSwitcher } from "../views/orgs.tsx";
import { PanelSheet, PanelToggle, SidePanel, usePanel } from "../views/panel.tsx";
import {
  consoleView,
  DeleteDialog,
  type Doing,
  MoveDialog,
  RenameDialog,
  Row,
  SuspendDialog,
} from "../views/console.tsx";
import { NewCode, Revoke, Row as CodeRow, ShownOnce } from "../views/console-codes.tsx";
import { say } from "../views/words.ts";

const noCall = () => Promise.resolve({} as never);
const at = "2026-10-30T09:00:00.000Z";

const ctx = (
  hints: Record<string, unknown> = {},
  resources: Record<string, Record<string, unknown>> = {},
): ViewContext<ReactNode> => ({
  db: {
    collection: () => ({
      query: () => ({ status: "ready", value: undefined }),
      find: () => ({ status: "ready", value: [] }),
      findOne: () => ({ status: "ready", value: { _id: "x" } }),
    }),
  } as unknown as ViewContext<ReactNode>["db"],
  resources,
  name: "test",
  viewer: { name: "ana" },
  hints,
  show: () => null,
  call: noCall,
  emit: () => Promise.resolve(),
});

const orgs: Orgs = {
  person: "ana",
  email: "ana@example.com",
  current: "acme",
  orgs: [
    { id: "me", name: "ana", kind: "personal" },
    { id: "acme", name: "Acme", kind: "team" },
    { id: "lab", name: "Lab", kind: "team", suspended: true },
  ],
  invites: [
    { id: "i1", org: "zed", name: "Zed", role: "member", from: "Maya", at },
    { id: "i2", org: "kay", name: "Kay", role: "guest", at },
  ],
  staff: true,
  asStaff: false,
};
const acme = orgs.orgs[1];
const consoleOrg = (more: Partial<ConsoleOrg> = {}): ConsoleOrg => ({
  ...acme,
  by: "ana",
  members: 3,
  placement: { schema: "org_acme" },
  summary: { people: 3, spaces: 2, active: at },
  at,
  ...more,
});
const code = (more: Partial<GiftCode> = {}): GiftCode => ({
  id: "c1",
  short: "GIFT-12",
  amount: 25.5,
  at,
  expires: "2027-01-01",
  until: "2026-12-01",
  note: "Conference",
  ...more,
} as GiftCode);

const doing = (what: Doing["what"], org = consoleOrg()): Doing => ({ what, org });
const noop = () => {};

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
  const parts: ReactNode[] = [];
  const staff = { role: null, staff: true };
  parts.push(
    <Me
      name="Ana"
      email="ana@example.com"
      menu={[{ label: "Connected accounts", href: "/accounts" }]}
      orgs={{ here: true, standing: { role: "owner", staff: false }, staff: true }}
    />,
    <Me name="Ana" />,
    <Me
      name="Ana"
      orgs={{ here: true, standing: { role: "member", staff: false }, staff: false }}
    />,
    <Panels />,
    <OrgSwitcher
      orgs={orgs}
      here={acme}
      standing={{ role: "owner", staff: false }}
      staff={false}
      onNew={noop}
    />,
    <OrgSwitcher
      orgs={orgs}
      here={acme}
      standing={{ role: "owner", staff: false }}
      staff
      onNew={noop}
    />,
    <OrgSwitcher
      orgs={orgs}
      here={orgs.orgs[0]}
      standing={{ role: "owner", staff: false }}
      staff={false}
      onNew={noop}
    />,
    <NewOrg open onClose={noop} />,
    defaultView({ _id: "x" }, ctx({ of: "note" })),
    defaultView({ _id: "x", title: "Plan", body: "Hi" }, ctx({ of: "note" })),
    orgView(null, ctx({}, {})),
    consoleView(null, ctx({ query: {} })),
    consoleView(null, ctx({ query: { tab: "codes" } })),
    <Row org={consoleOrg()} here inAsStaff onDo={noop} />,
    <Row
      org={consoleOrg({ kind: "personal", suspended: true, summary: undefined })}
      here={false}
      inAsStaff={false}
      onDo={noop}
    />,
    <RenameDialog doing={doing("rename")} close={noop} finished={noop} />,
    <SuspendDialog doing={doing("suspend")} close={noop} finished={noop} />,
    <SuspendDialog
      doing={doing("suspend", consoleOrg({ suspended: true }))}
      close={noop}
      finished={noop}
    />,
    <MoveDialog doing={doing("move")} close={noop} finished={noop} />,
    <DeleteDialog doing={doing("delete")} close={noop} finished={noop} />,
    <CodeRow code={code()} orgName={() => "Acme"} onRevoke={noop} />,
    <CodeRow code={code({ org: "acme", claimed: at })} orgName={() => "Acme"} onRevoke={noop} />,
    <CodeRow
      code={code({ expires: undefined, until: undefined })}
      orgName={() => "Acme"}
      onRevoke={noop}
    />,
    <NewCode open close={noop} onMade={noop} />,
    <ShownOnce made={{ code: "ABCD-EFGH", amount: 25 }} close={noop} />,
    <Revoke code={code()} close={noop} onDone={noop} />,
  );
  void staff;
  return parts.map((node) => renderToStaticMarkup(<>{node}</>)).join("\n")
    .replace(/<style[\s\S]*?<\/style>/g, "");
}

/** What the plain functions say: palette groups, roles, labels, codes, dates and money. */
function sayings(): string {
  const groups = orgsPalette(orgs, acme, { role: "owner", staff: false });
  const members = orgsPalette({ ...orgs, invites: [], staff: false }, acme, {
    role: "member",
    staff: false,
  });
  const created = groups.flatMap((g) => g.items).find((i) => i.key === "org:new")?.step;
  return JSON.stringify([
    groups,
    created?.items?.("Plans"),
    created?.items?.("x".repeat(90)),
    members,
    ORG_ROLES.map((r) => [r.label, r.lets]),
    orgRoleName("owner"),
    standingName({ role: null, staff: true }),
    toggleLabel(true, "Space"),
    toggleLabel(false),
    (["waiting", "claimed", "revoked", "expired"] as const).map((s) => statusOf(s).label),
    newCodeOf({ amount: "nope", expires: "", until: "", note: "" }),
  ], (key, value) => ["key", "keywords", "icon", "tone"].includes(key) ? undefined : value);
}

test("with every word replaced, no English of the shell is left", () => {
  const restore = setWords({ ...pseudoWords("shell"), ...pseudoWords("directory") });
  try {
    const markup = draw();
    assertEquals(englishLeft(shown(markup), "shell"), []);
    assertEquals(englishLeft(shown(markup), "directory"), []);
    for (
      const key of [
        "orgSettings",
        "signedIn",
        "yourAccount",
        "signOut",
        "newOrg",
        "createOrg",
        "deleteForGood",
        "nothingToShow",
        "takeItBack",
        "notShownAgain",
      ]
    ) assert(markup.includes(`«shell.${key}»`), key);
    assertEquals(englishLeft(sayings(), "shell"), []);
    assertStringIncludes(sayings(), "«shell.roleOwnerLets»");
    assertStringIncludes(sayings(), "«shell.hidePanelTitled»");
  } finally {
    restore();
  }
});

test("with none given, the shell says what it always did", () => {
  const markup = draw();
  for (
    const phrase of [
      "Organization settings",
      "About this organization",
      "All orgs (console)",
      "Signed in as",
      "New organization",
      "Create organization",
      "Enter as staff",
      "New gift code",
      "Take it back",
      "Nothing to show",
      "Delete for good",
      "Credits lapse",
      "Panel width",
    ]
  ) assertStringIncludes(markup, phrase);
  assertEquals(toggleLabel(true, "Space"), "Hide the space panel");
  assertEquals(toggleLabel(false), "Show the panel");
  assertEquals(orgRoleName("admin"), "Admin");
  assertEquals(statusOf(codeStatus(code())).label, "Waiting");
  assertEquals(dayOf("2026-10-30T09:00:00Z"), "Oct 30, 2026");
  assertEquals(dollarsOf(25), "$25");
  assertEquals(dollarsOf(25.5), "$25.50");
  assertEquals(newCodeOf({ amount: "0", expires: "", until: "", note: "" }), {
    error: "Say how many dollars of credits.",
  });
});

test("in another language a plural and a blank follow that language", () => {
  const restore = setWords({
    "shell.footAll": { one: "{count} organização", other: "{count} organizações" },
    "shell.codesCount": { one: "{count} código", other: "{count} códigos" },
    "shell.termsLapse": "Os créditos vencem em {lapse}",
    "shell.showPanelTitled": "Mostrar o painel {title}",
    "shell.codeWaiting": "Aguardando",
  });
  try {
    assertEquals(say("footAll", { count: 1 }), "1 organização");
    assertEquals(say("footAll", { count: 3 }), "3 organizações");
    assertEquals(say("codesCount", { count: 2 }), "2 códigos");
    assertEquals(toggleLabel(false, "Espaço"), "Mostrar o painel espaço");
    const markup = draw();
    assertStringIncludes(markup, "Os créditos vencem em ");
    assertStringIncludes(markup, "Aguardando");
  } finally {
    restore();
  }
});
