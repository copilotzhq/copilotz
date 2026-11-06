/**
 * Spaces' words are the app's to change: drawn with every word replaced by its key nothing
 * English is left; drawn with none given the English is as it was; and in another language a
 * plural and a blank follow that language.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "../../../testing/mod.ts";
import type { ViewContext } from "../../../runtime/mod.ts";
import { merge } from "../../../runtime/registry.ts";
import { setWords } from "../../../hosts/web/words.ts";
import { englishLeft, pseudoWords } from "../../../hosts/web/tests/pseudo.ts";
import type { Invitation, Member, Reached, Request } from "../spaces/contract.ts";
import { spacesWeb } from "../spaces/web.tsx";
import { Agents, type Roster } from "../spaces/views/web/agents.tsx";
import { SpaceHeader } from "../spaces/views/web/header.tsx";
import { InvitationCard } from "../spaces/views/web/invitation.tsx";
import { InviteForm } from "../spaces/views/web/invite.tsx";
import { NewSpace } from "../spaces/views/web/new-space.tsx";
import { Pending } from "../spaces/views/web/pending.tsx";
import { SpaceTree } from "../spaces/views/web/tree.tsx";
import { invitationsView } from "../spaces/views/web/invitations.tsx";
import { invitingView } from "../spaces/views/web/inviting.tsx";
import { membersView } from "../spaces/views/web/members.tsx";
import { notHereView } from "../spaces/views/web/not-here.tsx";
import { orgAboutView } from "../spaces/views/web/org-about.tsx";
import { orgMembersView } from "../spaces/views/web/org-members.tsx";
import { spacesPaletteView } from "../spaces/views/web/palette.tsx";
import { spacePanelView } from "../spaces/views/web/panel.tsx";
import { spacePickView } from "../spaces/views/web/pick.tsx";
import { settingsView } from "../spaces/views/web/settings.tsx";
import { spaceView } from "../spaces/views/web/space.tsx";
import { archiveStep, leaveStep, newSpaceStep, renameStep } from "../spaces/views/web/steps.ts";
import { aRole, invitedNote, listed, roleName, spaceName } from "../spaces/views/web/who.ts";
import { say } from "../spaces/views/web/words.ts";

const noCall = () => Promise.resolve({} as never);

/** A View's context over fixed reads: queries by `<collection>.<query>`, finds by collection. */
const ctxOf = (
  reads: Record<string, unknown>,
  hints: Record<string, unknown> = {},
): ViewContext<ReactNode> => ({
  db: {
    collection: (name: string) => ({
      query: (query: string) => ({ status: "ready", value: reads[`${name}.${query}`] }),
      find: () => ({ status: "ready", value: (reads[name] ?? []) as never }),
    }),
  } as unknown as ViewContext<ReactNode>["db"],
  resources: merge([spacesWeb], { elsewhere: true }).resources,
  name: "test",
  viewer: { name: "ana" },
  hints,
  show: () => null,
  call: noCall,
  emit: () => Promise.resolve(),
});

const at = "2026-10-30T09:00:00.000Z";
const launch = {
  _id: "launch",
  name: "Launch",
  kind: "shared",
  at,
  can: ["read", "write", "manage"],
} as Reached;
const home = {
  _id: "home",
  name: "personal:ana",
  kind: "personal",
  at,
  can: ["read", "write", "manage"],
} as Reached;
const old = { ...launch, _id: "old", name: "Old", archived: at } as Reached;
const readOnly = { ...launch, _id: "board", name: "Board", can: ["read"] } as Reached;
const member = (key: string, role: string, space = "launch") =>
  ({ _id: `${space}|${key}`, space, member: key, role }) as Member;
const members = [
  member("person:ana", "manager"),
  member("person:bob", "editor"),
  member("agent:maya", "editor"),
  member("agent:north", "viewer"),
  member("space:sales", "viewer"),
];
const invitation = (email: string, role: string, by = "person:bob"): Invitation =>
  ({
    _id: email,
    space: "launch",
    name: "Launch",
    email,
    role,
    by,
    at,
  }) as Invitation;
