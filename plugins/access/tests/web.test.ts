/**
 * Spaces on the web, their logic: a space's tabs as front ends add them (in
 * order, the one the address asks for, each one's address), the kinds of
 * member its invite surface adds, spaces in the sidebar's order and those
 * archived apart, where something may move to, who a member is, members in
 * a list's order and by kind, who can't be taken out, the roles agents
 * work in, and inviting in words that never say who has an account.
 */
import { assertEquals } from "@std/assert";
import type { Member } from "../spaces/contract.ts";
import { chosen, kindsOf, spacePath, tabsOf } from "../spaces/views/web/tabs.ts";
import type { Reached } from "../spaces/contract.ts";
import {
  addressesOf,
  AGENT_ROLES,
  apart,
  aRole,
  byKind,
  byMember,
  bySpace,
  destinations,
  EMAIL,
  invitedNote,
  lastManager,
  listed,
  peopleIn,
  roleName,
  spaceName,
  whoOf,
} from "../spaces/views/web/who.ts";
import { test } from "../../../testing/mod.ts";

test("a space's tabs: in their order, without those taken away, the one asked for or the first", () => {
  const tabs = tabsOf({
    settings: { title: "Settings", view: "space.settings", order: 90 },
    chats: { title: "Chats", view: "chats", order: 10 },
    notes: { title: "Notes", view: "notes", order: 50 },
    memories: null,
    broken: { title: "No view" },
    alpha: { title: "Alpha", view: "alpha", order: 50 },
  });
  assertEquals(tabs.map((t) => t.key), ["chats", "alpha", "notes", "settings"]);
  assertEquals(chosen(tabs, "notes")?.key, "notes");
  assertEquals(chosen(tabs, "gone")?.key, "chats");
  assertEquals(chosen(tabs, undefined)?.key, "chats");
  assertEquals(chosen([], "chats"), undefined);
  assertEquals(tabsOf(undefined), []);
  assertEquals(spacePath("a b"), "/space/a%20b");
  assertEquals(spacePath("s1", "computer"), "/space/s1?tab=computer");
});

test("who can be added: People first, then the kinds front ends add; Personal takes agents only", () => {
  const given = {
    bots: { title: "Bots", view: "bot.add", order: 30 },
    agents: { title: "Agents", view: "agent.add", order: 20, personal: true },
    gone: null,
    broken: { title: "No view" },
  };
  assertEquals(kindsOf(given, false), [
    { key: "people", title: "People" },
    { key: "agents", title: "Agents", view: "agent.add" },
    { key: "bots", title: "Bots", view: "bot.add" },
  ]);
  assertEquals(kindsOf(given, true), [{ key: "agents", title: "Agents", view: "agent.add" }]);
  assertEquals(kindsOf(undefined, false), [{ key: "people", title: "People" }]);
  assertEquals(kindsOf(undefined, true), []);
});

test("spaces as the sidebar lists them: Personal first, then by name", () => {
  const spaces = [
    { name: "launch", kind: "shared" },
    { name: "Personal", kind: "personal" },
    { name: "Design", kind: "shared" },
  ];
  assertEquals(bySpace(spaces).map((s) => s.name), ["Personal", "Design", "launch"]);
  assertEquals(spaceName({ name: "personal:ana", kind: "personal" }), "Personal");
  assertEquals(spaceName({ name: "Launch", kind: "shared" }), "Launch");
});

