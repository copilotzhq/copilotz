/**
 * The directory's front end's words are the app's to change, under the keys they had in the web
 * shell (`shell.<key>`): drawn with every word replaced by its key nothing English is left; drawn
 * with none given the English is as it was; and in another language a plural and a blank follow
 * that language.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "../../../testing/mod.ts";
import type { ViewContext } from "../../../runtime/mod.ts";
import { setWords } from "../../../hosts/web/words.ts";
import { englishLeft, pseudoWords } from "../../../hosts/web/tests/pseudo.ts";
import type { ConsoleOrg, GiftCode, Orgs } from "../directory/contract.ts";
import { codeStatus, dayOf, dollarsOf, newCodeOf, statusOf } from "../directory/views/web/codes.ts";
import { standingName } from "../directory/views/web/lists.ts";
import { orgView } from "../directory/views/web/org.tsx";
import { NewOrg, orgsPalette, OrgSwitcher } from "../directory/views/web/switcher.tsx";
import {
  consoleView,
  DeleteDialog,
  type Doing,
  MoveDialog,
  RenameDialog,
  Row,
  SuspendDialog,
} from "../directory/views/web/console.tsx";
import {
  NewCode,
  Revoke,
  Row as CodeRow,
  ShownOnce,
} from "../directory/views/web/console-codes.tsx";
import { say } from "../directory/views/web/words.ts";

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

function draw(): string {
  const parts: ReactNode[] = [];
  parts.push(
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
  return parts.map((node) => renderToStaticMarkup(<>{node}</>)).join("\n")
    .replace(/<style[\s\S]*?<\/style>/g, "");
}

/** What the plain functions say: palette groups, standing, codes, dates and money. */
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
    standingName({ role: null, staff: true }),
    (["waiting", "claimed", "revoked", "expired"] as const).map((s) => statusOf(s).label),
    newCodeOf({ amount: "nope", expires: "", until: "", note: "" }),
  ], (key, value) => ["key", "keywords", "icon", "tone"].includes(key) ? undefined : value);
}

test("with every word replaced, no English of the directory's front end is left", () => {
  const restore = setWords({ ...pseudoWords("shell"), ...pseudoWords("directory") });
  try {
    const markup = draw();
    assertEquals(englishLeft(shown(markup), "shell"), []);
    assertEquals(englishLeft(shown(markup), "directory"), []);
    for (
      const key of [
        "newOrg",
        "createOrg",
        "deleteForGood",
        "takeItBack",
        "notShownAgain",
      ]
    ) assert(markup.includes(`«shell.${key}»`), key);
    assertEquals(englishLeft(sayings(), "shell"), []);
    assertStringIncludes(sayings(), "«shell.orgSettings»");
    assertStringIncludes(sayings(), "«shell.allOrgsConsole»");
  } finally {
    restore();
  }
});

test("with none given, the directory's front end says what the shell always did", () => {
  const markup = draw();
  for (
    const phrase of [
      "Signed in as",
      "New organization",
      "Create organization",
      "Enter as staff",
      "New gift code",
      "Take it back",
      "Delete for good",
      "Credits lapse",
    ]
  ) assertStringIncludes(markup, phrase);
  for (const phrase of ["Organization settings", "About this organization", "All orgs (console)"]) {
    assertStringIncludes(sayings(), phrase);
  }
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
    "shell.codeWaiting": "Aguardando",
  });
  try {
    assertEquals(say("footAll", { count: 1 }), "1 organização");
    assertEquals(say("footAll", { count: 3 }), "3 organizações");
    assertEquals(say("codesCount", { count: 2 }), "2 códigos");
    const markup = draw();
    assertStringIncludes(markup, "Os créditos vencem em ");
    assertStringIncludes(markup, "Aguardando");
  } finally {
    restore();
  }
});