const invitations = [
  invitation("cy@example.com", "viewer"),
  invitation("dee@example.com", "editor", "person:ana"),
];
const requests = [
  {
    _id: "r1",
    space: "launch",
    member: "person:cy",
    by: "person:bob",
    reason: "Needs the plan",
    at,
  },
  { _id: "r2", space: "launch", member: "person:dee", at },
] as Request[];
const roster: Roster = {
  here: ["maya"],
  default: ["maya"],
  agents: {
    maya: { name: "Maya", icon: "🦊", description: "Writes the plans" },
    north: { name: "North", in: "home" },
  },
};

const reads = {
  "space.reached": [home, launch, old, readOnly],
  "invitation.mine": invitations,
  "thread.agents": roster,
  member: members,
  request: requests,
  invitation: invitations,
};

/** Only what a person reads or hears: text, and the attributes read aloud or shown on hover. */
const shown = (markup: string) =>
  markup.replace(/<([a-z0-9]+)((?:\s+[\w:-]+(?:="[^"]*")?)*)\s*\/?>/g, (_, tag, attributes) => {
    const kept = [
      ...attributes.matchAll(/\s((?:aria-label|aria-valuetext|title|placeholder|alt)="[^"]*")/g),
    ];
    return `<${tag}${kept.map((k) => ` ${k[1]}`).join("")}>`;
  });

/** Every View of the front end, drawn in the states people meet. */
function draw(): string {
  const parts: ReactNode[] = [];
  const view = (node: ReactNode) => parts.push(node);
  const spaces = (hints: Record<string, unknown> = {}, more: Record<string, unknown> = {}) =>
    ctxOf({ ...reads, ...more }, hints);
  // A space's page, in its states.
  view(spaceView({ _id: "launch" }, spaces()));
  view(spaceView({ _id: "old" }, spaces({}, { member: [member("person:ana", "manager", "old")] })));
  view(spaceView({ _id: "nope" }, spaces()));
  view(spaceView({ _id: "home" }, spaces()));
  view(
    spaceView(
      { _id: "launch" },
      spaces({}, { "space.reached": [] }),
    ),
  );
  view(
    <SpaceHeader space={launch} members={members} manage me="ana" call={noCall}>
      {null}
    </SpaceHeader>,
  );
  view(
    <SpaceHeader
      space={{ ...launch, archived: at }}
      members={members.slice(0, 2)}
      manage={false}
      me="bob"
      call={noCall}
    >
      {null}
    </SpaceHeader>,
  );
  view(
    <SpaceHeader
      space={home}
      members={[member("person:ana", "manager", "home")]}
      manage
      me="ana"
      call={noCall}
    >
      {null}
    </SpaceHeader>,
  );
  // Members, settings, inviting, the panel.
  view(membersView({ _id: "launch" }, spaces()));
  view(
    membersView({ _id: "home" }, spaces({}, { member: [member("person:ana", "manager", "home")] })),
  );
  view(membersView({ _id: "launch" }, spaces({}, { "space.reached": undefined })));
  view(settingsView({ _id: "launch" }, spaces()));
  view(settingsView({ _id: "home" }, spaces()));
  view(settingsView({ _id: "board" }, spaces()));
  view(settingsView({ _id: "old" }, spaces()));
  view(invitingView({ _id: "launch" }, spaces()));
  view(invitingView({ _id: "board" }, spaces()));
  view(invitingView({ _id: "home" }, spaces()));
  view(spacePanelView({ _id: "launch" }, spaces()));
  view(spacePanelView({ _id: "home" }, spaces()));
  view(spacePanelView({ _id: "nope" }, spaces()));
  // Agents, invitations, requests.
  view(
    <Agents
      space={launch}
      spaces={[home, launch]}
      members={members.filter((m) => m.member.startsWith("agent:"))}
      roster={roster}
      manage
      adds
      onAdd={() => {}}
      call={noCall}
    />,
  );
  view(
    <Agents
      space={home}
      spaces={[home]}
      members={[]}
      manage
      adds
      onAdd={() => {}}
      call={noCall}
    />,
  );
  view(
    <Agents
      space={launch}
      spaces={[launch]}
      members={[member("agent:maya", "viewer")]}
      roster={roster}
      manage={false}
      adds={false}
      onAdd={() => {}}
      call={noCall}
    />,
  );
  view(
    <ul>
      <InvitationCard invitation={invitations[0]} call={noCall} />
      <InvitationCard invitation={invitations[1]} call={noCall} compact />
    </ul>,
  );
  view(invitationsView({}, ctxOf(reads, { path: "/chat" })));
  view(
    invitationsView(
      {},
      ctxOf({
        ...reads,
        "invitation.mine": [
          ...invitations,
          invitation("x@y.com", "viewer"),
          invitation("z@y.com", "viewer"),
        ],
      }, { path: "/chat" }),
    ),
  );
  view(<Pending invitations={invitations} me="ana" call={noCall} />);
  view(<InviteForm space={launch} call={noCall} />);
  view(<NewSpace create={() => Promise.resolve()} />);
  view(
    <SpaceTree
      spaces={[home, launch, readOnly]}
      archived={[old]}
      joined={members}
      here="launch"
      under={[]}
      viewer="ana"
      names={{}}
      create={() => Promise.resolve()}
    />,
  );
  // A message that named agents who don't answer here.
  const named = (hints: Record<string, unknown>, more: Record<string, unknown> = {}) =>
    notHereView(
      {},
      ctxOf({ ...reads, ...more }, {
        in: "launch",
        names: ["maya", "north"],
        message: "",
        resend: () => Promise.resolve(),
        dismiss: () => {},
        ...hints,
      }),
    );
  view(
    named({ in: "launch", names: ["north"] }, {
      "thread.agents": { here: [], default: [], agents: roster.agents },
    }),
  );
  view(
    named({ names: ["maya", "north"] }, {
      "thread.agents": { here: [], default: [], agents: roster.agents },
    }),
  );
  view(
    named({ in: "board", names: ["north"] }, {
      "thread.agents": { here: [], default: [], agents: roster.agents },
      member: [],
    }),
  );
  view(named({ in: "launch", names: ["zed"] }));
  // The org's pages (their data loads after the page starts: what is drawn is the page waiting).
  const org = { id: "acme", name: "Acme", kind: "team" };
  for (const role of ["owner", "member"]) {
    view(orgAboutView({}, ctxOf(reads, { org, role })));
  }
  view(
    orgAboutView(
      {},
      ctxOf(reads, { org: { id: "p", name: "ana", kind: "personal" }, role: "owner" }),
    ),
  );
  view(orgAboutView({}, ctxOf(reads, { org, role: null, staff: true })));
  view(orgMembersView({}, ctxOf(reads, { org, role: "owner" })));
  return parts.map((node) => renderToStaticMarkup(<>{node}</>)).join("\n").replace(
    /<style[\s\S]*?<\/style>/g,
    "",
  );
}

/** What the plain functions say: names, roles, lists, notes, the palette and its steps. */
function sayings(): string {
  const ctx = ctxOf(reads, { in: "launch", search: "a" });
  const groups = spacesPaletteView(
    null,
    ctxOf({ ...reads, resources: undefined }, { in: "launch", search: "a" }),
  );
  const groupsIdle = spacesPaletteView(null, ctxOf(reads, { in: "old" }));
  const picks = spacePickView(null, ctxOf(reads, { from: "launch", search: "Plans" }));
  const picksIdle = spacePickView(null, ctxOf(reads, { from: "launch" }));
  void ctx;
  const step = (s: ReturnType<typeof newSpaceStep>, search = "Plans") => ({
    ...s,
    items: s.items?.(search),
  });
  return JSON.stringify([
    groups,
    groupsIdle,
    picks,
    picksIdle,
    step(newSpaceStep(noCall)),
    step(newSpaceStep(noCall), "x".repeat(70)),
    step(renameStep(launch, noCall), "Plans"),
    step(archiveStep(launch, noCall)),
    step(leaveStep(launch, noCall)),
    spaceName(home),
    spaceName(home, "ana"),
    spaceName({ name: "personal:bob", kind: "personal", owner: "bob" }, "ana", {
      "person:bob": "Bob",
    }),
    roleName("manager"),
    aRole("editor"),
    aRole("owner"),
    listed(["Ana"]),
    listed(["Ana", "Bob"]),
    listed(["Ana", "Bob", "Cy"]),
    invitedNote(["a@b.com"]),
    invitedNote(["a@b.com", "c@d.com"]),
  ], (key, value) => ["key", "keywords", "icon", "tone"].includes(key) ? undefined : value);
}

test("with every word replaced, no English of spaces is left", () => {
  const restore = setWords(pseudoWords("spaces"));
  try {
    const markup = draw();
    assertEquals(englishLeft(shown(markup), "spaces"), []);
    for (
      const key of [
        "agents",
        "addAgent",
        "workBoth",
        "invitePeople",
        "waitingToJoin",
        "answersNew",
        "notInSpace",
        "isArchived",
        "managersAdd",
        "partsOf",
        "onlyReadsTitle",
        "membersPersonal",
      ]
    ) {
      assert(
        markup.includes(`«spaces.${key}»`) ||
          markup.includes(`«spaces.${key}»`.replace("«", "&#x27;")),
        key,
      );
    }
    assertEquals(englishLeft(sayings(), "spaces"), []);
    assertStringIncludes(sayings(), "«spaces.newSpace»");
  } finally {
    restore();
  }
});

test("with none given, spaces say what they always did", () => {
  const markup = draw();
  for (
    const phrase of [
      "Just you",
      "Shared",
      "Archived",
      "Invite people",
      "Waiting to join",
      "Answers new chats",
      "Add an agent",
      "Let in",
      "Turn down",
      "Take back",
      "Settings",
      "2 people and 2 agents work here.",
      "Invited by you",
      "Make them editors and send",
      "Their email",
    ]
  ) assertStringIncludes(markup, phrase);
  assertEquals(spaceName(home), "Personal");
  assertEquals(aRole("editor"), "an editor");
  assertEquals(listed(["a", "b", "c"]), "a, b and c");
  assertEquals(
    invitedNote(["x@y.com", "z@y.com"]),
    "Invited x@y.com and z@y.com. Each joins once they accept.",
  );
  assertStringIncludes(sayings(), "Invite someone to Launch…");
});

test("in another language a plural and a blank follow that language", () => {
  const restore = setWords({
    "spaces.peopleCount": { one: "{count} pessoa", other: "{count} pessoas" },
    "spaces.agentsCount": { one: "{count} agente", other: "{count} agentes" },
    "spaces.workBoth": "{people} e {agents} trabalham aqui.",
    "spaces.theirPersonal": "Pessoal de {name}",
    "spaces.listPair": "{first} e {second}",
  });
  try {
    const markup = draw();
    assertStringIncludes(markup, "2 pessoas e 2 agentes trabalham aqui.");
    assertEquals(
      spaceName({ name: "x", kind: "personal", owner: "bob" }, "ana", { bob: "Bob" }),
      "Pessoal de Bob",
    );
    assertEquals(listed(["Ana", "Bob"]), "Ana e Bob");
    assertEquals(say("peopleCount", { count: 1 }), "1 pessoa");
  } finally {
    restore();
  }
});