test("who a member is, members in a list's order, and the last manager", () => {
  assertEquals(whoOf("person:ana"), { kind: "person", id: "ana", name: "ana" });
  assertEquals(whoOf("agent:maya"), { kind: "agent", id: "maya", name: "maya" });
  assertEquals(whoOf("space:launch:eu"), { kind: "space", id: "launch:eu", name: "launch:eu" });
  assertEquals(whoOf("bob"), { kind: "person", id: "bob", name: "bob" });
  // A person by their name; a sign-in's id never shows as one.
  const names = { "google:1139": "Ana Lima" };
  assertEquals(whoOf("person:google:1139", names), {
    kind: "person",
    id: "google:1139",
    name: "Ana Lima",
  });
  assertEquals(whoOf("person:google:2240").name, "someone");
  assertEquals(
    spaceName({ name: "personal:x", kind: "personal", owner: "google:1139" }, "me", names),
    "Ana Lima's Personal",
  );
  const m = (member: string, role = "editor"): Member => ({
    _id: `s|${member}`,
    space: "s",
    member,
    role,
  });
  const members = [
    m("agent:north"),
    m("person:zoe"),
    m("space:sales", "viewer"),
    m("agent:maya"),
    m("person:ana", "manager"),
    m("person:bob"),
  ];
  assertEquals(byMember(members, "bob").map((x) => x.member), [
    "person:bob",
    "person:ana",
    "person:zoe",
    "agent:maya",
    "agent:north",
    "space:sales",
  ]);
  assertEquals(peopleIn(members).map((x) => x.member), ["person:zoe", "person:ana", "person:bob"]);
  assertEquals(lastManager(members, "person:ana"), true);
  assertEquals(lastManager(members, "person:bob"), false);
  assertEquals(lastManager([...members, m("person:zoe2", "manager")], "person:ana"), false);
  assertEquals([roleName("viewer"), roleName("manager"), roleName("commenter")], [
    "Viewer",
    "Manager",
    "Commenter",
  ]);
  // Agents work as editors (answering chats) or viewers (reading only), never managers.
  assertEquals(AGENT_ROLES.map((r) => r.value), ["editor", "viewer"]);
});

test("archived spaces apart, and where something may move: spaces in use you may write in", () => {
  const space = (name: string, can: Reached["can"], more: Partial<Reached> = {}): Reached => ({
    _id: name.toLowerCase(),
    name,
    kind: "shared",
    can,
    ...more,
  });
  const spaces = [
    space("Launch", ["read", "write", "manage"]),
    space("Old", ["read", "write"], { archived: "2026-10-01T00:00:00Z" }),
    space("personal:ana", ["read", "write", "manage"], { kind: "personal" }),
    space("Board", ["read"]),
    space("Design", ["read", "write"]),
  ];
  const { active, archived } = apart(spaces);
  assertEquals(active.map((s) => s.name), ["personal:ana", "Board", "Design", "Launch"]);
  assertEquals(archived.map((s) => s.name), ["Old"]);
  assertEquals(destinations(spaces, "launch").map((s) => s._id), ["personal:ana", "design"]);
  assertEquals(destinations(spaces).map((s) => s._id), ["personal:ana", "design", "launch"]);
});

test("members by kind: people, agents, and spaces drawing on it", () => {
  const m = (member: string): Member => ({
    _id: `s|${member}`,
    space: "s",
    member,
    role: "editor",
  });
  const kinds = byKind([m("person:ana"), m("agent:maya"), m("space:sales"), m("agent:north")]);
  assertEquals(kinds.people.map((x) => x.member), ["person:ana"]);
  assertEquals(kinds.agents.map((x) => x.member), ["agent:maya", "agent:north"]);
  assertEquals(kinds.spaces.map((x) => x.member), ["space:sales"]);
});

test("inviting in words: roles with their article, several addresses, and never who has an account", () => {
  assertEquals([aRole("editor"), aRole("viewer"), aRole("manager"), aRole("owner")], [
    "an editor",
    "a viewer",
    "a manager",
    "an owner",
  ]);
  assertEquals(addressesOf(" bob@example.com, cy@example.com;dee@example.com  "), [
    "bob@example.com",
    "cy@example.com",
    "dee@example.com",
  ]);
  assertEquals(addressesOf("  "), []);
  assertEquals(["bob@example.com", "bob@example", "bob", "a@b.c"].map((e) => EMAIL.test(e)), [
    true,
    false,
    false,
    true,
  ]);
  assertEquals([listed(["a"]), listed(["a", "b"]), listed(["a", "b", "c"])], [
    "a",
    "a and b",
    "a, b and c",
  ]);
  assertEquals(invitedNote(["x@y.com"]), "Invited x@y.com. They'll join once they accept.");
  assertEquals(
    invitedNote(["x@y.com", "z@y.com"]),
    "Invited x@y.com and z@y.com. Each joins once they accept.",
  );
});
